import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';

import * as annonces from '../scripts/lib/annonces.js';
import { createNegotiationServer } from '../scripts/negotiate-server.js';
import { request, post } from './helpers/http.js';

// Opt-in local PostgreSQL coverage: no environment URL or production table is
// used. The temporary table shadows public.annonces for this connection only.
const localDatabase = { skip: process.env.PS5_TEST_LOCAL_DB !== '1' };
const ad = (id) => `https://www.leboncoin.fr/ad/consoles/${id}`;
const CONTACT_DATE = '2026-09-26T10:00:00.000Z';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const dbConfig = { host: '127.0.0.1', port: 54322, user: 'postgres', password: 'postgres', database: 'postgres', connectionTimeoutMillis: 2000 };

async function withAnnonces(run) {
  const client = new Client(dbConfig);
  await client.connect();
  try {
    await client.query(`create temporary table annonces (
      url_annonce text primary key, titre text, vendeur text, prix_eur numeric,
      ville text, classification text, image_url text, lecteur_disque boolean,
      manettes_incluses integer, disqualifiee boolean not null default false,
      contacte_le timestamptz, contact_erreur_code text, contact_erreur_le timestamptz,
      contact_reservation_token text, contact_reservation_le timestamptz,
      list_id bigint, contact_direct_le timestamptz, decision_manuelle boolean not null default false
    )`);
    const seed = async (rows) => {
      for (const [id, vendeur, classification = 'saint_graal', prix = 300, contacted = null, disqualifiee = false] of rows) {
        await client.query(`insert into annonces (url_annonce, vendeur, titre, classification, prix_eur, contacte_le, disqualifiee,
          ville, image_url, lecteur_disque, manettes_incluses) values ($1, $2, 'PS5', $3, $4, $5, $6, 'Paris', 'photo', true, 2)`,
        [ad(id), vendeur, classification, prix, contacted, disqualifiee]);
      }
    };
    const server = createNegotiationServer({
      extensionOrigin: EXTENSION_ORIGIN,
      chargerShortlist: (options) => annonces.chargerShortlist(client, options),
      marquerContactee: (url) => annonces.marquerContactee(client, url, new Date(CONTACT_DATE)),
      reserverContact: (url) => annonces.reserverContact(client, url, new Date(CONTACT_DATE)),
      finaliserContact: (url, token, resultat) => annonces.finaliserContact(client, url, token, resultat, new Date(CONTACT_DATE)),
      libererContact: (url, token) => annonces.libererContact(client, url, token),
      marquerErreurContact: (url, code, token) => annonces.marquerErreurContact(client, url, code, new Date(CONTACT_DATE), token),
      logger: { error() {} },
    });
    await run({ client, seed, server });
  } finally {
    await client.end();
  }
}

test('SQL HTTP réserve, libère, finalise et clôt une erreur avec le jeton exact', localDatabase, async () => {
  await withAnnonces(async ({ client, seed, server }) => {
    await seed([['1', 'Alice'], ['2', 'alice'], ['3', 'Bob'], ['4', 'Charlie']]);
    const send = (path, body) => request(server, `/api/annonces/${path}`, {
      method: 'POST', body, origin: EXTENSION_ORIGIN,
    });
    const firstResponse = await send('contact-reserver', { url_annonce: ad('1') });
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.reservee, true);
    assert.match(first.reservation_token, /^[0-9a-f-]{36}$/i);
    assert.equal(first.reservation_le, CONTACT_DATE);
    assert.deepEqual(await (await send('contact-reserver', { url_annonce: ad('2') })).json(), {
      reservee: false, raison: 'reservation_existante',
    });
    assert.deepEqual(await (await send('contact-liberer', { url_annonce: ad('1'), reservation_token: randomUUID() })).json(), { liberee: false });
    assert.deepEqual(await (await send('contact-liberer', { url_annonce: ad('1'), reservation_token: first.reservation_token })).json(), { liberee: true });

    const second = await (await send('contact-reserver', { url_annonce: ad('2') })).json();
    const finalization = await send('contact-finaliser', {
      url_annonce: ad('2'), reservation_token: second.reservation_token, resultat: 'confirme',
    });
    assert.equal(finalization.status, 200);
    assert.deepEqual(await finalization.json(), { contacte_le: CONTACT_DATE });
    const contacts = await client.query('select url_annonce, contacte_le from annonces where url_annonce in ($1, $2) order by url_annonce', [ad('1'), ad('2')]);
    assert.deepEqual(contacts.rows.map((row) => [row.url_annonce, row.contacte_le?.toISOString()]), [
      [ad('1'), CONTACT_DATE], [ad('2'), CONTACT_DATE],
    ]);

    const third = await (await send('contact-reserver', { url_annonce: ad('3') })).json();
    const terminal = await send('contact-erreur', {
      url_annonce: ad('3'), code: 'reply_indisponible', reservation_token: third.reservation_token,
    });
    assert.equal(terminal.status, 200);
    assert.deepEqual(await terminal.json(), { contact_erreur_code: 'reply_indisponible', contact_erreur_le: CONTACT_DATE });
    const fourth = await (await send('contact-reserver', { url_annonce: ad('4') })).json();
    const uncertain = await send('contact-finaliser', {
      url_annonce: ad('4'), reservation_token: fourth.reservation_token, resultat: 'incertain',
    });
    assert.equal(uncertain.status, 200);
    assert.deepEqual(await uncertain.json(), {
      contacte_le: CONTACT_DATE, contact_erreur_code: 'envoi_incertain', contact_erreur_le: CONTACT_DATE,
    });
  });
});

