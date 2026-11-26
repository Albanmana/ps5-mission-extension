import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { upsertAnnonce } from '../scripts/lib/annonces.js';
import { createAnnonceQueue, createNegotiationServer } from '../scripts/negotiate-server.js';
import { post, request } from './helpers/http.js';

const A = 'https://www.leboncoin.fr/ad/consoles/123';
const B = 'https://www.leboncoin.fr/ad/consoles/456';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('les images du détail sont liées en SQL puis relues pour la classification forcée sans écrire les colonnes IA', async () => {
  const images = ['https://img.leboncoin.fr/images/front', 'https://img.leboncoin.fr/images/disc'];
  const stored = { url_annonce: A, image_url: 'https://img.leboncoin.fr/images/card',
    classification: 'a_verifier', analyse_ia_le: '2026-09-25T12:00:00.000Z' };
  let insert;
  const client = { async query(sql, values) {
    if (/^select /i.test(sql)) {
      assert.equal(values[0], A);
      return { rows: [structuredClone(stored)] };
    }
    insert = { sql, values };
    const columns = sql.match(/insert into annonces \(([^)]+)\)/i)[1].split(', ');
    for (const [index, column] of columns.entries()) stored[column] = structuredClone(values[index]);
    return { rows: [] };
  } };
  let classificationInput;
  const server = createNegotiationServer({
    upsertAnnonce: (annonce) => upsertAnnonce(client, annonce),
    classifyAnnonce: async (url, { force }) => {
      assert.equal(force, true);
      const { rows } = await client.query('select * from annonces where url_annonce = $1', [url]);
      classificationInput = rows[0];
      return { url_annonce: url, classification: 'saint_graal' };
    },
  });

  const upsert = await post(server, '/api/annonces/upsert', { annonce: {
    url_annonce: A, titre: 'PS5 avec lecteur', description: 'Deux photos du lecteur', images,
    classification: 'poison', analyse_ia: { injected: true }, arbitrary_column: 'poison',
  } });
  assert.equal(upsert.status, 200);
  assert.deepEqual(await upsert.json(), { created: false, deja_analysee: true });
  assert.match(insert.sql, /\bimages\b/);
  assert.match(insert.sql, /images = coalesce\(excluded.images, annonces.images\)/);
  assert.doesNotMatch(insert.sql, /classification|analyse_ia|arbitrary_column|https:/);
  const imageIndex = insert.sql.match(/insert into annonces \(([^)]+)\)/i)[1].split(', ').indexOf('images');
  assert.deepEqual(insert.values[imageIndex], images);
  assert.equal(stored.classification, 'a_verifier');

  const classified = await post(server, '/api/annonces/classify', { url_annonce: A, force: true });
  assert.equal(classified.status, 200);
  assert.deepEqual(classificationInput.images, images);
  assert.equal(classificationInput.image_url, 'https://img.leboncoin.fr/images/card');
  assert.equal(classificationInput.description, 'Deux photos du lecteur');
});

