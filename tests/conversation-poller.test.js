import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

import { createConversationPoller } from '../extension/sw/conversation-poller.js';
import { CONVERSATION_ALARM, CONVERSATION_STATE_KEY } from '../extension/sw/conversation-state.js';
import { createApi } from '../extension/sw/api.js';
import { createNegotiationServer } from '../scripts/negotiate-server.js';
import { markConversationHandled } from '../scripts/lib/conversations.js';
import { request } from './helpers/http.js';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const URL = 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101';
const FP = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const snapshot = {
  url_conversation: URL,
  url_annonce: 'https://www.leboncoin.fr/ad/consoles/1000000002',
  vendeur: 'VendeurAlpha', annonce_titre: 'PS5', annonce_prix_eur: 280,
  messages: [
    { expediteur: 'moi', contenu: 'Bonjour', envoye_le: null, type: 'texte' },
    { expediteur: 'vendeur', contenu: 'Oui disponible', envoye_le: null, type: 'texte' },
  ],
  dernier_message_vendeur: 'Oui disponible', non_lus: 1,
};
const draft = {
  message: 'ok pour 280\npar paiement leboncoin avec envoi ça vous va ?',
  offre_proposee_eur: 280,
  offre_recue_eur: null,
  lieu_propose: null,
  arret: { doit_arreter: false, raison: null },
  notes_internes: '',
};

function fixture({ tabs = [{ id: 7, url: 'https://www.leboncoin.fr/messages', status: 'complete' }],
  unread = { url_conversation: URL, preview: 'PS5 Oui disponible VendeurAlpha', source: 'first_changed' }, thread = snapshot,
  unreadResults, threadResults, hashFn,
  send = { ok: true, clique: true, confirme: true }, negotiate, sentError,
  handledError, failInboxAfterHandoff = false,
  updateStatus = 'complete', pageReady = true,
  nowAt = '2026-09-26T10:00:00+02:00', storedState, legacy = false, settings = { dryRun: false },
  handoffImpl, sendImpl, errorImpl, onSleep, onList, notificationError, apercus = { lignes: [] },
  journalEnvois } = {}) {
  // Par défaut : autopilote activé volontairement et envois réels.
  const initial = legacy ? storedState : { activationVersion: 2, enabled: true, status: 'idle', ...storedState };
  const storage = initial ? { [CONVERSATION_STATE_KEY]: initial } : {};
  if (settings) storage.ps5_settings = settings;
  const logged = [];
  let nowMs = new Date(nowAt).getTime();
  const effects = { reloads: [], baselines: 0, logged, sends: [], alarms: [], clears: [], updates: [], injections: [], listArguments: [], api: [], notifications: [], broadcasts: [], sleeps: [] };
  const activeAlarms = new Map();
  const tabRows = tabs.map((tab) => ({ ...tab }));
  const injected = new Map();
  let threadReadIndex = 0;
  let listReadIndex = 0;
  const chrome = {
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(value) { Object.assign(storage, value); },
    } },
    alarms: {
      create(name, info) {
        effects.alarms.push({ name, info });
        activeAlarms.set(name, { name, scheduledTime: info.when });
      },
      async get(name) { return activeAlarms.get(name); },
      async clear(name) { effects.clears.push(name); activeAlarms.delete(name); return true; },
    },
    tabs: {
      async query() { return tabRows; },
      async update(id, patch) {
        if (failInboxAfterHandoff && patch.url === 'https://www.leboncoin.fr/messages'
          && effects.api.some(([name]) => name === 'handoff')) {
          throw new Error('Navigation retour impossible');
        }
        effects.updates.push({ id, patch });
        const tab = tabRows.find((row) => row.id === id);
        Object.assign(tab, patch, { status: updateStatus });
        return { ...tab };
      },
      async get(id) { return { ...tabRows.find((row) => row.id === id) }; },
      async reload(id) { effects.reloads.push(id); },
    },
    scripting: { async executeScript(options) {
      if (options.func && typeof options.args?.[0] === 'string' && options.args[0].startsWith('https://')) {
        return [{ result: pageReady }];
      }
      if (options.files) {
        const kind = options.files[0];
        injected.set(options.target.tabId, kind);
        effects.injections.push(kind);
        return [];
      }
      const kind = injected.get(options.target.tabId);
      if (kind.endsWith('messages-list.js')) {
        if (options.args?.length === 0) {
          effects.baselines += 1;
          return [{ result: apercus }];
        }
        effects.listArguments.push(options.args ?? []);
        await onList?.();
        if (unread instanceof Error) throw unread;
        const result = unreadResults
          ? unreadResults[Math.min(listReadIndex++, unreadResults.length - 1)]
          : typeof unread === 'function' ? unread() : unread;
        return [{ result }];
      }
      if (kind.endsWith('messages-thread.js')) {
        const result = threadResults
          ? threadResults[Math.min(threadReadIndex++, threadResults.length - 1)]
          : typeof thread === 'function' ? thread() : thread;
        return [{ result }];
      }
      if (kind.endsWith('send-message.js')) {
        effects.sends.push(options.args);
        if (sendImpl) return [{ result: await sendImpl(options.args) }];
        if (send instanceof Error) throw send;
        return [{ result: send }];
      }
      throw new Error(`Injection inattendue: ${kind}`);
    } },
    notifications: { async create(options) { effects.notifications.push(options); if (notificationError) throw notificationError; return 'id'; } },
    runtime: { async sendMessage(message) { effects.broadcasts.push(message); } },
  };
  const api = {
    async conversationNegotiate(value, fingerprint, used) {
      effects.api.push(['negotiate', value, fingerprint, used]);
      if (typeof negotiate === 'function') return negotiate(value, fingerprint);
      return negotiate ?? { duplicate: false, conversation: { id: 'c1' }, draft };
    },
    async conversationSent(value) {
      effects.api.push(['sent', value]);
      if (sentError) throw sentError;
      return { ok: true };
    },
    async conversationHandled(value) {
      effects.api.push(['handled', value]);
      if (typeof handledError === 'function') await handledError();
      else if (handledError) throw handledError;
      return { ok: true };
    },
    async conversationError(value) { effects.api.push(['error', value]); await errorImpl?.(value); return { ok: true }; },
    async handoff(value) {
      effects.api.push(['handoff', value]);
      return handoffImpl ? handoffImpl(value) : { notified: true, email_id: 'mail-1' };
    },
    async conversations() { return { conversations: [] }; },
  };
  const poller = createConversationPoller({
    chrome, api, now: () => nowMs, journalEnvois,
    random: () => 0.5, sleep: async (ms) => { effects.sleeps.push(ms); await onSleep?.(ms); }, hash: hashFn ?? (async () => FP),
    logger: { log() {}, logErreur(event, error) { logged.push([event, error?.message]); } },
  });
  return { poller, effects, storage, setNow(value) { nowMs = new Date(value).getTime(); } };
}

test('sans onglet Messages le cycle attend sans ouvrir d’onglet et reprogramme', async () => {
  const f = fixture({ tabs: [] });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.status, 'idle');
  assert.equal(state.lastResult, 'waiting_for_tab');
  assert.equal(f.effects.updates.length, 0);
  assert.equal(f.effects.alarms.at(-1).name, CONVERSATION_ALARM);
});