// PostgreSQL temporary tables are private to one session. This isolated
// schema gives two real connections the same table for the lock race.
async function withSharedAnnonces(run) {
  const schema = `ps5_reservation_test_${randomUUID().replaceAll('-', '')}`;
  const clientA = new Client(dbConfig);
  const clientB = new Client(dbConfig);
  let clientBConnected = false;
  await clientA.connect();
  try {
    await clientA.query(`create schema "${schema}"`);
    await clientA.query(`create table "${schema}".annonces (
      url_annonce text primary key, vendeur text, contacte_le timestamptz,
      contact_erreur_code text, contact_erreur_le timestamptz,
      contact_reservation_token text, contact_reservation_le timestamptz,
      list_id bigint, contact_direct_le timestamptz
    )`);
    await clientA.query(`set search_path to "${schema}"`);
    await clientB.connect();
    clientBConnected = true;
    await clientB.query(`set search_path to "${schema}"`);
    await run({ clientA, clientB });
  } finally {
    try {
      if (clientBConnected) await clientB.end();
    } finally {
      try {
        await clientA.query(`drop schema if exists "${schema}" cascade`);
      } finally {
        await clientA.end();
      }
    }
  }
}

test('SQL shortlist dédoublonne les vendeurs, exclut tout vendeur contacté et trie avant de limiter', localDatabase, async () => {
  await withAnnonces(async ({ seed, server }) => {
    await seed([
      ['11', ' Alice ', 'interessant', 100], ['12', 'alice', 'saint_graal', 320],
      ['13', 'ALICE', 'saint_graal', 330], ['14', 'Alice', 'saint_graal', 320],
      ['20', 'Bob', 'saint_graal', 10], ['21', ' bob ', 'disqualifiee', 1, CONTACT_DATE, true],
      ['31', 'Charles', 'saint_graal', null], ['32', 'charles', 'saint_graal', 340],
      ['40', null, 'saint_graal', 200], ['41', null, 'saint_graal', 210],
      ['42', '', 'saint_graal', 220], ['43', ' \t\n ', 'saint_graal', 230],
      ['44', '', 'saint_graal', 1, CONTACT_DATE],
      ['50', 'Deborah', 'interessant', 50], ['51', 'Eric', 'a_verifier', 1],
      ['52', 'Fred', 'saint_graal', 1, null, true], ['53', 'George', null, 1],
    ]);
    const response = await request(server, '/api/annonces/shortlist');
    assert.equal(response.status, 200);
    const { annonces: rows } = await response.json();
    assert.deepEqual(rows.map((row) => row.url_annonce), ['40', '41', '42', '43', '12', '32', '50'].map(ad));
    assert.deepEqual(rows[0], { url_annonce: ad('40'), titre: 'PS5', vendeur: null, prix_eur: '200',
      ville: 'Paris', classification: 'saint_graal', image_url: 'photo', lecteur_disque: true, manettes_incluses: 2 });
    const limited = await request(server, '/api/annonces/shortlist?limite=2');
    assert.deepEqual((await limited.json()).annonces.map((row) => row.url_annonce), [ad('40'), ad('41')]);
  });
});