test('une ancienne classification finit avant le nouvel upsert et avant toute relecture pour sa reclassification', async () => {
  const oldModel = deferred();
  const oldStarted = deferred();
  const events = [];
  const stored = { url_annonce: A, titre: 'ancienne carte', images: ['ancienne-photo'] };
  const client = { async query(sql, values) {
    assert.deepEqual(values, [A]);
    assert.match(sql, /^select \* from annonces where url_annonce = \$1$/);
    events.push(`select:${stored.titre}`);
    return { rows: [structuredClone(stored)] };
  } };
  const server = createNegotiationServer({
    upsertAnnonce: async (annonce) => {
      events.push(`upsert:${annonce.titre}`);
      Object.assign(stored, annonce);
      return { created: false, deja_analysee: true };
    },
    classifyAnnonce: async (url, { force }) => {
      assert.equal(force, true);
      const { rows: [snapshot] } = await client.query('select * from annonces where url_annonce = $1', [url]);
      events.push(`model:${snapshot.titre}`);
      if (snapshot.titre === 'ancienne carte') {
        oldStarted.resolve();
        await oldModel.promise;
      }
      // The real classifier upserts its input fields together with its verdict.
      Object.assign(stored, snapshot, { classification: snapshot.titre === 'détail frais' ? 'saint_graal' : 'a_verifier' });
      events.push(`write:${snapshot.titre}`);
      return { url_annonce: url, classification: stored.classification };
    },
  });
  const old = post(server, '/api/annonces/classify', { url_annonce: A, force: true });
  await oldStarted.promise;
  const freshUpsert = post(server, '/api/annonces/upsert', { annonce: {
    url_annonce: A, titre: 'détail frais', images: ['face', 'lecteur'],
  } });
  await tick();
  const freshClassify = post(server, '/api/annonces/classify', { url_annonce: A, force: true });
  await tick();
  const beforeRelease = [...events];
  oldModel.resolve();
  const responses = await Promise.all([old, freshUpsert, freshClassify]);

  assert.deepEqual(beforeRelease, ['select:ancienne carte', 'model:ancienne carte']);
  assert.deepEqual(events, ['select:ancienne carte', 'model:ancienne carte', 'write:ancienne carte',
    'upsert:détail frais', 'select:détail frais', 'model:détail frais', 'write:détail frais']);
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
  assert.equal((await responses[2].json()).classification, 'saint_graal');
  assert.equal(stored.titre, 'détail frais');
  assert.deepEqual(stored.images, ['face', 'lecteur']);
  assert.equal(stored.classification, 'saint_graal');
});

test('une classification attend son upsert mais une autre URL progresse pendant cette attente', async () => {
  const blocked = deferred();
  const started = deferred();
  const events = [];
  const server = createNegotiationServer({
    upsertAnnonce: async () => { events.push('upsert:start'); started.resolve(); await blocked.promise; events.push('upsert:end'); return {}; },
    classifyAnnonce: async (url) => { events.push(`select:${url}`); return { url_annonce: url }; },
  });
  const upsert = post(server, '/api/annonces/upsert', { annonce: { url_annonce: A } });
  await started.promise;
  const same = post(server, '/api/annonces/classify', { url_annonce: A });
  const other = post(server, '/api/annonces/classify', { url_annonce: B });
  let otherCompleted = false;
  other.then(() => { otherCompleted = true; });
  await tick();
  const beforeRelease = [...events];
  const otherCompletedBeforeRelease = otherCompleted;
  blocked.resolve();
  await Promise.all([upsert, same, other]);

  assert.equal(otherCompletedBeforeRelease, true);
  assert.deepEqual(beforeRelease, ['upsert:start', `select:${B}`]);
  assert.deepEqual(events, ['upsert:start', `select:${B}`, 'upsert:end', `select:${A}`]);
});