test('une alarme livrée hors plage ne lit ni n’envoie et attend le prochain matin', async () => {
  const f = fixture({ nowAt: '2026-09-26T23:05:00+02:00' });
  await f.poller.initialize();
  const state = await f.poller.onAlarm({ name: CONVERSATION_ALARM });
  assert.equal(state.lastResult, 'outside_hours');
  assert.deepEqual(f.effects.api, []);
  assert.deepEqual(f.effects.injections, []);
  const next = new Date(f.effects.alarms.at(-1).info.when);
  assert.equal(next.getDate(), 27);
  assert.equal(next.getHours(), 8);
});

test('une vérification manuelle explicite traite toute la file même hors plage', async () => {
  const f = fixture({
    nowAt: '2026-09-26T23:05:00+02:00',
    unreadResults: [
      { url_conversation: URL, preview: 'PS5 Oui disponible VendeurAlpha', source: 'unread' },
      null,
    ],
  });
  await f.poller.initialize();
  const state = await f.poller.runNow({ manual: true });

  assert.equal(state.lastResult, 'batch_complete');
  assert.equal(state.lastBatchProcessed, 1);
  assert.equal(f.effects.api.filter(([name]) => name === 'sent').length, 1);
});

test('sans non-lu le cycle ne contacte ni OpenRouter ni le bouton Envoyer', async () => {
  const f = fixture({ unread: null });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastResult, 'no_unread');
  assert.deepEqual(f.effects.api, []);
  assert.equal(f.effects.injections.includes('content/send-message.js'), false);
});

const OLD = 'https://www.leboncoin.fr/messages/id/eeeeeeee-1111-2222-3333-ffffffffffff';
const lignes = { lignes: [
  { url_conversation: URL, preview: 'PS5 Oui disponible VendeurAlpha', non_lu: true },
  { url_conversation: OLD, preview: 'PS5 Ancienne réponse VendeurTheta', non_lu: false },
] };

for (const [nom, lancer] of [
  ['au premier passage', (poller) => poller.runNow()],
  ['par « Vérifier maintenant »', (poller) => poller.runNow({ manual: true })],
]) {
  test(`après activation, le relevé initial ${nom} ne laisse à traiter que les non-lus et les changements`, async () => {
    const f = fixture({ legacy: true, apercus: lignes, unread: null });
    await f.poller.initialize();
    await f.poller.resume();
    await lancer(f.poller);
    assert.equal(f.effects.baselines, 1);
    const [previous] = f.effects.listArguments[0];
    assert.equal(previous[URL].preview, null, 'un non-lu reste à traiter même une fois ouvert');
    assert.equal(previous[OLD].preview, 'PS5 Ancienne réponse VendeurTheta');
    assert.deepEqual(f.effects.api, []);
    await f.poller.runNow();
    assert.equal(f.effects.baselines, 1);
    // Une réactivation refait le relevé ; réactiver un autopilote déjà actif, non.
    await f.poller.resume();
    await f.poller.runNow();
    assert.equal(f.effects.baselines, 1);
    await f.poller.pause();
    await f.poller.resume();
    await f.poller.runNow();
    assert.equal(f.effects.baselines, 2);
  });
}

test('sans aucune ligne affichée le relevé initial reste à faire et rien n’est ouvert', async () => {
  for (const apercus of [{ lignes: [] }, null]) {
    const f = fixture({ legacy: true, apercus });
    await f.poller.initialize();
    await f.poller.resume();
    const state = await f.poller.runNow({ manual: true });
    assert.equal(state.baselinePending, true);
    assert.equal(state.lastResult, apercus ? 'no_unread' : null);
    assert.deepEqual(f.effects.listArguments, []);
    assert.deepEqual(f.effects.api, []);
  }
});

test('un passage planifié recharge la messagerie déjà affichée, un lot manuel une seule fois', async () => {
  const f = fixture({ unread: null });
  await f.poller.initialize();
  await f.poller.runNow();
  assert.deepEqual(f.effects.reloads, [7]);
  await f.poller.runNow({ manual: true });
  assert.deepEqual(f.effects.reloads, [7, 7]);
  const elsewhere = fixture({ unread: null, tabs: [{ id: 7, url: URL, status: 'complete' }] });
  await elsewhere.poller.initialize();
  await elsewhere.poller.runNow();
  assert.deepEqual(elsewhere.effects.reloads, [], 'la navigation charge déjà une page fraîche');
});

test('la simulation activée pendant la génération retient l’e-mail de reprise', async () => {
  let f;
  f = fixture({ negotiate() {
    f.storage.ps5_settings = { dryRun: true };
    return { duplicate: false, conversation: { id: 'c1' }, draft: { ...draft, message: null,
      offre_proposee_eur: null, arret: { doit_arreter: true, raison: 'paiement_leboncoin_accepte' } } };
  } });
  await f.poller.initialize();
  await f.poller.runNow();
  assert.deepEqual(f.effects.api.map(([name]) => name), ['negotiate']);
});

test('une vérification manuelle vide toutes les réponses vendeurs disponibles', async () => {
  const secondUrl = 'https://www.leboncoin.fr/messages/id/cccccccc-1111-2222-3333-dddddddddddd';
  const secondSnapshot = { ...snapshot, url_conversation: secondUrl,
    messages: snapshot.messages.map((message) => ({ ...message })),
    dernier_message_vendeur: 'Toujours disponible' };
  const f = fixture({
    unreadResults: [
      { url_conversation: URL, preview: 'PS5 Oui disponible VendeurAlpha', source: 'unread' },
      { url_conversation: secondUrl, preview: 'PS5 Toujours disponible VendeurBeta', source: 'unread' },
      null,
    ],
    threadResults: [snapshot, snapshot, secondSnapshot],
    hashFn: async (value) => value.url_conversation === URL ? FP : 'b'.repeat(64),
  });
  await f.poller.initialize();
  const state = await f.poller.runNow({ manual: true });

  assert.equal(state.lastResult, 'batch_complete');
  assert.equal(state.lastBatchProcessed, 2);
  assert.equal(f.effects.api.filter(([name]) => name === 'sent').length, 2);
});

test('une vérification manuelle ne recharge pas la boîte déjà affichée entre deux passages', async () => {
  const f = fixture({ unreadResults: [
    { url_conversation: URL, preview: 'PS5 Oui disponible VendeurAlpha', source: 'manual_scan' },
    null,
  ] });
  await f.poller.initialize();

  await f.poller.runNow({ manual: true });

  const inboxNavigations = f.effects.updates.filter(({ patch }) => patch.url === 'https://www.leboncoin.fr/messages');
  assert.equal(inboxNavigations.length, 1);
});

test('une vérification manuelle ne reste pas bloquée sur un fil déjà visité', async () => {
  const secondUrl = 'https://www.leboncoin.fr/messages/id/cccccccc-1111-2222-3333-dddddddddddd';
  const mine = { ...snapshot, messages: [
    { expediteur: 'vendeur', contenu: 'Oui disponible', envoye_le: null, type: 'texte' },
    { expediteur: 'moi', contenu: '340 ça vous va ?', envoye_le: null, type: 'texte' },
  ] };
  const secondSnapshot = { ...snapshot, url_conversation: secondUrl };
  const f = fixture({
    unreadResults: [
      { url_conversation: URL, preview: 'PS5 Notre réponse VendeurZeta', source: 'first_changed' },
      { url_conversation: secondUrl, preview: 'Console ps5 Oui disponible VendeurEta', source: 'first_changed' },
      null,
    ],
    threadResults: [mine, mine, secondSnapshot],
  });
  await f.poller.initialize();
  const state = await f.poller.runNow({ manual: true });

  assert.equal(state.lastResult, 'batch_complete');
  assert.equal(state.lastBatchProcessed, 1);
  assert.deepEqual(f.effects.listArguments.map((args) => args[1]), [[], [URL], [URL, secondUrl]]);
  assert.ok(f.effects.sleeps.filter((ms) => ms === 500).length >= 2);
});