test('SQL erreur de contact exclut seulement l’annonce exacte de la shortlist', localDatabase, async () => {
  await withAnnonces(async ({ client, seed, server }) => {
    await seed([['1', 'Alice'], ['2', 'Bob']]);
    const response = await post(server, '/api/annonces/contact-erreur', {
      url_annonce: ad('1'), code: 'formulaire_absent',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      contact_erreur_code: 'formulaire_absent', contact_erreur_le: CONTACT_DATE,
    });
    const shortlist = await request(server, '/api/annonces/shortlist');
    assert.deepEqual((await shortlist.json()).annonces.map((row) => row.url_annonce), [ad('2')]);
    const first = await client.query('select contacte_le, contact_erreur_code from annonces where url_annonce = $1', [ad('1')]);
    assert.equal(first.rows[0].contacte_le, null);
    assert.equal(first.rows[0].contact_erreur_code, 'formulaire_absent');
  });
});

test('SQL marquage contacte toutes les annonces du vendeur et exclut ses futures annonces', localDatabase, async () => {
  await withAnnonces(async ({ client, seed, server }) => {
    await seed([['1', "O'Neil"], ['2', " o'NEIL ", 'a_verifier'], ['3', 'Autre'], ['4', null]]);
    const response = await post(server, '/api/annonces/contactee', { url_annonce: ad('1') });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { contacte_le: CONTACT_DATE });
    const marked = await client.query('select url_annonce from annonces where contacte_le is not null order by url_annonce');
    assert.deepEqual(marked.rows.map((row) => row.url_annonce), [ad('1'), ad('2')]);
    await seed([['5', "O'Neil"]]);
    const shortlist = await request(server, '/api/annonces/shortlist');
    assert.deepEqual((await shortlist.json()).annonces.map((row) => row.url_annonce), [ad('3'), ad('4')]);
    const retried = await annonces.marquerContactee(client, ad('1'), new Date('2026-09-27T10:00:00.000Z'));
    assert.equal(retried.contacte_le, CONTACT_DATE);
    const dates = await client.query('select contacte_le from annonces where url_annonce in ($1, $2, $3)', [ad('1'), ad('2'), ad('5')]);
    assert.deepEqual(dates.rows.map((row) => row.contacte_le.toISOString()), [CONTACT_DATE, CONTACT_DATE, CONTACT_DATE]);
  });
});

test('SQL marquage garde les vendeurs absents par annonce et rejette une URL inconnue', localDatabase, async () => {
  await withAnnonces(async ({ client, seed, server }) => {
    await seed([['1', null], ['2', null], ['3', ''], ['4', ' \t ']]);
    for (const id of ['1', '3']) {
      const response = await post(server, '/api/annonces/contactee', { url_annonce: ad(id) });
      assert.equal(response.status, 200);
    }
    const shortlist = await request(server, '/api/annonces/shortlist');
    assert.deepEqual((await shortlist.json()).annonces.map((row) => row.url_annonce), [ad('2'), ad('4')]);
    await assert.rejects(annonces.marquerContactee(client, ad('999')), /Annonce inconnue/);
    const untouched = await client.query('select count(*)::int as n from annonces where contacte_le is null');
    assert.equal(untouched.rows[0].n, 2);
  });
});

test('SQL shortlist et marquage lient les limites, URLs et dates sans interpolation', localDatabase, async () => {
  await withAnnonces(async ({ client, seed, server }) => {
    await seed([['1', 'Alice']]);
    const response = await request(server, '/api/annonces/shortlist');
    assert.equal(response.status, 200);
    const queries = [];
    const trackingClient = { query(sql, params) { queries.push({ sql, params }); return client.query(sql, params); } };
    await annonces.chargerShortlist(trackingClient, { limite: 2 });
    const maliciousUrl = "https://www.leboncoin.fr/ad/consoles/1'; update annonces set contacte_le = now(); --";
    await assert.rejects(annonces.marquerContactee(trackingClient, maliciousUrl, new Date(CONTACT_DATE)), /Annonce inconnue/);
    assert.deepEqual(queries[0].params, [2]);
    assert.deepEqual(queries[1].params, [maliciousUrl, new Date(CONTACT_DATE)]);
    assert.doesNotMatch(queries[1].sql, /https:|2026-09-26/);
    const untouched = await client.query('select contacte_le from annonces');
    assert.equal(untouched.rows[0].contacte_le, null);
  });
});