test('le marquage de contact attend les mutations de la même URL sans retenir une autre URL', async () => {
  const blocked = deferred();
  const started = deferred();
  const events = [];
  const server = createNegotiationServer({
    upsertAnnonce: async () => { events.push('upsert:start'); started.resolve(); await blocked.promise; events.push('upsert:end'); return {}; },
    marquerContactee: async (url) => { events.push(`contact:${url}`); return { contacte_le: '2026-09-26T10:00:00.000Z' }; },
    classifyAnnonce: async (url) => { events.push(`select:${url}`); return { url_annonce: url }; },
  });
  const upsert = post(server, '/api/annonces/upsert', { annonce: { url_annonce: A } });
  await started.promise;
  const contact = post(server, '/api/annonces/contactee', { url_annonce: A });
  const other = post(server, '/api/annonces/classify', { url_annonce: B });
  await tick();
  const beforeRelease = [...events];
  blocked.resolve();
  const responses = await Promise.all([upsert, contact, other]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
  assert.deepEqual(beforeRelease, ['upsert:start', `select:${B}`]);
  assert.deepEqual(events, ['upsert:start', `select:${B}`, 'upsert:end', `contact:${A}`]);
});

test('l’ordre d’arrivée est conservé même si le JSON du premier upsert arrive plus lentement', async () => {
  const bodyStream = new PassThrough();
  const events = [];
  let titre = 'ancienne carte';
  const server = createNegotiationServer({
    upsertAnnonce: async (annonce) => { titre = annonce.titre; events.push('upsert'); return {}; },
    classifyAnnonce: async () => { events.push(`select:${titre}`); return { titre }; },
  });
  const upsert = request(server, '/api/annonces/upsert', { method: 'POST', bodyStream });
  const classify = post(server, '/api/annonces/classify', { url_annonce: A });
  await tick();
  const beforeBody = [...events];
  bodyStream.end(JSON.stringify({ annonce: { url_annonce: A, titre: 'détail frais' } }));
  const responses = await Promise.all([upsert, classify]);

  assert.deepEqual(beforeBody, []);
  assert.deepEqual(events, ['upsert', 'select:détail frais']);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal((await responses[1].json()).titre, 'détail frais');
});

test('un JSON ou une charge invalide libère sa place pour les requêtes suivantes', async () => {
  for (const route of ['upsert', 'classify']) {
    for (const body of ['{', 'null', '{}']) {
      const bodyStream = new PassThrough();
      const server = createNegotiationServer({ classifyAnnonce: async () => ({ ok: true }) });
      const invalid = request(server, `/api/annonces/${route}`, { method: 'POST', bodyStream });
      const valid = post(server, '/api/annonces/classify', { url_annonce: B });
      bodyStream.end(body);
      const responses = await Promise.all([invalid, valid]);
      assert.deepEqual(responses.map((response) => response.status), [400, 200]);
    }
  }
});

for (const failedRoute of ['upsert', 'classify']) {
  test(`un échec ${failedRoute} libère les opérations suivantes pour la même URL`, async () => {
    const blocked = deferred();
    const started = deferred();
    const events = [];
    let first = true;
    const operation = (kind) => async () => {
      events.push(kind);
      if (first) {
        first = false;
        started.resolve();
        await blocked.promise;
        throw new Error('échec simulé');
      }
      return { ok: true };
    };
    const server = createNegotiationServer({ upsertAnnonce: operation('upsert'),
      classifyAnnonce: operation('classify'), logger: { error() {} } });
    const failed = post(server, `/api/annonces/${failedRoute}`, failedRoute === 'upsert'
      ? { annonce: { url_annonce: A } } : { url_annonce: A });
    await started.promise;
    const upsert = post(server, '/api/annonces/upsert', { annonce: { url_annonce: A } });
    await tick();
    const classify = post(server, '/api/annonces/classify', { url_annonce: A });
    await tick();
    const beforeRelease = [...events];
    blocked.resolve();
    const responses = await Promise.all([failed, upsert, classify]);

    assert.deepEqual(beforeRelease, [failedRoute]);
    assert.deepEqual(events, [failedRoute, 'upsert', 'classify']);
    assert.deepEqual(responses.map((response) => response.status), [failedRoute === 'upsert' ? 500 : 502, 200, 200]);
  });
}

test('la file retire les clés terminées sans retirer celle dont une opération attend encore', async () => {
  const queue = createAnnonceQueue();
  const firstGate = deferred();
  const secondGate = deferred();
  const first = queue.run(A, () => firstGate.promise);
  const second = queue.run(A, () => secondGate.promise);
  assert.equal(queue.size, 1);
  firstGate.resolve('première');
  assert.equal(await first, 'première');
  assert.equal(queue.size, 1);
  secondGate.resolve('seconde');
  assert.equal(await second, 'seconde');
  assert.equal(queue.size, 0);

  const rejected = queue.run(A, () => { throw new Error('synchrone'); });
  await assert.rejects(rejected, /synchrone/);
  assert.equal(queue.size, 0);
  await assert.rejects(queue.run(A, async () => { throw new Error('asynchrone'); }), /asynchrone/);
  assert.equal(queue.size, 0);

  await Promise.all(Array.from({ length: 100 }, (_, index) => queue.run(`annonce-${index}`, () => index)));
  assert.equal(queue.size, 0);
});
