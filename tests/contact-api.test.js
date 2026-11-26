import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../extension/sw/api.js';

function client(fetch) {
  return createApi({ fetch });
}

test('shortlist requests the default seller limit and preserves the returned rows', async () => {
  const calls = [];
  const annonces = [{ url_annonce: 'https://www.leboncoin.fr/ad/consoles/1', vendeur: 'Alice' }];
  const api = client(async (...args) => { calls.push(args); return Response.json({ annonces }); });
  assert.deepEqual(await api.shortlist(), { annonces });
  assert.equal(calls[0][0], 'http://127.0.0.1:8835/api/annonces/shortlist?limite=50');
  await api.shortlist({ limite: 12 });
  assert.equal(calls[1][0], 'http://127.0.0.1:8835/api/annonces/shortlist?limite=12');
  await api.shortlist({ prixMax: 300 });
  assert.equal(calls.at(-1)[0], 'http://127.0.0.1:8835/api/annonces/shortlist?limite=50&prix_max=300');
});

test('contact tracking posts the exact ad URL and returns its persisted timestamp', async () => {
  let call;
  const api = client(async (...args) => { call = args; return Response.json({ contacte_le: '2026-09-26T12:00:00.000Z' }); });
  assert.deepEqual(await api.marquerContactee('https://www.leboncoin.fr/ad/consoles/1'), { contacte_le: '2026-09-26T12:00:00.000Z' });
  assert.equal(call[0], 'http://127.0.0.1:8835/api/annonces/contactee');
  assert.equal(call[1].method, 'POST');
  assert.equal(new Headers(call[1].headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(call[1].body), { url_annonce: 'https://www.leboncoin.fr/ad/consoles/1' });
});

test('disabled ad tracking posts the exact ad URL', async () => {
  let call;
  const api = client(async (...args) => { call = args; return Response.json({ marquee: true }); });
  assert.deepEqual(await api.marquerIntrouvable('https://www.leboncoin.fr/ad/consoles/1'), { marquee: true });
  assert.equal(call[0], 'http://127.0.0.1:8835/api/annonces/introuvable');
  assert.equal(call[1].method, 'POST');
  assert.deepEqual(JSON.parse(call[1].body), { url_annonce: 'https://www.leboncoin.fr/ad/consoles/1' });
});

test('terminal contact errors post the exact ad URL and closed error code', async () => {
  let call;
  const payload = { contact_erreur_code: 'formulaire_absent', contact_erreur_le: '2026-09-26T12:00:00.000Z' };
  const api = client(async (...args) => { call = args; return Response.json(payload); });
  assert.deepEqual(await api.marquerErreurContact('https://www.leboncoin.fr/ad/consoles/1', 'formulaire_absent'), payload);
  assert.equal(call[0], 'http://127.0.0.1:8835/api/annonces/contact-erreur');
  assert.equal(call[1].method, 'POST');
  assert.deepEqual(JSON.parse(call[1].body), {
    url_annonce: 'https://www.leboncoin.fr/ad/consoles/1', code: 'formulaire_absent',
  });
});

test('GET and POST failures keep the actionable local-server error', async () => {
  const api = client(async () => { throw new Error('ECONNREFUSED'); });
  for (const operation of [() => api.shortlist(), () => api.marquerContactee('ad'), () => api.marquerIntrouvable('ad'),
    () => api.marquerErreurContact('ad', 'formulaire_absent')]) {
    await assert.rejects(operation(), (error) => error.name === 'ServerUnreachableError' && /npm run dev/.test(error.message));
  }
});

test('HTTP errors expose server text or fall back to the status for invalid JSON', async () => {
  for (const [body, status, expected] of [['{"error":"Origine refusée."}', 403, /Origine refusée/], ['not JSON', 500, /HTTP 500/], ['null', 502, /HTTP 502/]]) {
    const api = client(async () => new Response(body, { status }));
    await assert.rejects(api.shortlist(), expected);
    await assert.rejects(api.marquerContactee('ad'), expected);
    await assert.rejects(api.marquerIntrouvable('ad'), expected);
    await assert.rejects(api.marquerErreurContact('ad', 'formulaire_absent'), expected);
  }
});