test('SQL réserve un seul essai par vendeur puis finalise un envoi incertain', localDatabase, async () => {
  await withAnnonces(async ({ client, seed }) => {
    await seed([['1', ' Alice '], ['2', 'ALICE'], ['3', 'Bob']]);
    const first = await annonces.reserverContact(client, ad('1'), new Date(CONTACT_DATE));
    assert.equal(first.reservee, true);
    assert.match(first.reservation_token, /^[0-9a-f-]{36}$/i);
    assert.equal(first.reservation_le, CONTACT_DATE);
    assert.equal((await annonces.reserverContact(client, ad('1'), new Date(CONTACT_DATE))).reservee, false);
    assert.equal((await annonces.reserverContact(client, ad('2'), new Date(CONTACT_DATE))).reservee, false);
    assert.equal((await annonces.reserverContact(client, ad('999'), new Date(CONTACT_DATE))).reservee, false);

    const finalized = await annonces.finaliserContact(client, ad('1'), first.reservation_token, 'incertain', new Date(CONTACT_DATE));
    assert.deepEqual(finalized, {
      contacte_le: CONTACT_DATE, contact_erreur_code: 'envoi_incertain', contact_erreur_le: CONTACT_DATE,
    });
    assert.equal((await annonces.reserverContact(client, ad('2'), new Date(CONTACT_DATE))).reservee, false);
    const rows = await client.query(`select url_annonce, contacte_le, contact_erreur_code, contact_reservation_token
      from annonces order by url_annonce`);
    assert.deepEqual(rows.rows.map((row) => [row.url_annonce, row.contacte_le?.toISOString(), row.contact_erreur_code, row.contact_reservation_token]), [
      [ad('1'), CONTACT_DATE, 'envoi_incertain', null],
      [ad('2'), CONTACT_DATE, null, null],
      [ad('3'), undefined, null, null],
    ]);
  });
});

test('SQL les variantes vendeur avec tabulations et retours à la ligne partagent la réservation', localDatabase, async () => {
  await withAnnonces(async ({ client, seed }) => {
    await seed([['1', 'Alice'], ['2', '\tALICE\n'], ['3', ' \nAlice\t '], ['4', 'Bob']]);
    const first = await annonces.reserverContact(client, ad('1'), new Date(CONTACT_DATE));
    assert.equal(first.reservee, true);
    for (const id of ['2', '3']) {
      assert.deepEqual(await annonces.reserverContact(client, ad(id)), {
        reservee: false, raison: 'reservation_existante',
      });
    }
  });
});

test('SQL la finalisation propage le contact aux variantes vendeur avec tabulations et retours à la ligne', localDatabase, async () => {
  await withAnnonces(async ({ client, seed }) => {
    await seed([['1', '\tALICE\n'], ['2', 'Alice'], ['3', ' \nAlice\t '], ['4', 'Bob']]);
    const first = await annonces.reserverContact(client, ad('1'), new Date(CONTACT_DATE));
    await annonces.finaliserContact(client, ad('1'), first.reservation_token, 'confirme', new Date(CONTACT_DATE));
    const rows = await client.query('select url_annonce, contacte_le from annonces order by url_annonce');
    assert.deepEqual(rows.rows.map((row) => [row.url_annonce, row.contacte_le?.toISOString() ?? null]), [
      [ad('1'), CONTACT_DATE], [ad('2'), CONTACT_DATE], [ad('3'), CONTACT_DATE], [ad('4'), null],
    ]);
    await seed([['5', '\n alice\t']]);
    assert.deepEqual(await annonces.reserverContact(client, ad('5')), { reservee: false, raison: 'vendeur_contacte' });
  });
});

