import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { DEFAULT_SETTINGS, ownerLabel } from '../scripts/lib/server-settings.js';
import { createNegotiationServer } from '../scripts/negotiate-server.js';
import { listenLoopback, request } from './helpers/http.js';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SELF = 'http://127.0.0.1:8835';
const AD = 'https://www.leboncoin.fr/ad/consoles/123';
const ID = '11111111-2222-4333-8444-555555555555';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function rawGet(baseUrl, path, host) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = httpRequest({ hostname: '127.0.0.1', port: url.port, path: url.pathname,
      headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

test('un Host étranger est refusé (DNS rebinding), seuls 127.0.0.1 et localhost passent', async (t) => {
  const baseUrl = await listenLoopback(createNegotiationServer({
    template: '__NEGOTIATION_PAYLOAD__', loadConversations: async () => [],
  }), t);
  const { port } = new URL(baseUrl);
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    assert.equal(await rawGet(baseUrl, '/', host), 200, host);
  }
  for (const host of [`evil.example:${port}`, 'evil.example', '127.0.0.1', `127.0.0.1:${Number(port) + 1}`, `[::1]:${port}`]) {
    assert.equal(await rawGet(baseUrl, '/', host), 403, host);
    assert.equal(await rawGet(baseUrl, '/api/health', host), 403, host);
  }
});

test('toutes les routes POST exigent le type JSON et une origine sûre', async () => {
  const server = createNegotiationServer({ extensionOrigin: EXTENSION, logger: { error() {} } });
  for (const path of ['/api/log', '/api/annonces/contactee', '/api/annonces/contact-erreur', '/api/annonces/upsert',
    '/api/annonces/classify', '/api/annonces/introuvable', '/api/annonces/reservations',
    '/api/annonces/reservation-resoudre', '/api/dashboard/disqualification', '/api/handoff', '/api/negotiate']) {
    const incoming = await request(server, path, { method: 'POST', body: {}, origin: EXTENSION, contentType: 'text/plain' });
    assert.ok([403, 415].includes(incoming.status), `${path}: ${incoming.status}`);
    for (const origin of ['https://evil.example', 'http://localhost:3000', 'null']) {
      const denied = await request(server, path, { method: 'POST', body: {}, origin });
      assert.equal(denied.status, 403, `${path} ${origin}`);
    }
  }
});

test('le dashboard est servi par le serveur Node avec une CSP', async () => {
  const server = createNegotiationServer({ dashboardTemplate: '<h1>Dashboard</h1>' });
  const response = await request(server, '/dashboard');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(await response.text(), /Dashboard/);
  assert.equal((await request(server, '/.env')).status, 404);
  assert.equal((await request(server, '/logs/extension.log')).status, 404);
});

test('les routes de données du dashboard listent et (re)qualifient, depuis la même origine seulement', async () => {
  const calls = [];
  const server = createNegotiationServer({
    extensionOrigin: EXTENSION,
    listerDashboard: async () => [{ id: ID }],
    definirDisqualification: async (...args) => { calls.push(args); return { id: ID, disqualifiee: true }; },
  });
  assert.deepEqual(await (await request(server, '/api/dashboard/annonces')).json(), { annonces: [{ id: ID }] });
  for (const origin of ['https://evil.example', 'http://localhost:3000', EXTENSION]) {
    assert.equal((await request(server, '/api/dashboard/annonces', { origin })).status, 403, origin);
  }
  const ok = await request(server, '/api/dashboard/disqualification', {
    method: 'POST', body: { id: ID, disqualifiee: true }, origin: SELF,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { annonce: { id: ID, disqualifiee: true } });
  for (const origin of [undefined, EXTENSION]) {
    assert.equal((await request(server, '/api/dashboard/disqualification', {
      method: 'POST', body: { id: ID, disqualifiee: true }, origin,
    })).status, 403);
  }
  for (const body of [{ id: 'x', disqualifiee: true }, { id: ID, disqualifiee: 'oui' }, { id: ID, disqualifiee: true, prix: 1 }]) {
    assert.equal((await request(server, '/api/dashboard/disqualification', { method: 'POST', body, origin: SELF })).status, 400);
  }
  assert.deepEqual(calls, [[ID, true]]);
});

test('routes des réservations bloquées : extension seule, corps stricts', async () => {
  const calls = [];
  const server = createNegotiationServer({
    extensionOrigin: EXTENSION,
    listerReservations: async () => [{ url_annonce: AD }],
    resoudreReservation: async (...args) => { calls.push(args); return { resolue: true }; },
  });
  const post = (path, body, origin = EXTENSION) => request(server, `/api/annonces/${path}`, { method: 'POST', body, origin });
  assert.deepEqual(await (await post('reservations', {})).json(), { reservations: [{ url_annonce: AD }] });
  assert.deepEqual(await (await post('reservation-resoudre', { url_annonce: AD, resultat: 'non_envoye' })).json(), { resolue: true });
  for (const origin of [undefined, SELF]) {
    assert.equal((await post('reservations', {}, origin ?? null)).status, 403);
    assert.equal((await post('reservation-resoudre', { url_annonce: AD, resultat: 'envoye' }, origin ?? null)).status, 403);
  }
  for (const body of [{ url_annonce: AD, resultat: 'peut_etre' }, { url_annonce: AD }, { url_annonce: AD, resultat: 'envoye', x: 1 }]) {
    assert.equal((await post('reservation-resoudre', body)).status, 400);
  }
  assert.equal((await post('reservations', { x: 1 })).status, 400);
  assert.deepEqual(calls, [[AD, 'non_envoye']]);
});

test('plus aucun serveur de fichiers python, et le dashboard n’utilise plus la clé anon', () => {
  assert.doesNotMatch(read('package.json'), /http\.server/);
  assert.doesNotMatch(read('scripts/dev.sh'), /http\.server|8834/);
  assert.doesNotMatch(read('dashboard.html'), /ANON_KEY|54321|rest\/v1/);
  assert.match(read('package.json'), /"engines"/);
});

test('aucun nom ni adresse de propriétaire en dur, et les données d’exemple sont fictives', () => {
  // Seules adresses admises : example.com et l’expéditeur de test de Resend.
  for (const path of ['scripts/negotiate-server.js', 'negociation.html', 'scripts/import-conversations.js']) {
    const adresses = read(path).match(/[\w.+-]+@(?:[\w-]+\.)+[a-z]{2,}/gi) ?? [];
    assert.deepEqual(adresses.filter((a) => !/@example\.com$|^onboarding@resend\.dev$/.test(a)), [], path);
  }
  // Sans réglage, aucun nom : le repli neutre est utilisé.
  assert.equal(DEFAULT_SETTINGS.ownerName, '');
  assert.equal(ownerLabel(DEFAULT_SETTINGS), 'l\'utilisateur');
  assert.equal(existsSync(new URL('../scripts/data/conversations-2026-09-25.json', import.meta.url)), false);
  const example = JSON.parse(read('scripts/data/conversations-exemple.json'));
  assert.ok(example.every((c) => /Fictif/.test(c.vendeur)));
});
