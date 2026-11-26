import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger, MAX_BUFFER } from '../extension/lib/log.js';

// Un faux fetch qui enregistre les envois et laisse le test décider de l'issue.
function fauxFetch({ echoue = false } = {}) {
  const envois = [];
  const fn = async (url, options) => {
    envois.push({ url, body: JSON.parse(options.body) });
    if (echoue) throw new Error('serveur injoignable');
    return { ok: true, json: async () => ({ ok: true }) };
  };
  fn.envois = envois;
  return fn;
}

const logger = (fetch, options = {}) => createLogger({
  scope: 'sw',
  fetch,
  baseUrl: 'http://127.0.0.1:8835',
  ...options,
});

test('flush envoie les entrées accumulées sur /api/log avec leur portée', async () => {
  const fetch = fauxFetch();
  const log = logger(fetch);

  log.log('api:requete', { path: '/api/health' });
  log.log('api:reponse', { status: 200 });
  await log.flush();

  assert.equal(fetch.envois.length, 1);
  assert.equal(fetch.envois[0].url, 'http://127.0.0.1:8835/api/log');
  assert.deepEqual(fetch.envois[0].body.entries, [
    { scope: 'sw', event: 'api:requete', data: { path: '/api/health' } },
    { scope: 'sw', event: 'api:reponse', data: { status: 200 } },
  ]);
});

test('un flush sans rien en attente n’appelle pas le serveur', async () => {
  const fetch = fauxFetch();
  await logger(fetch).flush();
  assert.equal(fetch.envois.length, 0);
});

test('le tampon est vidé après un envoi réussi', async () => {
  const fetch = fauxFetch();
  const log = logger(fetch);

  log.log('un');
  await log.flush();
  await log.flush();

  assert.equal(fetch.envois.length, 1, 'le second flush ne doit rien réenvoyer');
});

test('un serveur injoignable ne fait jamais lever le logger', async () => {
  const fetch = fauxFetch({ echoue: true });
  const log = logger(fetch);

  log.log('perdu');
  await assert.doesNotReject(() => log.flush());

  // Les entrées sont abandonnées : journaliser ne doit pas gonfler indéfiniment.
  await log.flush();
  assert.equal(fetch.envois.length, 1);
});

test('le tampon est borné et garde les entrées les plus récentes', async () => {
  const fetch = fauxFetch();
  const log = logger(fetch);

  for (let i = 0; i < MAX_BUFFER + 10; i += 1) log.log('bruit', { i });
  await log.flush();

  const { entries } = fetch.envois[0].body;
  assert.equal(entries.length, MAX_BUFFER);
  assert.deepEqual(entries.at(-1).data, { i: MAX_BUFFER + 9 });
});

test('une donnée non sérialisable ne perd pas l’entrée', async () => {
  const fetch = fauxFetch();
  const log = logger(fetch);

  const cyclique = { nom: 'boucle' };
  cyclique.self = cyclique;
  log.log('cycle', cyclique);
  await assert.doesNotReject(() => log.flush());

  assert.equal(fetch.envois[0].body.entries[0].event, 'cycle');
});

test('logErreur consigne le message et le type de l’erreur', async () => {
  const fetch = fauxFetch();
  const log = logger(fetch);

  log.logErreur('api:echec', new TypeError('Failed to fetch'), { path: '/api/health' });
  await log.flush();

  assert.deepEqual(fetch.envois[0].body.entries[0].data, {
    path: '/api/health',
    erreur: 'Failed to fetch',
    type: 'TypeError',
  });
});