test('un fil dont la dernière bulle est la mienne ne répond jamais à un ancien tour vendeur', async () => {
  const f = fixture({ thread: {
    ...snapshot,
    messages: [
      { expediteur: 'vendeur', contenu: 'Oui disponible', envoye_le: null, type: 'texte' },
      { expediteur: 'moi', contenu: 'ok pour 280', envoye_le: null, type: 'texte' },
    ],
    dernier_message_vendeur: 'Oui disponible',
    non_lus: 0,
  } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastResult, 'no_seller_message');
  assert.deepEqual(f.effects.api, []);
  assert.equal(f.effects.injections.includes('content/send-message.js'), false);
});

test('un tour vendeur est généré, envoyé une fois, persisté puis ramène à la liste', async () => {
  const f = fixture();
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.status, 'idle');
  assert.equal(state.lastResult, 'sent');
  assert.equal(state.processingFingerprint, null);
  assert.ok(state.processedFingerprints[FP]);
  assert.equal(f.effects.api.filter(([name]) => name === 'negotiate').length, 1);
  assert.equal(f.effects.api.filter(([name]) => name === 'sent').length, 1);
  assert.equal(f.effects.injections.filter((name) => name === 'content/send-message.js').length, 1);
  assert.equal(f.effects.updates.at(-1).patch.url, 'https://www.leboncoin.fr/messages');
  assert.equal(f.storage[CONVERSATION_STATE_KEY].lastResult, 'sent');
});

test('un DOM prêt reste exploitable quand Chrome laisse la messagerie en loading', async () => {
  const f = fixture({ updateStatus: 'loading', pageReady: true });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.status, 'idle');
  assert.equal(state.lastResult, 'sent');
  assert.equal(f.effects.api.filter(([name]) => name === 'negotiate').length, 1);
  assert.equal(f.effects.api.filter(([name]) => name === 'sent').length, 1);
});

test('la lecture du fil attend que les bulles de la conversation soient rendues', async () => {
  const f = fixture({ threadResults: [
    { snapshot: null, erreur: 'Fil de conversation vide ou introuvable.' },
    { snapshot },
  ] });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastResult, 'sent');
  assert.equal(f.effects.api.filter(([name]) => name === 'negotiate').length, 1);
  assert.equal(f.effects.injections.filter((name) => name === 'content/messages-thread.js').length, 1);
});

test('un échec avant clic ne consomme pas l’aperçu vendeur et reste réessayable', async () => {
  let attempts = 0;
  const f = fixture({ negotiate() {
    attempts += 1;
    if (attempts === 1) throw new Error('OpenRouter indisponible');
    return { duplicate: false, conversation: { id: 'c1' }, draft };
  } });
  await f.poller.initialize();
  const failed = await f.poller.runNow();
  assert.equal(failed.enabled, true);
  assert.equal(failed.status, 'retrying');
  assert.equal(failed.lastError, 'generation_echec');
  assert.equal(failed.failureCount, 1);
  assert.equal(failed.observedPreviews[URL].preview, null);
  assert.equal(f.effects.alarms.at(-1).info.when, new Date('2026-09-26T10:02:00+02:00').getTime());

  const retried = await f.poller.runNow();
  assert.equal(retried.lastResult, 'sent');
  assert.equal(retried.failureCount, 0);
  assert.equal(attempts, 2);
  assert.deepEqual(f.effects.listArguments[0], [{}, [], {}]);
  assert.equal(f.effects.listArguments[1][0][URL].preview, null);
});

test('un aperçu changé même lu ouvre une seule conversation et persiste son observation', async () => {
  const f = fixture();
  await f.poller.initialize();
  await f.poller.runNow();
  const openedThreads = f.effects.updates.filter(({ patch }) => patch.url === URL);
  assert.equal(openedThreads.length, 1);
  assert.deepEqual(f.storage[CONVERSATION_STATE_KEY].observedPreviews[URL], {
    preview: 'PS5 Oui disponible VendeurAlpha',
    observedAt: new Date('2026-09-26T10:00:00+02:00').getTime(),
  });
  assert.deepEqual(f.effects.listArguments[0], [{}, [], {}]);
});

