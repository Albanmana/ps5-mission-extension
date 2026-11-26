import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import test from 'node:test';

import { createNegotiationServer } from '../scripts/negotiate-server.js';
import { listenLoopback } from './helpers/http.js';

const A = 'https://www.leboncoin.fr/ad/consoles/123';
const B = 'https://www.leboncoin.fr/ad/consoles/456';
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const BODY_TIMEOUT_MS = 60;
// The deadline is absolute; this allowance covers local socket/test scheduling.
const SCHEDULING_ALLOWANCE_MS = 2000;

async function within(promise, milliseconds, message) {
  const expired = Symbol('expired');
  let timer;
  try {
    const result = await Promise.race([promise, new Promise((resolve) => {
      timer = setTimeout(() => resolve(expired), milliseconds);
    })]);
    assert.notEqual(result, expired, message);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function partialBody(server, baseUrl, path, t, contentLength = 1024) {
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(baseUrl).port) });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const chunks = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => chunks.push(chunk));
  const closed = new Promise((resolve, reject) => {
    socket.once('close', () => resolve(chunks.join('')));
    socket.once('error', (error) => {
      // A body byte already in flight can reset a closing socket *after* the
      // complete HTTP reply. Callers still assert its status/body/final chunk.
      if (error.code !== 'ECONNRESET') reject(error);
    });
  });
  // Destruction is intentional in abort tests and failure cleanup.
  closed.catch(() => {});
  const received = once(server, 'request');
  socket.write(`POST ${path} HTTP/1.1\r\nHost: ${new URL(baseUrl).host}\r\nOrigin: ${EXTENSION}\r\nContent-Type: application/json\r\nContent-Length: ${contentLength}\r\nConnection: close\r\n\r\n{`);
  await received;
  return { socket, closed };
}

function classifyOther(baseUrl) {
  return fetch(`${baseUrl}/api/annonces/classify`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: EXTENSION },
    body: JSON.stringify({ url_annonce: B }),
  });
}

for (const route of ['upsert', 'classify', 'contactee']) {
  test(`un corps ${route} incomplet expire même s’il progresse et libère une autre URL sur de vrais sockets`, async (t) => {
    const calls = [];
    const server = createNegotiationServer({
      bodyTimeoutMs: BODY_TIMEOUT_MS, extensionOrigin: EXTENSION,
      upsertAnnonce: async () => assert.fail('aucune écriture du corps incomplet'),
      marquerContactee: async () => assert.fail('aucun contact du corps incomplet'),
      classifyAnnonce: async (url) => { calls.push(url); return { url_annonce: url }; },
    });
    const baseUrl = await listenLoopback(server, t);
    const partial = await partialBody(server, baseUrl, `/api/annonces/${route}`, t);
    const trickle = setInterval(() => { if (!partial.socket.destroyed) partial.socket.write(' '); }, 10);
    partial.socket.once('data', () => clearInterval(trickle));
    t.after(() => clearInterval(trickle));

    const other = await within(classifyOther(baseUrl), BODY_TIMEOUT_MS + SCHEDULING_ALLOWANCE_MS,
      'une autre URL attend encore après le délai maximal de lecture du corps');
    assert.equal(other.status, 200);
    assert.deepEqual(await other.json(), { url_annonce: B });
    const expired = await within(partial.closed, SCHEDULING_ALLOWANCE_MS, 'la connexion expirée doit être fermée après sa réponse');
    assert.match(expired, /^HTTP\/1\.1 408 /);
    assert.match(expired, /access-control-allow-origin: chrome-extension:\/\/abcdefghijklmnopabcdefghijklmnop/i);
    assert.match(expired, /Délai.*corps.*dépassé/);
    assert.match(expired, /\r\n0\r\n\r\n$/);
    assert.deepEqual(calls, [B]);
  });

  test(`un corps ${route} avorté ou malformé libère immédiatement l’admission réseau`, async (t) => {
    const server = createNegotiationServer({
      bodyTimeoutMs: 2000, extensionOrigin: EXTENSION,
      upsertAnnonce: async () => assert.fail('aucune écriture invalide'),
      marquerContactee: async () => assert.fail('aucun contact invalide'),
      classifyAnnonce: async (url) => ({ url_annonce: url }),
    });
    const baseUrl = await listenLoopback(server, t);
    for (const ending of ['abort', 'malformed']) {
      const partial = await partialBody(server, baseUrl, `/api/annonces/${route}`, t, 2);
      const other = classifyOther(baseUrl);
      if (ending === 'abort') partial.socket.destroy();
      else partial.socket.write('!');
      const response = await within(other, SCHEDULING_ALLOWANCE_MS, `${ending} retient l’admission`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { url_annonce: B });
      if (ending === 'malformed') {
        const rejected = await within(partial.closed, SCHEDULING_ALLOWANCE_MS, 'le JSON invalide doit avoir une réponse');
        assert.match(rejected, /^HTTP\/1\.1 400 /);
        assert.match(rejected, /JSON de requête invalide/);
        assert.match(rejected, /\r\n0\r\n\r\n$/);
      }
    }
  });
}

test('les corps trop volumineux gardent une réponse JSON 400 et libèrent la file', async (t) => {
  const server = createNegotiationServer({
    extensionOrigin: EXTENSION,
    upsertAnnonce: async () => assert.fail('aucune écriture volumineuse'),
    marquerContactee: async () => assert.fail('aucun contact volumineux'),
    classifyAnnonce: async (url) => ({ url_annonce: url }),
  });
  const baseUrl = await listenLoopback(server, t);
  for (const path of ['/api/annonces/upsert', '/api/annonces/classify', '/api/annonces/contactee', '/api/negotiate', '/api/health']) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: EXTENSION },
      body: JSON.stringify({ url_annonce: A, padding: 'x'.repeat(64 * 1024) }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Corps de requête trop volumineux.' });
    assert.equal((await classifyOther(baseUrl)).status, 200);
  }
});

test('la lecture des corps health et negotiate est également bornée', async (t) => {
  const server = createNegotiationServer({ bodyTimeoutMs: BODY_TIMEOUT_MS, extensionOrigin: EXTENSION });
  const baseUrl = await listenLoopback(server, t);
  for (const path of ['/api/health', '/api/negotiate']) {
    const partial = await partialBody(server, baseUrl, path, t);
    const response = await within(partial.closed, BODY_TIMEOUT_MS + SCHEDULING_ALLOWANCE_MS,
      'le délai de lecture doit produire une réponse exploitable');
    assert.match(response, /^HTTP\/1\.1 408 /);
    assert.match(response, /\r\n0\r\n\r\n$/);
  }
});
