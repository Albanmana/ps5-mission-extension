import assert from 'node:assert/strict';
import test from 'node:test';

import { api, createApi } from '../extension/sw/api.js';
import { createNegotiationServer } from '../scripts/negotiate-server.js';
import { listenLoopback, request } from './helpers/http.js';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXTENSION = 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const AD = 'https://www.leboncoin.fr/ad/consoles/123';
const TOKEN = '11111111-2222-4333-8444-555555555555';

test('le client transmet les contrats exacts de réservation de contact et la réponse serveur', async () => {
  const calls = [];
  const client = createApi({ fetch: async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) });
    return Response.json({ numero: calls.length });
  } });
  assert.deepEqual(await client.reserverContact(AD), { numero: 1 });
  assert.deepEqual(await client.finaliserContact(AD, TOKEN, 'confirme'), { numero: 2 });
  assert.deepEqual(await client.libererContact(AD, TOKEN), { numero: 3 });
  assert.deepEqual(await client.marquerErreurContact(AD, 'reply_indisponible', TOKEN), { numero: 4 });
  assert.deepEqual(await client.marquerErreurContact(AD, 'formulaire_absent'), { numero: 5 });
  assert.deepEqual(calls.map(({ path, body }) => [path, body]), [
    ['/api/annonces/contact-reserver', { url_annonce: AD }],
    ['/api/annonces/contact-finaliser', { url_annonce: AD, reservation_token: TOKEN, resultat: 'confirme' }],
    ['/api/annonces/contact-liberer', { url_annonce: AD, reservation_token: TOKEN }],
    ['/api/annonces/contact-erreur', { url_annonce: AD, code: 'reply_indisponible', reservation_token: TOKEN }],
    ['/api/annonces/contact-erreur', { url_annonce: AD, code: 'formulaire_absent' }],
  ]);
  assert.equal(calls.every(({ method }) => method === 'POST'), true);
});

test('GET /api/health confirme le serveur et applique CORS pour chaque origine autorisée', async () => {
  const server = createNegotiationServer({ extensionOrigin: EXTENSION });
  for (const origin of [EXTENSION, 'http://localhost:8835', 'http://127.0.0.1:8835', undefined]) {
    const response = await request(server, '/api/health', { origin });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('access-control-allow-origin'), origin ?? null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('GET /api/health refuse une origine étrangère ou une extension non configurée sans émettre CORS', async () => {
  for (const [extensionOrigin, origin] of [
    [EXTENSION, OTHER_EXTENSION], [EXTENSION, 'https://evil.example'], [null, EXTENSION],
  ]) {
    const server = createNegotiationServer({ extensionOrigin });
    const response = await request(server, '/api/health', { origin });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Origine refusée.' });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('api.ping utilise un POST JSON qui permet au navigateur de joindre l’origine de l’extension', async (t) => {
  let requestedUrl;
  let requestedOptions;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return Response.json({ ok: true });
  });
  assert.equal(await api.ping(), true);
  assert.equal(requestedUrl, 'http://127.0.0.1:8835/api/health');
  assert.equal(requestedOptions?.method, 'POST');
  assert.equal(new Headers(requestedOptions.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(requestedOptions.body), {});
  // Origin est un en-tête navigateur : le test ne l'injecte pas dans fetch.
  assert.equal(new Headers(requestedOptions.headers).get('origin'), null);
});

test('api.ping refuse une erreur HTTP même si le corps annonce ok', async (t) => {
  let status;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }, { status }));
  for (status of [403, 404, 500]) assert.equal(await api.ping(), false);
});

test('api.ping refuse les succès HTTP sans charge de santé valide', async (t) => {
  let body;
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  for (body of ['{}', '{"ok":false}', '{"ok":"true"}', 'null', 'pas du JSON']) {
    assert.equal(await api.ping(), false);
  }
});

test('api.ping signale déconnecté en cas d’échec réseau', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal(await api.ping(), false);
});