test('un doublon serveur ne tape rien et est mémorisé localement', async () => {
  const f = fixture({ negotiate: { duplicate: true } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastResult, 'duplicate');
  assert.ok(state.processedFingerprints[FP]);
  assert.equal(f.effects.injections.includes('content/send-message.js'), false);
});

test('un point d’arrêt notifie, finalise et n’écrit rien dans la page', async () => {
  const stopped = { ...draft, message: null, offre_proposee_eur: null,
    arret: { doit_arreter: true, raison: 'paiement_leboncoin_accepte' } };
  const f = fixture({ negotiate: { duplicate: false, conversation: { id: 'c1' }, draft: stopped } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastResult, 'handoff');
  assert.deepEqual(f.effects.api.map(([name]) => name), ['negotiate', 'handoff', 'handled']);
  assert.equal(f.effects.injections.includes('content/send-message.js'), false);
});

test('un clic non confirmé est consommé, signalé et ne désactive pas l’autopilote', async () => {
  const f = fixture({ send: { ok: false, clique: true, confirme: false, erreurCode: 'envoi_incertain' } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.enabled, true);
  assert.equal(state.status, 'retrying');
  assert.equal(state.lastError, 'envoi_incertain');
  assert.equal(state.lastResult, 'requires_review');
  assert.equal(state.processingFingerprint, null);
  assert.ok(state.processedFingerprints[FP]);
  assert.equal(f.effects.alarms.at(-1).info.when, new Date('2026-09-26T10:02:00+02:00').getTime());
  assert.equal(f.effects.updates.at(-1).patch.url, URL);
  assert.deepEqual(f.effects.api.map(([name]) => name), ['negotiate', 'error']);
});

test('un formulaire absent avant tout clic reste réessayable et ne consomme pas le vendeur', async () => {
  const f = fixture({ send: { ok: false, clique: false, confirme: false, erreurCode: 'formulaire_absent' } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.enabled, true);
  assert.equal(state.status, 'retrying');
  assert.equal(state.lastError, 'generation_echec');
  assert.equal(state.processingFingerprint, null);
  assert.equal(state.processedFingerprints[FP], undefined);
  assert.equal(state.observedPreviews[URL].preview, null);
  assert.deepEqual(f.effects.api.map(([name]) => name), ['negotiate', 'error']);
  assert.equal(f.effects.api.at(-1)[1].code, 'generation_echec');
});

test('un blocage anti-bot garde l’autopilote actif et planifie une reprise longue', async () => {
  const f = fixture({ unread: new Error('Accès temporairement restreint') });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.enabled, true);
  assert.equal(state.status, 'blocked');
  assert.equal(state.lastError, 'bloque');
  assert.equal(f.effects.alarms.at(-1).info.when, new Date('2026-09-26T11:00:00+02:00').getTime());
});

test('une persistance en panne après confirmation consomme le fingerprint et poursuit en reprise', async () => {
  const f = fixture({ sentError: new Error('SQL down') });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.enabled, true);
  assert.equal(state.status, 'retrying');
  assert.equal(state.lastError, 'persistance_echec');
  assert.equal(state.lastResult, 'requires_review');
  assert.equal(state.processingFingerprint, null);
  assert.ok(state.processedFingerprints[FP]);
  assert.deepEqual(f.effects.api.map(([name]) => name), ['negotiate', 'sent', 'error']);
});

test('un résultat incertain n’est jamais renvoyé et le cycle suivant continue sans acquittement', async () => {
  const f = fixture({ send: { ok: false, clique: true, confirme: false, erreurCode: 'envoi_incertain' } });
  await f.poller.initialize();
  await f.poller.runNow();
  const state = await f.poller.runNow();
  assert.equal(state.status, 'idle');
  assert.equal(state.processingFingerprint, null);
  assert.ok(state.processedFingerprints[FP]);
  assert.equal(state.lastError, null);
  assert.equal(state.lastResult, 'duplicate');
  assert.equal(f.effects.injections.filter((name) => name === 'content/send-message.js').length, 1);
  assert.equal(f.effects.alarms.at(-1).name, CONVERSATION_ALARM);
});

test('un redémarrage reprogramme un état bloqué sans modifier le choix utilisateur', async () => {
  const f = fixture({ storedState: {
    enabled: true, status: 'blocked', lastError: 'bloque', failureCount: 3,
  } });
  const state = await f.poller.initialize();
  assert.equal(state.enabled, true);
  assert.equal(state.status, 'blocked');
  assert.equal(f.effects.alarms.at(-1).info.when, new Date('2026-09-26T11:00:00+02:00').getTime());
});

test('une connexion requise reste active et réessayable', async () => {
  const f = fixture({ unread: new Error('Connexion requise') });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.enabled, true);
  assert.equal(state.status, 'retrying');
  assert.equal(state.lastError, 'connexion_requise');
  assert.equal(f.effects.alarms.at(-1).name, CONVERSATION_ALARM);
});

test('un blocage détecté avant le clic libère le fingerprint pour une reprise sûre', async () => {
  const f = fixture({ send: { ok: false, clique: false, erreur: 'Accès temporairement restreint' } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.enabled, true);
  assert.equal(state.status, 'blocked');
  assert.equal(state.processingFingerprint, null);
  assert.equal(state.processedFingerprints[FP], undefined);
  assert.equal(state.observedPreviews[URL].preview, null);
});

test('Pause est le seul contrôle qui désactive et annule la surveillance', async () => {
  const f = fixture();
  await f.poller.initialize();
  const state = await f.poller.pause();
  assert.equal(state.enabled, false);
  assert.equal(state.status, 'paused');
  assert.equal(state.nextRunAt, null);
  assert.equal(f.effects.clears.at(-1), CONVERSATION_ALARM);

  const afterAlarm = await f.poller.onAlarm({ name: CONVERSATION_ALARM });
  assert.equal(afterAlarm.enabled, false);
  assert.deepEqual(f.effects.api, []);
});

let handledAttempts = 0;
for (const [label, options, handledCalls] of [
  ['la finalisation serveur', { handledError: () => {
    handledAttempts += 1;
    if (handledAttempts === 1) throw new Error('SQL down');
  } }, 2],
  ['le retour à la liste', { failInboxAfterHandoff: true }, 1],
]) {
  test(`un handoff réussi n’est pas rejoué si ${label} échoue ensuite`, async () => {
    const stopped = { ...draft, message: null, offre_proposee_eur: null,
      arret: { doit_arreter: true, raison: 'paiement_leboncoin_accepte' } };
    const f = fixture({ ...options, negotiate: {
      duplicate: false, conversation: { id: 'c1' }, draft: stopped,
    } });
    await f.poller.initialize();
    const failed = await f.poller.runNow();
    assert.equal(failed.status, 'retrying');
    assert.equal(failed.lastError, 'persistance_echec');
    assert.equal(failed.processingFingerprint, null);
    assert.ok(failed.processedFingerprints[FP]);
    assert.equal(f.effects.api.filter(([name]) => name === 'handoff').length, 1);

    const recovered = await f.poller.runNow();
    assert.equal(f.effects.api.filter(([name]) => name === 'handoff').length, 1);
    assert.equal(f.effects.api.filter(([name]) => name === 'handled').length, handledCalls);
    assert.deepEqual(recovered.pendingHandled, {});
  });
}

test('une alarme remplacée pendant une vérification manuelle est ignorée', async () => {
  const f = fixture();
  const initialized = await f.poller.initialize();
  const staleTime = initialized.nextRunAt;
  f.setNow('2026-09-26T10:01:00+02:00');
  await f.poller.runNow();
  const current = await f.poller.state();
  assert.notEqual(current.nextRunAt, null);

  const apiCalls = f.effects.api.length;
  const updates = f.effects.updates.length;
  const state = await f.poller.onAlarm({ name: CONVERSATION_ALARM, scheduledTime: staleTime });
  assert.equal(state.nextRunAt, current.nextRunAt);
  assert.equal(f.effects.api.length, apiCalls);
  assert.equal(f.effects.updates.length, updates);
});

test('l’alarme qui réveille un nouveau service worker conserve son heure et exécute le cycle', async () => {
  const dueAt = new Date('2026-09-26T10:12:00+02:00').getTime();
  const f = fixture({ storedState: {
    enabled: true,
    status: 'idle',
    nextRunAt: dueAt,
  } });
  const initialized = await f.poller.initialize();
  assert.equal(initialized.nextRunAt, dueAt);

  await f.poller.onAlarm({ name: CONVERSATION_ALARM, scheduledTime: dueAt });
  assert.equal(f.effects.api.filter(([name]) => name === 'negotiate').length, 1);
  assert.equal(f.effects.api.filter(([name]) => name === 'sent').length, 1);
});

const stopDraft = { ...draft, message: null, offre_proposee_eur: null,
  arret: { doit_arreter: true, raison: 'paiement_leboncoin_accepte' }, notes_internes: 'Paiement accepté.' };
const stopped = { duplicate: false, conversation: { id: 'c1' }, draft: stopDraft };
const names = (f) => f.effects.api.map(([name]) => name);
const two = () => [{ url_conversation: URL, preview: 'PS5 Oui disponible VendeurAlpha', source: 'unread' }, null];

test('une mise à jour sans activationVersion 2 reste désactivée jusqu’à réactivation volontaire', async () => {
  const f = fixture({ legacy: true, storedState: { enabled: true, status: 'idle', nextRunAt: 5 } });
  const state = await f.poller.initialize();
  assert.equal(state.enabled, false);
  assert.equal(state.status, 'paused');
  assert.equal(f.effects.alarms.length, 0);
  assert.equal((await f.poller.resume()).enabled, true);
  assert.equal(f.storage[CONVERSATION_STATE_KEY].activationVersion, 2);
});

test('les réglages normalisés sont transmis à la négociation et le destinataire au script d’envoi', async () => {
  const f = fixture({ settings: { dryRun: false, goodPrice: 300, maxPrice: 320 } });
  await f.poller.initialize();
  await f.poller.runNow();
  assert.equal(f.effects.api[0][3].goodPrice, 300);
  assert.deepEqual(f.effects.sends[0], [draft.message, { expectedUrl: URL, dryRun: false, pauseSeq: 0 }]);
});

test('des réglages illisibles n’envoient rien', async () => {
  const f = fixture();
  await f.poller.initialize();
  const realGet = f.storage;
  Object.defineProperty(realGet, 'ps5_settings', { get() { throw new Error('stockage illisible'); } });
  const state = await f.poller.runNow();
  assert.equal(state.status, 'retrying');
  assert.deepEqual(f.effects.api, []);
  assert.equal(f.effects.sends.length, 0);
});

test('en simulation rien n’est enregistré, le fil reste ouvert et le lot s’arrête', async () => {
  const f = fixture({ settings: { dryRun: true }, unreadResults: two(),
    send: { ok: true, clique: false, dryRun: true },
    negotiate: { duplicate: false, dryRun: true, conversation: { id: 'c1' }, draft } });
  await f.poller.initialize();
  const state = await f.poller.runNow({ manual: true });
  assert.equal(state.lastResult, 'dry_run');
  assert.equal(state.status, 'idle');
  assert.deepEqual(names(f), ['negotiate']);
  assert.equal(state.processedFingerprints[FP], undefined);
  assert.equal(state.processingFingerprint, null);
  assert.equal(f.effects.updates.at(-1).patch.url, URL);
  assert.equal(f.effects.listArguments.length, 1);
  assert.equal(f.effects.sends[0][1].dryRun, true);
});

test('un aperçu vu en simulation redevient traitable quand les envois réels sont activés', async () => {
  let dry = true;
  const f = fixture({ settings: { dryRun: true }, sendImpl: () => (dry
    ? { ok: true, clique: false, dryRun: true } : { ok: true, clique: true, confirme: true }) });
  await f.poller.initialize();
  await f.poller.runNow();
  await f.poller.runNow();
  assert.ok(f.effects.listArguments[1][0][URL], 'reste observé tant que la simulation est active');
  dry = false;
  f.storage.ps5_settings = { dryRun: false };
  await f.poller.runNow();
  assert.equal(f.effects.listArguments[2][0][URL].preview, null);
});

test('sans réglage enregistré, le tour est réservé et la réponse part réellement', async () => {
  const f = fixture({ settings: null });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastResult, 'sent');
  assert.equal(f.effects.sends[0][1].dryRun, false);
  assert.ok(names(f).includes('sent'));
});

test('la simulation activée après la réservation libère le tour', async () => {
  const f = fixture({ send: { ok: true, clique: false, dryRun: true } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastResult, 'dry_run');
  assert.deepEqual(names(f), ['negotiate', 'error']);
  assert.equal(f.effects.api[1][1].code, 'generation_echec');
});

test('une pause avant l’appel au modèle l’annule', async () => {
  let poller;
  const f = fixture({ onSleep: async (ms) => { if (ms >= 4000) await poller.pause(); } });
  poller = f.poller;
  await poller.initialize();
  const state = await poller.runNow();
  assert.equal(state.status, 'paused');
  assert.equal(state.enabled, false);
  assert.equal(state.lastResult, 'interrompu');
  assert.deepEqual(f.effects.api, []);
  assert.equal(state.observedPreviews[URL].preview, null);
});

test('une pause pendant l’appel au modèle empêche la frappe et libère le tour', async () => {
  let poller;
  const f = fixture({ async negotiate() { await poller.pause(); return { duplicate: false, conversation: { id: 'c1' }, draft }; } });
  poller = f.poller;
  await poller.initialize();
  const state = await poller.runNow();
  assert.equal(state.status, 'paused');
  assert.equal(f.effects.sends.length, 0);
  assert.deepEqual(names(f), ['negotiate', 'error']);
  assert.equal(state.processedFingerprints[FP], undefined);
});

test('une pause pendant la frappe n’est écrasée ni par la fin ni par l’échec du cycle', async () => {
  for (const result of [
    { ok: false, clique: false, confirme: false, erreurCode: 'interrompu' },
    { ok: true, clique: true, confirme: true },
    { ok: false, clique: true, confirme: false, erreurCode: 'envoi_incertain' },
  ]) {
    let poller;
    const f = fixture({ async sendImpl() { await poller.pause(); return result; } });
    poller = f.poller;
    await poller.initialize();
    const state = await poller.runNow();
    assert.equal(state.status, 'paused');
    assert.equal(state.enabled, false);
    assert.equal(state.nextRunAt, null);
    assert.equal(f.storage[CONVERSATION_STATE_KEY].status, 'paused');
    assert.equal(f.storage[CONVERSATION_STATE_KEY].pauseSeq, 1);
  }
});

test('une pause arrête un lot manuel sans le faire boucler sur un ancien résultat', async () => {
  let poller;
  const f = fixture({ onSleep: async (ms) => { if (ms === 500) await poller.pause(); } });
  poller = f.poller;
  await poller.initialize();
  const state = await poller.runNow({ manual: true });
  assert.equal(state.status, 'paused');
  assert.equal(f.effects.listArguments.length, 1);
  assert.equal(f.effects.sleeps.filter((ms) => ms === 500).length, 1);
});

test('une pause suivie d’une reprise annule quand même le cycle en vol', async () => {
  let poller;
  const f = fixture({ async negotiate() {
    await poller.pause(); await poller.resume();
    return { duplicate: false, conversation: { id: 'c1' }, draft };
  } });
  poller = f.poller;
  await poller.initialize();
  const state = await poller.runNow();
  assert.equal(state.enabled, true);
  assert.equal(state.lastResult, 'interrompu');
  assert.equal(f.effects.sends.length, 0);
});

test('un échec d’envoi avant clic libère la réservation même si le script lève', async () => {
  const f = fixture({ send: { ok: false, clique: false, erreur: 'Accès temporairement restreint' } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.status, 'blocked');
  assert.deepEqual(names(f), ['negotiate', 'error']);
});

test('un autre destinataire interrompt sans consommer le tour', async () => {
  const f = fixture({ send: { ok: false, clique: false, confirme: false, erreurCode: 'mauvaise_conversation' } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastError, 'mauvaise_conversation');
  assert.equal(state.processedFingerprints[FP], undefined);
  assert.deepEqual(names(f), ['negotiate', 'error']);
});

test('un fil ouvert différent du candidat n’est jamais négocié', async () => {
  const f = fixture({ thread: { ...snapshot, url_conversation: 'https://www.leboncoin.fr/messages/id/cccccccc-1111-2222-3333-dddddddddddd' } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastError, 'mauvaise_conversation');
  assert.deepEqual(f.effects.api, []);
});

test('un fil encore en cours de rendu n’est pas lu partiellement', async () => {
  const partial = { ...snapshot, messages: [snapshot.messages[1]] };
  const f = fixture({ threadResults: [partial, snapshot, snapshot] });
  await f.poller.initialize();
  await f.poller.runNow();
  assert.equal(f.effects.api[0][1].messages.length, 2);
});

test('hors périmètre : rien n’est tapé ni marqué traité et le lot continue', async () => {
  const secondUrl = 'https://www.leboncoin.fr/messages/id/cccccccc-1111-2222-3333-dddddddddddd';
  const f = fixture({
    unreadResults: [two()[0], { url_conversation: secondUrl, preview: 'autre', source: 'unread' }, null],
    threadResults: [snapshot, snapshot, { ...snapshot, url_conversation: secondUrl }],
    negotiate: { ignored: true, reason: 'hors_perimetre' },
  });
  await f.poller.initialize();
  const state = await f.poller.runNow({ manual: true });
  assert.deepEqual(names(f), ['negotiate', 'negotiate']);
  assert.equal(f.effects.sends.length, 0);
  assert.equal(state.processedFingerprints[FP], undefined);
  assert.equal(state.lastResult, 'no_unread');
  f.storage.ps5_settings = { dryRun: false, replyScope: 'all' };
  await f.poller.runNow();
  assert.equal(f.effects.listArguments.at(-1)[0][URL].preview, null);
});

test('un handoff en échec est conservé, affiché, notifié et rejoué jusqu’à enregistrement', async () => {
  let attempts = 0;
  const f = fixture({ negotiate: stopped, unreadResults: [two()[0], null], handoffImpl: () => {
    attempts += 1;
    if (attempts < 3) throw new Error('502');
    return { notified: false, reason: 'email_non_configure' };
  } });
  await f.poller.initialize();
  const first = await f.poller.runNow();
  assert.equal(first.lastResult, 'handoff');
  assert.equal(first.handoffs[FP].enregistre, false);
  assert.equal(first.handoffs[FP].url_conversation, URL);
  assert.equal(f.effects.notifications.length, 1);
  assert.equal(names(f).includes('handled'), false);
  await f.poller.runNow();
  const third = await f.poller.runNow();
  assert.equal(attempts, 3);
  assert.equal(third.handoffs[FP].enregistre, true);
  assert.equal(third.handoffs[FP].notified, false);
  assert.equal(f.effects.api.find(([name]) => name === 'handoff')[1].settings.dryRun, false);
  assert.equal(names(f).filter((name) => name === 'handled').length, 1);
  await f.poller.runNow();
  assert.equal(attempts, 3);
});

test('un handoff en attente survit au redémarrage et se retire une fois traité', async () => {
  const f = fixture({ negotiate: stopped, handoffImpl: () => { throw new Error('502'); } });
  await f.poller.initialize();
  await f.poller.runNow();
  const g = fixture({ legacy: true, storedState: f.storage[CONVERSATION_STATE_KEY] });
  const restored = await g.poller.initialize();
  assert.ok(restored.handoffs[FP]);
  const state = await g.poller.dismissHandoff(FP);
  assert.deepEqual(state.handoffs, {});
  assert.equal(state.pendingHandled[URL], FP);
});

test('en simulation un handoff est seulement affiché', async () => {
  const f = fixture({ settings: null, negotiate: { ...stopped, dryRun: true } });
  await f.poller.initialize();
  await f.poller.runNow();
  const state = await f.poller.runNow();
  assert.equal(state.handoffs[FP].dryRun, true);
  assert.deepEqual(names(f), ['negotiate', 'negotiate']);
  assert.equal(state.processedFingerprints[FP], undefined);
  assert.equal(f.effects.notifications.length, 1);
  assert.deepEqual((await f.poller.dismissHandoff(FP)).pendingHandled, {});
});

test('une finalisation serveur définitivement en échec ne bloque pas les autres conversations', async () => {
  const f = fixture({ handledError: Object.assign(new Error('Finalisation de la conversation impossible.'),
    { code: 'tour_introuvable' }), storedState: { pendingHandled: { [URL]: 'b'.repeat(64) } } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastResult, 'sent');
  assert.deepEqual(state.pendingHandled, {});
});

// Traverse le vrai serveur HTTP et le vrai client de l’extension.
function realHandled(query) {
  const server = createNegotiationServer({
    extensionOrigin: EXTENSION, logger: { error() {} },
    markAutomationHandled: ({ url_conversation, fingerprint }) =>
      markConversationHandled({ query }, url_conversation, fingerprint),
  });
  const client = createApi({ fetch: (address, options) => request(server, new globalThis.URL(address).pathname, {
    method: options.method, body: JSON.parse(options.body), origin: EXTENSION,
  }) });
  return () => client.conversationHandled({ url_conversation: URL, fingerprint: 'b'.repeat(64) });
}

test('un tour inconnu du serveur est abandonné, une panne passagère reste à réessayer', async () => {
  for (const [query, remaining] of [
    [async () => ({ rows: [] }), {}],
    [async () => { throw Object.assign(new Error('base injoignable'), { code: 'ECONNREFUSED' }); },
      { [URL]: 'b'.repeat(64) }],
  ]) {
    const f = fixture({ handledError: realHandled(query), unread: null,
      storedState: { pendingHandled: { [URL]: 'b'.repeat(64) } } });
    await f.poller.initialize();
    assert.deepEqual((await f.poller.runNow()).pendingHandled, remaining);
  }
});

test('les notifications utilisent une icône existante et leurs erreurs sont journalisées', async () => {
  const f = fixture({ negotiate: stopped });
  await f.poller.initialize();
  await f.poller.runNow();
  const icon = f.effects.notifications[0].iconUrl.replace(/^\//, '');
  assert.ok(existsSync(new globalThis.URL(`../extension/${icon}`, import.meta.url)));
  const g = fixture({ negotiate: stopped, notificationError: new Error('Unable to download all specified images.') });
  await g.poller.initialize();
  await g.poller.runNow();
  assert.ok(g.effects.logged.some(([event]) => event === 'conversations:notification_echec'));
});

const OTHER = 'https://www.leboncoin.fr/messages/id/cccccccc-1111-2222-3333-dddddddddddd';

// Imite la liste réelle : le premier fil changé, hors fils exclus ou écartés.
function inboxFixture() {
  const rows = [
    { url_conversation: URL, preview: 'PS5 en échec VendeurAlpha', source: 'first_changed' },
    { url_conversation: OTHER, preview: 'PS5 autre réponse VendeurBeta', source: 'first_changed' },
  ];
  const picked = [];
  const f = fixture({
    unread() {
      const [previous, excluded, ignored = {}] = f.effects.listArguments.at(-1);
      const row = rows.find((item) => !excluded.includes(item.url_conversation)
        && ignored[item.url_conversation]?.preview !== item.preview
        && previous[item.url_conversation]?.preview !== item.preview) ?? null;
      if (row) picked.push(row.url_conversation);
      return row;
    },
    thread: () => ({ ...snapshot, url_conversation: picked.at(-1) }),
    negotiate(value) {
      if (value.url_conversation === URL) throw new Error('Réponse OpenRouter invalide');
      return { ignored: true, reason: 'hors_perimetre' };
    },
  });
  return { ...f, box: { rows, picked } };
}

const at = (minutes) => new Date(Date.parse('2026-09-26T10:00:00+02:00') + minutes * 60_000).toISOString();

test('un fil toujours en échec n’affame pas les autres puis est confié à l’humain après trois essais', async () => {
  const f = inboxFixture();
  await f.poller.initialize();
  await f.poller.runNow();
  await f.poller.runNow();
  assert.deepEqual(f.box.picked, [URL, OTHER], 'le fil en échec attend, le suivant passe');
  f.setNow(at(6));
  await f.poller.runNow();
  assert.deepEqual(f.box.picked, [URL, OTHER, URL]);
  f.setNow(at(15));
  await f.poller.runNow();
  assert.equal(f.box.picked.length, 3, 'le second délai est plus long');
  f.setNow(at(30));
  const capped = await f.poller.runNow();
  assert.equal(capped.echecs[URL].essais, 3);
  assert.equal(capped.echecs[URL].abandonne, true);
  assert.equal(capped.echecs[URL].message_vendeur, 'Oui disponible');
  assert.equal(capped.echecs[URL].ouvert, true);
  assert.ok(f.effects.notifications.some(({ title }) => /reprise nécessaire/i.test(title)));
  f.setNow(at(300));
  await f.poller.runNow({ manual: true });
  assert.equal(f.box.picked.length, 4, 'plus aucun essai sur le même message');

  const dismissed = await f.poller.dismissFailure(URL);
  assert.equal(dismissed.echecs[URL].traite, true);
  await f.poller.runNow();
  assert.equal(f.box.picked.length, 4);

  // Un nouveau message est de nouveau tenté, avec un compteur neuf.
  f.box.rows[0].preview = 'PS5 nouveau message VendeurAlpha';
  const again = await f.poller.runNow();
  assert.equal(f.box.picked.at(-1), URL);
  assert.equal(again.echecs[URL].essais, 1);
  assert.equal(again.echecs[URL].abandonne, false);
});

test('« Vérifier maintenant » n’attend pas le délai et une réussite efface les échecs', async () => {
  let attempts = 0;
  const f = fixture({ unreadResults: [two()[0], two()[0], null], negotiate() {
    attempts += 1;
    if (attempts === 1) throw new Error('OpenRouter indisponible');
    return { duplicate: false, conversation: { id: 'c1' }, draft };
  } });
  await f.poller.initialize();
  await f.poller.runNow();
  assert.deepEqual(f.effects.listArguments[0][2], {});
  const state = await f.poller.runNow({ manual: true });
  assert.deepEqual(f.effects.listArguments[1][2], {});
  assert.deepEqual(state.echecs, {});
});

test('un serveur local arrêté ou un blocage ne comptent pas contre le fil', async () => {
  for (const error of [Object.assign(new Error('Serveur local injoignable.'), { name: 'ServerUnreachableError' }),
    Object.assign(new Error('Génération impossible.'), { code: 'modele_indisponible' }),
    new Error('Accès temporairement restreint'), new Error('Nouvelle connexion requise')]) {
    const f = fixture({ negotiate() { throw error; } });
    await f.poller.initialize();
    assert.deepEqual((await f.poller.runNow()).echecs, {});
  }
});

test('une réactivation confie à l’humain les échecs en attente au lieu de les oublier', async () => {
  const f = fixture({ apercus: lignes, unreadResults: [two()[0], null],
    negotiate() { throw new Error('OpenRouter indisponible'); } });
  await f.poller.initialize();
  await f.poller.runNow();
  await f.poller.pause();
  await f.poller.resume();
  const state = await f.poller.runNow();
  assert.equal(state.echecs[URL].abandonne, true);
});

const echecs = (f) => f.effects.api.filter(([name]) => name === 'error').map(([, value]) => value.code);

for (const [nom, sendImpl] of [
  ['l’injection est rejetée', () => { throw new Error('Frame with ID 0 was removed.'); }],
  ['l’injection ne rend rien', () => undefined],
  ['l’accusé est incomplet', () => ({ ok: false })],
  ['l’injection rejette en citant une connexion', () => { throw new Error('connexion perdue'); }],
]) {
  test(`un accusé d’envoi perdu (${nom}) ne permet aucun second envoi`, async () => {
    const f = fixture({ sendImpl });
    await f.poller.initialize();
    const first = await f.poller.runNow();
    assert.equal(first.lastError, 'envoi_incertain');
    assert.equal(first.lastResult, 'requires_review');
    assert.ok(first.processedFingerprints[FP]);
    assert.equal(first.envoiTente, null);
    assert.deepEqual(echecs(f), ['envoi_incertain']);
    assert.equal(first.handoffs[FP].raison, 'envoi_incertain');
    assert.equal(first.handoffs[FP].url_conversation, URL);
    assert.equal(first.handoffs[FP].vendeur, 'VendeurAlpha');
    await f.poller.runNow();
    await f.poller.runNow({ manual: true });
    assert.equal(f.effects.sends.length, 1);
    assert.equal(names(f).includes('handoff'), false, 'la carte est locale : aucun e-mail ni clôture');
    const cleared = await f.poller.dismissHandoff(FP);
    assert.deepEqual([cleared.handoffs, cleared.pendingHandled], [{}, {}]);
  });
}

test('un blocage signalé par une injection rejetée garde le délai long et le tour réservé', async () => {
  const f = fixture({ send: new Error('Accès temporairement restreint') });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.status, 'blocked');
  assert.ok(state.processedFingerprints[FP]);
  assert.deepEqual(echecs(f), ['envoi_incertain']);
});

test('l’envoi tenté est enregistré avant l’appel au script, jamais en simulation', async () => {
  for (const [dry, expected] of [[false, FP], [true, undefined]]) {
    let f;
    let seen;
    f = fixture({ settings: { dryRun: dry }, sendImpl: () => {
      seen = f.storage[CONVERSATION_STATE_KEY].envoiTente?.fingerprint;
      return dry ? { ok: true, clique: false, dryRun: true } : { ok: true, clique: true, confirme: true };
    } });
    await f.poller.initialize();
    const state = await f.poller.runNow();
    assert.equal(seen, expected);
    assert.equal(state.envoiTente, null);
  }
});

test('un refus explicite avant le clic efface la marque d’envoi et reste réessayable', async () => {
  let attempts = 0;
  const f = fixture({ sendImpl: () => {
    attempts += 1;
    return attempts === 1 ? { ok: false, clique: false, confirme: false, erreurCode: 'formulaire_absent' }
      : { ok: true, clique: true, confirme: true };
  } });
  await f.poller.initialize();
  const first = await f.poller.runNow();
  assert.equal(first.envoiTente, null);
  assert.deepEqual(first.handoffs, {});
  assert.equal((await f.poller.runNow()).lastResult, 'sent');
});

test('un redémarrage après le début de l’envoi consomme le tour et affiche la conversation', async () => {
  let f;
  f = fixture({ sendImpl: () => new Promise(() => {}) });
  await f.poller.initialize();
  f.poller.runNow();
  while (!f.effects.sends.length) await new Promise((resolve) => setImmediate(resolve));
  const g = fixture({ legacy: true, storedState: structuredClone(f.storage[CONVERSATION_STATE_KEY]) });
  const restored = await g.poller.initialize();
  assert.ok(restored.processedFingerprints[FP]);
  assert.equal(restored.lastError, 'envoi_incertain');
  assert.equal(restored.envoiTente, null);
  assert.equal(restored.handoffs[FP].url_conversation, URL);
  const next = await g.poller.runNow();
  assert.deepEqual(echecs(g), ['envoi_incertain']);
  assert.equal(next.lastResult, 'duplicate');
  assert.equal(g.effects.sends.length, 0);
});

// Un service worker tué pendant l’appel : l’appel ne rend jamais la main.
async function interrompuPendantGeneration() {
  const f = fixture({ negotiate: () => new Promise(() => {}) });
  await f.poller.initialize();
  f.poller.runNow();
  while (!names(f).includes('negotiate')) await new Promise((resolve) => setImmediate(resolve));
  return structuredClone(f.storage[CONVERSATION_STATE_KEY]);
}

test('un redémarrage pendant la génération libère le tour puis laisse le serveur décider', async () => {
  const storedState = await interrompuPendantGeneration();
  assert.equal(storedState.observedPreviews[URL].preview, null);
  const g = fixture({ legacy: true, storedState, negotiate: stopped });
  const restored = await g.poller.initialize();
  assert.equal(restored.processedFingerprints[FP], undefined);
  assert.equal(restored.processingFingerprint, null);
  const state = await g.poller.runNow();
  assert.deepEqual(names(g), ['error', 'negotiate', 'handoff', 'handled']);
  assert.deepEqual(echecs(g), ['generation_echec']);
  assert.equal(state.handoffs[FP].raison, 'paiement_leboncoin_accepte');
});

test('tant que la libération échoue le tour n’est ni négocié ni oublié', async () => {
  const storedState = await interrompuPendantGeneration();
  let down = true;
  const g = fixture({ legacy: true, storedState, errorImpl: () => {
    if (down) throw Object.assign(new Error('base'), { code: 'base_indisponible' });
  }, negotiate: { duplicate: false, conversation: { id: 'c1' }, draft } });
  await g.poller.initialize();
  const first = await g.poller.runNow();
  assert.equal(names(g).includes('negotiate'), false);
  assert.equal(first.processedFingerprints[FP], undefined);
  assert.deepEqual(first.echecs, {});
  assert.equal(first.aSignaler[URL].fingerprint, FP);
  down = false;
  const second = await g.poller.runNow();
  assert.equal(second.lastResult, 'sent');
  assert.deepEqual(second.aSignaler, {});
});

test('une réponse de négociation perdue libère la réservation éventuelle', async () => {
  const f = fixture({ negotiate() {
    throw Object.assign(new Error('Serveur local injoignable.'), { name: 'ServerUnreachableError' });
  } });
  await f.poller.initialize();
  await f.poller.runNow();
  assert.deepEqual(echecs(f), ['generation_echec']);
});

test('un redémarrage entre l’ouverture et la réservation laisse le message à traiter', async () => {
  const f = fixture({ onSleep: (ms) => (ms >= 4000 ? new Promise(() => {}) : undefined) });
  await f.poller.initialize();
  f.poller.runNow();
  while (!f.effects.sleeps.some((ms) => ms >= 4000)) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.storage[CONVERSATION_STATE_KEY].observedPreviews[URL].preview, null);
});

test('une base indisponible ne compte pas contre le fil', async () => {
  const f = fixture({ negotiate() { throw Object.assign(new Error('La génération a échoué.'), { code: 'base_indisponible' }); } });
  await f.poller.initialize();
  for (let index = 0; index < 3; index += 1) await f.poller.runNow({ manual: true });
  assert.deepEqual((await f.poller.state()).echecs, {});
});

test('une conversation hors périmètre reste visible jusqu’à ce qu’elle soit traitée', async () => {
  let ignored = true;
  const f = fixture({ negotiate: () => (ignored ? { ignored: true, reason: 'hors_perimetre' }
    : { duplicate: false, conversation: { id: 'c1' }, draft }) });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.ignorees[URL].vendeur, 'VendeurAlpha');
  assert.equal(state.ignorees[URL].message_vendeur, 'Oui disponible');
  assert.equal(state.observedPreviews[URL].provisoire, 'hors_perimetre');
  assert.equal(state.observedPreviews[URL].preview, 'PS5 Oui disponible VendeurAlpha');
  ignored = false;
  assert.deepEqual((await f.poller.runNow()).ignorees, {});
});

test('une réactivation affiche un tour interrompu avant l’envoi au lieu de l’oublier', async () => {
  for (const [nonLu, cartes] of [[false, 1], [true, 0]]) {
    let poller;
    const f = fixture({ unreadResults: [two()[0], null],
      apercus: { lignes: [{ url_conversation: URL, preview: 'PS5 Oui disponible VendeurAlpha', non_lu: nonLu }] },
      async negotiate() { await poller.pause(); return { duplicate: false, conversation: { id: 'c1' }, draft }; } });
    poller = f.poller;
    await poller.initialize();
    await poller.runNow();
    await poller.resume();
    const state = await poller.runNow();
    const visibles = Object.entries(state.echecs).filter(([, echec]) => echec.abandonne && !echec.traite);
    assert.equal(visibles.length, cartes, 'un non-lu reste à traiter automatiquement');
    if (cartes) assert.equal(visibles[0][0], URL);
    assert.equal(f.effects.sends.length, 0);
  }
});

test('après un envoi non confirmé la notification ne promet aucun nouvel essai', async () => {
  const f = fixture({ send: { ok: false, clique: true, confirme: false, erreurCode: 'envoi_incertain' } });
  await f.poller.initialize();
  await f.poller.runNow();
  const { message } = f.effects.notifications.at(-1);
  assert.match(message, /Vérifie la conversation/);
  assert.doesNotMatch(message, /nouvelle tentative/i);
});

test('un envoi enregistré puis un retour à la liste en échec n’est pas dit incertain', async () => {
  const update = [];
  const f = fixture({ sendImpl: () => { update.push(1); return { ok: true, clique: true, confirme: true }; } });
  await f.poller.initialize();
  const push = f.effects.updates.push.bind(f.effects.updates);
  f.effects.updates.push = (entry) => {
    if (update.length && entry.patch.url === 'https://www.leboncoin.fr/messages') throw new Error('Navigation retour impossible');
    return push(entry);
  };
  const state = await f.poller.runNow();
  assert.equal(state.lastError, 'retour_liste_echec');
  assert.ok(state.processedFingerprints[FP]);
  assert.deepEqual(state.handoffs, {});
  assert.deepEqual(echecs(f), []);
});

const journal = () => { const entries = []; return { entries, record: async (entry) => { entries.push(entry); } }; };
const ENVOI_JOURNALISE = { kind: 'reponse', simulated: false, vendeur: 'VendeurAlpha', message: draft.message, url: URL };

test('journal : une réponse confirmée est consignée une fois, même si le serveur ne l’enregistre pas', async () => {
  for (const sentError of [undefined, new Error('base arrêtée')]) {
    const j = journal();
    const f = fixture({ journalEnvois: j, sentError });
    await f.poller.initialize();
    await f.poller.runNow();
    assert.deepEqual(j.entries, [ENVOI_JOURNALISE]);
  }
});

test('journal : un envoi non confirmé, refusé ou interrompu n’est jamais consigné', async () => {
  for (const send of [{ ok: true, clique: true, confirme: false }, { ok: false, clique: false, erreurCode: 'formulaire_absent' },
    { ok: false, clique: false, erreurCode: 'interrompu', dryRun: true }, undefined, new Error('onglet fermé')]) {
    const j = journal();
    const f = fixture({ journalEnvois: j, sendImpl: async () => { if (send instanceof Error) throw send; return send; } });
    await f.poller.initialize();
    await f.poller.runNow();
    assert.deepEqual(j.entries, [], JSON.stringify(send));
  }
});

test('journal : une réponse seulement tapée en mode test est consignée comme essai', async () => {
  const j = journal();
  const f = fixture({ journalEnvois: j, settings: { dryRun: true }, send: { ok: true, clique: false, dryRun: true } });
  await f.poller.initialize();
  const state = await f.poller.runNow();
  assert.equal(state.lastResult, 'dry_run');
  assert.deepEqual(j.entries, [{ ...ENVOI_JOURNALISE, simulated: true }]);
});

test('journal : une panne du journal ne change rien au cycle d’envoi', async () => {
  for (const record of [() => { throw new Error('x'); }, async () => { throw new Error('x'); }, () => new Promise(() => {})]) {
    const f = fixture({ journalEnvois: { record } });
    await f.poller.initialize();
    const state = await f.poller.runNow();
    assert.equal(state.lastResult, 'sent');
    assert.equal(f.effects.api.filter(([name]) => name === 'sent').length, 1);
    assert.deepEqual(f.effects.logged, []);
  }
});