test('SQL deux vendeurs composés seulement d’espaces restent réservés par URL', localDatabase, async () => {
  await withAnnonces(async ({ client, seed }) => {
    await seed([['1', ' \t\n '], ['2', '\t\n'], ['3', '\n\t ']]);
    const first = await annonces.reserverContact(client, ad('1'), new Date(CONTACT_DATE));
    const second = await annonces.reserverContact(client, ad('2'), new Date(CONTACT_DATE));
    assert.equal(first.reservee, true);
    assert.equal(second.reservee, true);
    assert.notEqual(second.reservation_token, first.reservation_token);
    await annonces.finaliserContact(client, ad('1'), first.reservation_token, 'confirme', new Date(CONTACT_DATE));
    const rows = await client.query('select url_annonce, contacte_le, contact_reservation_token from annonces order by url_annonce');
    assert.deepEqual(rows.rows.map((row) => [row.url_annonce, row.contacte_le?.toISOString() ?? null, row.contact_reservation_token]), [
      [ad('1'), CONTACT_DATE, null], [ad('2'), null, second.reservation_token], [ad('3'), null, null],
    ]);
    assert.equal((await annonces.reserverContact(client, ad('3'), new Date(CONTACT_DATE))).reservee, true);
  });
});

test('SQL les variantes vendeur avec tabulations partagent le verrou de réservation concurrent', localDatabase, async () => {
  await withSharedAnnonces(async ({ clientA, clientB }) => {
    await clientA.query('insert into annonces (url_annonce, vendeur) values ($1, $3), ($2, $4)',
      [ad('1'), ad('2'), 'Alice', '\tALICE\n']);
    const reservations = await Promise.all([
      annonces.reserverContact(clientA, ad('1'), new Date(CONTACT_DATE)),
      annonces.reserverContact(clientB, ad('2'), new Date(CONTACT_DATE)),
    ]);
    assert.equal(reservations.filter((result) => result.reservee).length, 1);
  });
});

test('SQL refuse les annonces déjà contactées et les erreurs terminales exactes', localDatabase, async () => {
  await withAnnonces(async ({ client, seed }) => {
    await seed([['1', 'Alice', 'saint_graal', 300, CONTACT_DATE], ['2', 'alice'], ['3', 'Bob']]);
    await annonces.marquerErreurContact(client, ad('3'), 'formulaire_absent', new Date(CONTACT_DATE));
    assert.equal((await annonces.reserverContact(client, ad('2'))).reservee, false);
    assert.equal((await annonces.reserverContact(client, ad('3'))).reservee, false);
  });
});

test('SQL un mauvais jeton ne finalise, ne libère ni ne clôt une autre tentative', localDatabase, async () => {
  await withAnnonces(async ({ client, seed }) => {
    await seed([['1', 'Alice']]);
    const first = await annonces.reserverContact(client, ad('1'), new Date(CONTACT_DATE));
    const wrongToken = randomUUID();
    assert.deepEqual(await annonces.libererContact(client, ad('1'), wrongToken), { liberee: false });
    await assert.rejects(annonces.finaliserContact(client, ad('1'), wrongToken, 'confirme', new Date(CONTACT_DATE)));
    await assert.rejects(annonces.marquerErreurContact(client, ad('1'), 'formulaire_absent', new Date(CONTACT_DATE), wrongToken));
    const stillReserved = await client.query(`select contact_reservation_token, contacte_le, contact_erreur_code
      from annonces where url_annonce = $1`, [ad('1')]);
    assert.deepEqual(stillReserved.rows[0], { contact_reservation_token: first.reservation_token, contacte_le: null, contact_erreur_code: null });
    assert.deepEqual(await annonces.libererContact(client, ad('1'), first.reservation_token), { liberee: true });
    const second = await annonces.reserverContact(client, ad('1'), new Date(CONTACT_DATE));
    assert.equal(second.reservee, true);
    assert.notEqual(second.reservation_token, first.reservation_token);
    await annonces.marquerErreurContact(client, ad('1'), 'reply_indisponible', new Date(CONTACT_DATE), second.reservation_token);
    const ended = await client.query(`select contact_reservation_token, contact_reservation_le, contact_erreur_code
      from annonces where url_annonce = $1`, [ad('1')]);
    assert.deepEqual(ended.rows[0], { contact_reservation_token: null, contact_reservation_le: null, contact_erreur_code: 'reply_indisponible' });
    assert.equal((await annonces.reserverContact(client, ad('1'))).reservee, false);
  });
});

test('SQL un jeton absent ne finalise pas une annonce sans réservation', localDatabase, async () => {
  await withAnnonces(async ({ client, seed }) => {
    await seed([['1', 'Alice'], ['2', 'alice']]);
    await assert.rejects(
      annonces.finaliserContact(client, ad('1'), undefined, 'confirme', new Date(CONTACT_DATE)),
    );
    const rows = await client.query('select contacte_le from annonces order by url_annonce');
    assert.deepEqual(rows.rows.map((row) => row.contacte_le), [null, null]);
  });
});

