import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createNegotiationServer, validateLogRequest } from '../scripts/negotiate-server.js';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

// Le puits de logs est injecté : les tests n'écrivent jamais sur le disque.
async function withServer(dependencies, run) {
  const server = createNegotiationServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async () => null,
    negotiate: async () => ({}),
    extensionOrigin: EXTENSION,
    ...dependencies,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const envoyer = (baseUrl, body, origin = EXTENSION) => fetch(`${baseUrl}/api/log`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify(body),
});

test('validateLogRequest exige un tableau d’entrées avec une portée et un événement', () => {
  assert.throws(() => validateLogRequest({}), /entries/);
  assert.throws(() => validateLogRequest({ entries: 'non' }), /entries/);
  assert.throws(() => validateLogRequest({ entries: [{ event: 'sans-portee' }] }), /scope/);
  assert.throws(() => validateLogRequest({ entries: [{ scope: 'sw' }] }), /event/);
});

test('validateLogRequest normalise une entrée minimale', () => {
  const [entree] = validateLogRequest({ entries: [{ scope: 'sw', event: 'ping' }] });
  assert.equal(entree.scope, 'sw');
  assert.equal(entree.event, 'ping');
  assert.deepEqual(entree.data, {});
});

test('validateLogRequest borne le nombre d’entrées d’un seul envoi', () => {
  const entries = Array.from({ length: 201 }, () => ({ scope: 'sw', event: 'bruit' }));
  assert.throws(() => validateLogRequest({ entries }), /200/);
});

test('POST /api/log transmet les entrées au puits et les horodate', async () => {
  const recues = [];
  await withServer({ appendLog: async (entries) => { recues.push(...entries); } }, async (baseUrl) => {
    const response = await envoyer(baseUrl, {
      entries: [
        { scope: 'sw', event: 'api:requete', data: { path: '/api/health' } },
        { scope: 'panel', event: 'clic', data: { bouton: 'lancer' } },
      ],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, recorded: 2 });
  });

  assert.equal(recues.length, 2);
  assert.equal(recues[0].scope, 'sw');
  assert.equal(recues[0].event, 'api:requete');
  assert.deepEqual(recues[0].data, { path: '/api/health' });
  // Le serveur horodate lui-même : l'heure d'une extension n'est pas fiable.
  assert.ok(!Number.isNaN(Date.parse(recues[0].recu_le)));
});

test('POST /api/log refuse une origine étrangère sans rien écrire', async () => {
  let appele = false;
  await withServer({ appendLog: async () => { appele = true; } }, async (baseUrl) => {
    const response = await envoyer(baseUrl, { entries: [{ scope: 'sw', event: 'x' }] },
      'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');

    assert.equal(response.status, 403);
  });
  assert.equal(appele, false);
});

test('POST /api/log refuse une charge invalide sans rien écrire', async () => {
  let appele = false;
  await withServer({ appendLog: async () => { appele = true; } }, async (baseUrl) => {
    const response = await envoyer(baseUrl, { entries: [{ event: 'sans-portee' }] });

    assert.equal(response.status, 400);
  });
  assert.equal(appele, false);
});

test('une panne du puits de logs ne fait pas tomber le serveur', async () => {
  await withServer({ appendLog: async () => { throw new Error('disque plein'); } }, async (baseUrl) => {
    const response = await envoyer(baseUrl, { entries: [{ scope: 'sw', event: 'x' }] });

    assert.equal(response.status, 500);
    // Le détail de la panne reste côté serveur.
    assert.deepEqual(await response.json(), { error: 'Journalisation impossible.' });

    // Le serveur répond encore après coup.
    const apres = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXTENSION },
      body: '{}',
    });
    assert.equal(apres.status, 200);
  });
});
