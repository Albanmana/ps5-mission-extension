import assert from 'node:assert/strict';
import test from 'node:test';

import { createNegotiationServer } from '../scripts/negotiate-server.js';
import { request } from './helpers/http.js';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const URL = 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101';
const FP = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const snapshot = {
  url_conversation: URL,
  url_annonce: 'https://www.leboncoin.fr/ad/consoles/1000000002',
  vendeur: 'VendeurAlpha',
  annonce_titre: 'PS5',
  annonce_prix_eur: 280,
  messages: [{ expediteur: 'vendeur', contenu: 'Oui disponible', envoye_le: null, type: 'texte' }],
};

function fixture(overrides = {}) {
  const calls = [];
  const server = createNegotiationServer({
    extensionOrigin: EXTENSION,
    listAutomationConversations: async () => [{ id: 'c1', url_conversation: URL }],
    negotiateConversationTurn: async (payload) => {
      calls.push(['negotiate', payload]);
      return { duplicate: false, conversation: { id: 'c1' }, draft: {
        message: 'ok pour 280\npar paiement leboncoin avec envoi ça vous va ?',
        offre_proposee_eur: 280,
        offre_recue_eur: null,
        lieu_propose: null,
        arret: { doit_arreter: false, raison: null },
        notes_internes: '',
      } };
    },
    markAutomationSent: async (payload) => { calls.push(['sent', payload]); return { ok: true }; },
    markAutomationHandled: async (payload) => { calls.push(['handled', payload]); return { ok: true }; },
    markAutomationError: async (payload) => { calls.push(['error', payload]); return { ok: true }; },
    ...overrides,
  });
  return { server, calls };
}

async function call(server, path, { method = 'GET', body, origin = EXTENSION } = {}) {
  return request(server, path, { method, body, origin });
}

test('POST /api/conversations rend la liste seulement à une origine autorisée', async () => {
  const f = fixture();
  const ok = await call(f.server, '/api/conversations', { method: 'POST', body: {} });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { conversations: [{ id: 'c1', url_conversation: URL }] });
  const denied = await call(f.server, '/api/conversations', {
    method: 'POST', body: {}, origin: 'https://evil.example',
  });
  assert.equal(denied.status, 403);
  const localDenied = await call(f.server, '/api/conversations', {
    method: 'POST', body: {}, origin: 'http://127.0.0.1:8835',
  });
  assert.equal(localDenied.status, 403);
});

test('POST /api/conversations/negotiate transmet le snapshot et le fingerprint exacts', async () => {
  const f = fixture();
  const response = await call(f.server, '/api/conversations/negotiate', {
    method: 'POST', body: { snapshot, fingerprint: FP },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.duplicate, false);
  assert.deepEqual(f.calls, [['negotiate', { snapshot: {
    url_conversation: URL,
    url_annonce: 'https://www.leboncoin.fr/ad/consoles/1000000002',
    vendeur: 'VendeurAlpha',
    annonce_titre: 'PS5',
    annonce_prix_eur: 280,
    statut: 'en_attente_moi',
    messages: [{
      expediteur: 'vendeur', contenu: 'Oui disponible', envoye_le: null,
      type: 'texte', montant_eur: null, lu: null,
    }],
    dernier_message: 'Oui disponible',
    dernier_message_le: null,
    dernier_message_de: 'vendeur',
    non_lus: 1,
  }, fingerprint: FP, settings: {
    dryRun: false, ownerName: '', handoffEmail: '', goodPrice: 350, maxPrice: 370, replyScope: 'contacted',
  } }]]);
});

test('les routes sent, handled et error valident puis transmettent leur charge', async () => {
  const f = fixture();
  const sent = { url_conversation: URL, fingerprint: FP, message: 'ok pour 280', offre_proposee_eur: 280 };
  assert.equal((await call(f.server, '/api/conversations/sent', { method: 'POST', body: sent })).status, 200);
  assert.equal((await call(f.server, '/api/conversations/handled', { method: 'POST', body: {
    url_conversation: URL, fingerprint: FP,
  } })).status, 200);
  assert.equal((await call(f.server, '/api/conversations/error', { method: 'POST', body: {
    url_conversation: URL, fingerprint: FP, code: 'envoi_incertain',
  } })).status, 200);
  assert.deepEqual(f.calls, [
    ['sent', sent],
    ['handled', { url_conversation: URL, fingerprint: FP }],
    ['error', { url_conversation: URL, fingerprint: FP, code: 'envoi_incertain' }],
  ]);
});

test('les routes conversation refusent les JSON incomplets sans appeler les mutations', async () => {
  const f = fixture();
  for (const path of ['negotiate', 'sent', 'handled', 'error']) {
    const response = await call(f.server, `/api/conversations/${path}`, { method: 'POST', body: {} });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(f.calls, []);
});

test('une panne de génération reste réessayable et ne révèle pas sa cause', async () => {
  const f = fixture({ negotiateConversationTurn: async () => { throw new Error('OpenRouter secret-value'); } });
  const response = await call(f.server, '/api/conversations/negotiate', {
    method: 'POST', body: { snapshot, fingerprint: FP },
  });
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.retryable, true);
  assert.doesNotMatch(JSON.stringify(payload), /secret-value/);
});

test('le code d’une panne du modèle est transmis à l’extension', async () => {
  const f = fixture({ negotiateConversationTurn: async () => {
    throw Object.assign(new Error('OpenRouter secret-value'), { code: 'modele_indisponible' });
  } });
  const response = await call(f.server, '/api/conversations/negotiate', {
    method: 'POST', body: { snapshot, fingerprint: FP },
  });
  assert.equal((await response.json()).code, 'modele_indisponible');
});

test('une base injoignable donne le code stable base_indisponible, sans détail interne', async () => {
  const pannes = [
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:54322'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
    Object.assign(new Error('the database system is starting up'), { code: '57P03' }),
    Object.assign(new Error('connexion perdue'), { code: '08006' }),
    new Error('Connection terminated unexpectedly'),
    new Error('timeout exceeded when trying to connect'),
  ];
  for (const panne of pannes) {
    for (const path of ['negotiate', 'error']) {
      const f = fixture({
        logger: { error() {} },
        negotiateConversationTurn: async () => { throw panne; },
        markAutomationError: async () => { throw panne; },
      });
      const response = await call(f.server, `/api/conversations/${path}`, {
        method: 'POST',
        body: path === 'negotiate' ? { snapshot, fingerprint: FP }
          : { url_conversation: URL, fingerprint: FP, code: 'generation_echec' },
      });
      const payload = await response.json();
      assert.equal(payload.code, 'base_indisponible', `${path} ${panne.message}`);
      assert.doesNotMatch(JSON.stringify(payload), /ECONNREFUSED|54322|terminat/i);
    }
  }
  // Une erreur SQL ordinaire ne passe pas pour une panne de la base.
  const f = fixture({ logger: { error() {} },
    negotiateConversationTurn: async () => { throw Object.assign(new Error('violates check'), { code: '23514' }); } });
  const response = await call(f.server, '/api/conversations/negotiate', { method: 'POST', body: { snapshot, fingerprint: FP } });
  assert.equal((await response.json()).code, undefined);
});