test('le client conversations utilise les routes et charges exactes', async () => {
  const calls = [];
  const client = createApi({ fetch: async (url, options = {}) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/api/conversations') ? { conversations: [] } : { ok: true });
  } });
  const snapshot = { url_conversation: 'https://www.leboncoin.fr/messages/id/abc-def' };
  const fingerprint = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await client.conversations();
  await client.conversationNegotiate(snapshot, fingerprint);
  await client.conversationSent({ url_conversation: snapshot.url_conversation, fingerprint, message: 'ok' });
  await client.conversationHandled({ url_conversation: snapshot.url_conversation, fingerprint });
  await client.conversationError({ url_conversation: snapshot.url_conversation, fingerprint, code: 'envoi_incertain' });
  await client.handoff({ conversation_id: 'c1', message_vendeur: 'oui', handoff: {} });
  assert.deepEqual(calls.map((call) => [call.url, call.options.method ?? 'GET']), [
    ['http://127.0.0.1:8835/api/conversations', 'POST'],
    ['http://127.0.0.1:8835/api/conversations/negotiate', 'POST'],
    ['http://127.0.0.1:8835/api/conversations/sent', 'POST'],
    ['http://127.0.0.1:8835/api/conversations/handled', 'POST'],
    ['http://127.0.0.1:8835/api/conversations/error', 'POST'],
    ['http://127.0.0.1:8835/api/handoff', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.deepEqual(JSON.parse(calls[1].options.body), { snapshot, fingerprint });
});

test('le POST de santé sur un vrai socket autorise seulement les origines prévues sans refléter un refus', async (t) => {
  for (const [extensionOrigin, origin, expected] of [[OTHER_EXTENSION, EXTENSION, 403], [null, EXTENSION, 403],
    [EXTENSION, OTHER_EXTENSION, 403], [EXTENSION, 'https://evil.example', 403],
    [EXTENSION, EXTENSION, 200], [EXTENSION, 'self', 200], [EXTENSION, undefined, 200]]) {
    const baseUrl = await listenLoopback(createNegotiationServer({ extensionOrigin }), t);
    const headers = { 'content-type': 'application/json' };
    const effective = origin === 'self' ? baseUrl : origin;
    if (effective) headers.origin = effective;
    const response = await fetch(`${baseUrl}/api/health`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, expected);
    assert.deepEqual(await response.json(), expected === 200 ? { ok: true } : { error: 'Origine refusée.' });
    assert.equal(response.headers.get('access-control-allow-origin'), expected === 200 ? effective ?? null : null);
  }
});

test('le POST de santé traite le prévol et refuse les corps non JSON', async (t) => {
  const baseUrl = await listenLoopback(createNegotiationServer({ extensionOrigin: EXTENSION }), t);
  for (const [origin, status] of [[EXTENSION, 204], [OTHER_EXTENSION, 403]]) {
    const response = await fetch(`${baseUrl}/api/health`, { method: 'OPTIONS', headers: {
      origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type',
    } });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('access-control-allow-origin'), status === 204 ? EXTENSION : null);
  }
  for (const [contentType, body, status] of [['text/plain', '{}', 415], ['application/json', '{', 400]]) {
    const response = await fetch(`${baseUrl}/api/health`, { method: 'POST', headers: {
      origin: EXTENSION, 'content-type': contentType,
    }, body });
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('le client transmet les réglages et les réservations bloquées', async () => {
  const calls = [];
  const client = createApi({ fetch: async (url, options) => {
    calls.push([new URL(url).pathname, JSON.parse(options.body)]);
    return Response.json({});
  } });
  const settings = { dryRun: true };
  await client.classifyAnnonce(AD, { force: true, settings });
  await client.conversationNegotiate({ a: 1 }, 'abc', settings);
  await client.handoff({ conversation_id: 'c1', settings });
  await client.reservationsBloquees();
  await client.resoudreReservation(AD, 'envoye');
  assert.deepEqual(calls, [
    ['/api/annonces/classify', { url_annonce: AD, force: true, settings }],
    ['/api/conversations/negotiate', { snapshot: { a: 1 }, fingerprint: 'abc', settings }],
    ['/api/handoff', { conversation_id: 'c1', settings }],
    ['/api/annonces/reservations', {}],
    ['/api/annonces/reservation-resoudre', { url_annonce: AD, resultat: 'envoye' }],
  ]);
});
