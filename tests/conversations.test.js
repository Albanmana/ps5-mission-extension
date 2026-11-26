import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listConversations,
  markConversationError,
  markConversationHandled,
  markConversationSent,
  reserveConversationTurn,
  upsertConversation,
  validateConversationSnapshot,
} from '../scripts/lib/conversations.js';

const URL = 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101';
const AD = 'https://www.leboncoin.fr/ad/consoles/1000000002';
const FP = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const snapshot = {
  url_conversation: URL,
  url_annonce: AD,
  vendeur: ' VendeurAlpha ',
  annonce_titre: ' PS5 Slim ',
  annonce_prix_eur: 280,
  messages: [
    { expediteur: 'moi', contenu: 'Bonjour', envoye_le: null, type: 'texte' },
    { expediteur: 'vendeur', contenu: 'Oui disponible', envoye_le: '2026-09-26T01:00:00.000Z', type: 'texte' },
  ],
};

function clientWith(...responses) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      return responses.shift() ?? { rows: [], rowCount: 0 };
    },
  };
}

test('validateConversationSnapshot normalise le fil réel et refuse les destinations étrangères', () => {
  const value = validateConversationSnapshot(snapshot);
  assert.equal(value.url_conversation, URL);
  assert.equal(value.url_annonce, AD);
  assert.equal(value.vendeur, 'VendeurAlpha');
  assert.equal(value.annonce_titre, 'PS5 Slim');
  assert.equal(value.messages.length, 2);
  assert.equal(value.dernier_message_de, 'vendeur');
  assert.equal(value.dernier_message, 'Oui disponible');
  assert.equal(value.dernier_message_le, '2026-09-26T01:00:00.000Z');
  assert.throws(
    () => validateConversationSnapshot({ ...snapshot, url_conversation: 'https://evil.example/messages/id/x' }),
    /conversation leboncoin/i,
  );
  assert.throws(
    () => validateConversationSnapshot({ ...snapshot, messages: [{ expediteur: 'pirate', contenu: 'x' }] }),
    /expediteur/i,
  );
});

test('upsertConversation rattache l’annonce sans écraser l’état d’automatisation', async () => {
  const client = clientWith(
    { rows: [] },
    { rows: [{ id: 'ad-id' }] },
    { rows: [{ id: 'conversation-id', url_conversation: URL }] },
  );
  const result = await upsertConversation(client, snapshot);
  assert.equal(result.id, 'conversation-id');
  assert.equal(client.calls.length, 3);
  assert.match(client.calls[1].text, /insert into public\.annonces/i);
  assert.match(client.calls[2].text, /insert into public\.conversations/i);
  assert.doesNotMatch(client.calls[2].text, /dernier_message_fingerprint\s*=/i);
  assert.deepEqual(client.calls[2].params.slice(0, 5), ['ad-id', URL, 'VendeurAlpha', 'PS5 Slim', 'en_attente_moi']);
});

test('reserveConversationTurn réserve un nouveau tour mais rend un doublon persistant sans mutation', async () => {
  const reservedClient = clientWith({ rows: [{ id: 'conversation-id', dernier_message_fingerprint: FP }] });
  assert.deepEqual(await reserveConversationTurn(reservedClient, URL, FP), { reserved: true, id: 'conversation-id' });
  assert.match(reservedClient.calls[0].text, /generation_echec/i);
  assert.deepEqual(reservedClient.calls[0].params, [URL, FP]);

  const duplicateClient = clientWith({ rows: [] });
  assert.deepEqual(await reserveConversationTurn(duplicateClient, URL, FP), { reserved: false, id: null });
});

test('les issues envoyé, handoff et erreur ont des mutations distinctes et paramétrées', async () => {
  const sent = clientWith({ rows: [{ id: 'c1', dernier_envoi_le: '2026-09-26T02:00:00.000Z' }] });
  const sentResult = await markConversationSent(sent, {
    urlConversation: URL,
    fingerprint: FP,
    message: '340 ça vous va ?',
    offreProposeeEur: 340,
    date: new Date('2026-09-26T02:00:00.000Z'),
  });
  assert.equal(sentResult.id, 'c1');
  assert.match(sent.calls[0].text, /jsonb.*message|messages.*jsonb/i);
  assert.match(sent.calls[0].text, /'contenu',\s*\$3::text/i);
  assert.match(sent.calls[0].text, /dernier_message\s*=\s*\$3::text/i);
  assert.match(sent.calls[0].text, /'envoye_le',\s*\(\$5::timestamptz\)::text/i);
  assert.match(sent.calls[0].text, /dernier_message_le\s*=\s*\$5::timestamptz/i);
  assert.match(sent.calls[0].text, /dernier_envoi_le\s*=\s*\$5::timestamptz/i);
  assert.match(sent.calls[0].text, /traite_le\s*=\s*\$5::timestamptz/i);
  assert.deepEqual(sent.calls[0].params.slice(0, 4), [URL, FP, '340 ça vous va ?', 340]);

  const handled = clientWith({ rows: [{ id: 'c1', traite_le: '2026-09-26T02:01:00.000Z' }] });
  assert.equal((await markConversationHandled(handled, URL, FP)).id, 'c1');
  assert.match(handled.calls[0].text, /traite_le/i);
  assert.doesNotMatch(handled.calls[0].text, /dernier_envoi_le\s*=/i);

  const failed = clientWith({ rows: [{ id: 'c1', automation_erreur_code: 'envoi_incertain' }] });
  assert.equal((await markConversationError(failed, URL, FP, 'envoi_incertain')).automation_erreur_code, 'envoi_incertain');
  assert.deepEqual(failed.calls[0].params.slice(0, 3), [URL, FP, 'envoi_incertain']);
});

test('listConversations rend les réponses vendeur en tête avec les colonnes d’automatisation', async () => {
  const client = clientWith({ rows: [{
    id: 'c1', url_conversation: URL, vendeur: 'VendeurAlpha', messages: snapshot.messages,
    dernier_message_de: 'vendeur', non_lus: 1, dernier_message_fingerprint: FP,
    titre: 'PS5 Slim', prix_eur: '280', url_annonce: AD,
  }] });
  const rows = await listConversations(client);
  assert.equal(rows[0].annonce.prix_eur, 280);
  assert.equal(rows[0].dernier_message_fingerprint, FP);
  assert.match(client.calls[0].text, /dernier_message_de = 'vendeur'/i);
});

test('upsertConversation reprend la ligne existante quand l’URL de l’annonce diffère', async () => {
  const client = clientWith({ rows: [{ url_annonce: AD }] }, { rows: [{ id: 'ad-id' }] }, { rows: [{ id: 'c1' }] });
  await upsertConversation(client, { ...snapshot, url_annonce: 'https://www.leboncoin.fr/ad/autre/1000000002?x=1' });
  assert.equal(client.calls[1].params[0], AD);
});

test('une libération tardive ne rouvre jamais un tour conclu ou incertain', async () => {
  const release = clientWith({ rows: [{ id: 'c1' }] });
  await markConversationError(release, URL, FP, 'generation_echec');
  assert.match(release.calls[0].text, /traite_le is null/);
  assert.match(release.calls[0].text,
    /automation_erreur_code is null or automation_erreur_code = 'generation_echec'/);
  const uncertain = clientWith({ rows: [{ id: 'c1' }] });
  await markConversationError(uncertain, URL, FP, 'envoi_incertain');
  assert.doesNotMatch(uncertain.calls[0].text, /traite_le is null/);
  await assert.rejects(markConversationError(clientWith({ rows: [] }), URL, FP, 'generation_echec'),
    { code: 'tour_introuvable' });
});
