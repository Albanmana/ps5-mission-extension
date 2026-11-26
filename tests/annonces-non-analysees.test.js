import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';

import { chargerNonAnalysees, chargerAEnrichir, marquerIntrouvable } from '../scripts/lib/annonces.js';

// Même convention que annonces-db.test.js : couverture PostgreSQL locale
// optionnelle, sur une table temporaire qui masque public.annonces.
const localDatabase = { skip: process.env.PS5_TEST_LOCAL_DB !== '1' };
const ad = (id) => `https://www.leboncoin.fr/ad/consoles/${id}`;

async function withAnnonces(run) {
  const client = new Client({
    host: '127.0.0.1', port: 54322, user: 'postgres', password: 'postgres',
    database: 'postgres', connectionTimeoutMillis: 2000,
  });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create temporary table annonces (
      url_annonce text primary key, titre text, prix_eur numeric,
      analyse_ia_le timestamptz, created_at timestamptz default now()
    ) on commit drop`);
    await run(client);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

const semer = (client, rows) => Promise.all(rows.map(([id, titre, analyseLe, cree]) => client.query(
  'insert into annonces (url_annonce, titre, prix_eur, analyse_ia_le, created_at) values ($1, $2, 300, $3, $4)',
  [ad(id), titre, analyseLe, cree],
)));

test('chargerNonAnalysees ne rend que les annonces sans analyse', localDatabase, async () => {
  await withAnnonces(async (client) => {
    await semer(client, [
      [1, 'analysée', '2026-09-26T10:00:00Z', '2026-09-26T09:00:00Z'],
      [2, 'en échec', null, '2026-09-26T09:01:00Z'],
      [3, 'jamais vue', null, '2026-09-26T09:02:00Z'],
    ]);

    const rows = await chargerNonAnalysees(client);

    assert.deepEqual(rows.map((r) => r.titre), ['en échec', 'jamais vue']);
  });
});

test('chargerNonAnalysees rend les plus anciennes d’abord', localDatabase, async () => {
  await withAnnonces(async (client) => {
    await semer(client, [
      [1, 'récente', null, '2026-09-26T12:00:00Z'],
      [2, 'ancienne', null, '2026-09-26T08:00:00Z'],
    ]);

    const rows = await chargerNonAnalysees(client);

    assert.deepEqual(rows.map((r) => r.titre), ['ancienne', 'récente']);
  });
});

test('chargerNonAnalysees borne le nombre rendu', localDatabase, async () => {
  await withAnnonces(async (client) => {
    await semer(client, [
      [1, 'une', null, '2026-09-26T08:00:00Z'],
      [2, 'deux', null, '2026-09-26T09:00:00Z'],
      [3, 'trois', null, '2026-09-26T10:00:00Z'],
    ]);

    const rows = await chargerNonAnalysees(client, { limite: 2 });

    assert.deepEqual(rows.map((r) => r.titre), ['une', 'deux']);
  });
});

test('chargerNonAnalysees rend les colonnes dont le pipeline a besoin', localDatabase, async () => {
  await withAnnonces(async (client) => {
    await semer(client, [[1, 'PS5 à reprendre', null, '2026-09-26T08:00:00Z']]);

    const [annonce] = await chargerNonAnalysees(client);

    // Le pipeline part de l'annonce complète : il lui faut au moins de quoi
    // l'identifier et la décrire.
    assert.equal(annonce.url_annonce, ad(1));
    assert.equal(annonce.titre, 'PS5 à reprendre');
    assert.equal(Number(annonce.prix_eur), 300);
  });
});

// --- Fiches manquantes ------------------------------------------------------

async function withAnnoncesCompletes(run) {
  const client = new Client({
    host: '127.0.0.1', port: 54322, user: 'postgres', password: 'postgres',
    database: 'postgres', connectionTimeoutMillis: 2000,
  });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create temporary table annonces (
      url_annonce text primary key, titre text, prix_eur numeric,
      description text, classification text, disqualifiee boolean not null default false,
      disqualification_raison text, list_id bigint, decision_manuelle boolean not null default false
    ) on commit drop`);
    await run(client);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

const semerFiches = (client, rows) => Promise.all(rows.map(([id, titre, description, classification, disqualifiee, prix = 300]) =>
  client.query(`insert into annonces (url_annonce, titre, description, classification, disqualifiee, prix_eur)
                values ($1, $2, $3, $4, $5, $6)`, [ad(id), titre, description, classification, disqualifiee, prix])));

test('chargerAEnrichir ne rend que les annonces sans description et non disqualifiées', localDatabase, async () => {
  await withAnnoncesCompletes(async (client) => {
    await semerFiches(client, [
      [1, 'fiche déjà lue', 'une description', 'saint_graal', false],
      [2, 'à enrichir', null, 'saint_graal', false],
      [3, 'écartée', null, 'disqualifiee', true],
    ]);

    const rows = await chargerAEnrichir(client);

    assert.deepEqual(rows.map((r) => r.titre), ['à enrichir']);
  });
});

test('chargerAEnrichir traite les plus prometteuses en premier', localDatabase, async () => {
  await withAnnoncesCompletes(async (client) => {
    await semerFiches(client, [
      [1, 'à vérifier', null, 'a_verifier', false, 300],
      [2, 'graal cher', null, 'saint_graal', false, 340],
      [3, 'graal pas cher', null, 'saint_graal', false, 250],
      [4, 'intéressante', null, 'interessant', false, 300],
    ]);

    const rows = await chargerAEnrichir(client);

    // Le budget de requêtes est limité : il doit servir aux meilleures.
    assert.deepEqual(rows.map((r) => r.titre),
      ['graal pas cher', 'graal cher', 'intéressante', 'à vérifier']);
  });
});

test('chargerAEnrichir borne le nombre rendu', localDatabase, async () => {
  await withAnnoncesCompletes(async (client) => {
    await semerFiches(client, [
      [1, 'une', null, 'saint_graal', false],
      [2, 'deux', null, 'saint_graal', false],
      [3, 'trois', null, 'saint_graal', false],
    ]);

    assert.equal((await chargerAEnrichir(client, { limite: 2 })).length, 2);
  });
});

test('marquerIntrouvable sort l’annonce de la file et de la shortlist', localDatabase, async () => {
  await withAnnoncesCompletes(async (client) => {
    await semerFiches(client, [[1, 'vendue entre-temps', null, 'saint_graal', false]]);

    const { marquee } = await marquerIntrouvable(client, ad(1));

    assert.equal(marquee, true);
    // Sans ça, une annonce supprimée n'aurait jamais de description et
    // resterait dans la file d'enrichissement à chaque exécution.
    assert.deepEqual(await chargerAEnrichir(client), []);
    const { rows: [a] } = await client.query('select disqualifiee, classification, disqualification_raison from annonces where url_annonce = $1', [ad(1)]);
    assert.equal(a.disqualifiee, true);
    assert.equal(a.classification, 'disqualifiee');
    assert.match(a.disqualification_raison, /supprimée/);
  });
});

test('marquerIntrouvable signale une URL inconnue', localDatabase, async () => {
  await withAnnoncesCompletes(async (client) => {
    assert.deepEqual(await marquerIntrouvable(client, ad(999)), { marquee: false });
  });
});