test('SQL un jeton absent ne finalise ni ne libère une réservation active', localDatabase, async () => {
  await withAnnonces(async ({ client, seed }) => {
    await seed([['1', 'Alice'], ['2', 'alice']]);
    const first = await annonces.reserverContact(client, ad('1'), new Date(CONTACT_DATE));
    await assert.rejects(
      annonces.finaliserContact(client, ad('1'), undefined, 'confirme', new Date(CONTACT_DATE)),
    );
    const rows = await client.query('select contacte_le, contact_reservation_token from annonces order by url_annonce');
    assert.deepEqual(rows.rows.map((row) => [row.contacte_le, row.contact_reservation_token]), [
      [null, first.reservation_token], [null, null],
    ]);
  });
});

test('SQL finalisation confirmée garde la première date vendeur', localDatabase, async () => {
  await withAnnonces(async ({ client, seed }) => {
    await seed([['1', 'Alice'], ['2', 'alice']]);
    const first = await annonces.reserverContact(client, ad('1'), new Date(CONTACT_DATE));
    await client.query('update annonces set contacte_le = $2 where url_annonce = $1', [ad('2'), new Date('2026-09-25T10:00:00.000Z')]);
    const finalized = await annonces.finaliserContact(client, ad('1'), first.reservation_token, 'confirme', new Date(CONTACT_DATE));
    assert.deepEqual(finalized, { contacte_le: '2026-09-25T10:00:00.000Z' });
    const rows = await client.query('select contacte_le, contact_reservation_token from annonces order by url_annonce');
    assert.deepEqual(rows.rows.map((row) => [row.contacte_le.toISOString(), row.contact_reservation_token]), [
      ['2026-09-25T10:00:00.000Z', null], ['2026-09-25T10:00:00.000Z', null],
    ]);
  });
});

test('SQL deux connexions en concurrence ne réservent qu’un vendeur', localDatabase, async () => {
  await withSharedAnnonces(async ({ clientA, clientB }) => {
    await clientA.query('insert into annonces (url_annonce, vendeur) values ($1, $3), ($2, $3)', [ad('1'), ad('2'), 'Alice']);
    const [a, b] = await Promise.all([
      annonces.reserverContact(clientA, ad('1'), new Date(CONTACT_DATE)),
      annonces.reserverContact(clientB, ad('2'), new Date(CONTACT_DATE)),
    ]);
    assert.equal([a, b].filter((result) => result.reservee).length, 1);
    const tokens = await clientA.query('select contact_reservation_token from annonces where contact_reservation_token is not null');
    assert.equal(tokens.rows.length, 1);
  });
});

test('SQL la réservation garde le verrou vendeur avant son verrou de ligne pendant une finalisation concurrente', localDatabase, async () => {
  await withSharedAnnonces(async ({ clientA, clientB }) => {
    await clientA.query('insert into annonces (url_annonce, vendeur) values ($1, $3), ($2, $3)', [ad('1'), ad('2'), 'Alice']);
    const first = await annonces.reserverContact(clientA, ad('1'), new Date(CONTACT_DATE));
    let signalRowLocked;
    let releaseRowLock;
    const rowLocked = new Promise((resolve) => { signalRowLocked = resolve; });
    const continueReservation = new Promise((resolve) => { releaseRowLock = resolve; });
    let paused = false;
    const pausedClient = {
      async query(sql, params) {
        const result = await clientB.query(sql, params);
        if (!paused && /for update/i.test(sql)) {
          paused = true;
          signalRowLocked();
          await continueReservation;
        }
        return result;
      },
    };
    const reservation = annonces.reserverContact(pausedClient, ad('2'), new Date(CONTACT_DATE));
    try {
      await rowLocked;
      const probe = await clientA.query(
        'select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired',
        ['vendeur:alice'],
      );
      const finalization = annonces.finaliserContact(clientA, ad('1'), first.reservation_token, 'confirme', new Date(CONTACT_DATE));
      releaseRowLock();
      assert.equal((await reservation).reservee, false);
      assert.equal((await finalization).contacte_le, CONTACT_DATE);
      assert.equal(probe.rows[0].acquired, false);
    } finally {
      releaseRowLock();
    }
  });
});
