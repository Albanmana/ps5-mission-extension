import assert from 'node:assert/strict';
import test from 'node:test';
import { installerServiceWorker } from '../extension/sw/service-worker.js';

const A = 'https://www.leboncoin.fr/ad/consoles/123';
const REPLY = 'https://www.leboncoin.fr/reply/123';
const SUCCESS = 'https://www.leboncoin.fr/reply/success/conversations?adId=123';

function fixture(api = {}, pollerOverrides = {}, searchOverrides = {}) {
  let handler, alarmHandler;
  const opened = [], updated = new Set(), removed = new Set();
  const tab = { id: 9, status: 'complete', url: REPLY };
  const pollerCalls = [];
  const searchCalls = [];
  const conversationPoller = {
    initialize: async () => { pollerCalls.push(['initialize']); return { status: 'idle' }; },
    state: async () => ({ enabled: true, status: 'idle' }),
    enable: async (enabled) => { pollerCalls.push(['enable', enabled]); return { enabled }; },
    pause: async () => { pollerCalls.push(['pause']); return { status: 'paused' }; },
    resume: async () => { pollerCalls.push(['resume']); return { status: 'idle' }; },
    acknowledge: async () => { pollerCalls.push(['acknowledge']); return { status: 'idle', processingFingerprint: null }; },
    runNow: async (options) => { pollerCalls.push(['runNow', options]); return { lastResult: 'no_unread' }; },
    onAlarm: async (alarm) => { pollerCalls.push(['onAlarm', alarm.name]); },
    ...pollerOverrides,
  };
  const searchAutopilot = {
    initialiser: async () => { searchCalls.push(['initialiser']); return { enabled: true, status: 'idle' }; },
    lireEtat: async () => ({ enabled: true, status: 'idle', nextRunAt: 1234 }),
    activer: async (enabled, options) => { searchCalls.push(['activer', enabled, options]); return { enabled }; },
    configurer: async (options) => { searchCalls.push(['configurer', options]); return { options }; },
    demarrerManuellement: async (options) => { searchCalls.push(['demarrerManuellement', options]); return { etat: { statut: 'en_cours' } }; },
    planifierApresPause: async () => { searchCalls.push(['planifierApresPause']); return { enabled: true, status: 'running' }; },
    relancerApresDecision: async () => { searchCalls.push(['relancerApresDecision']); },
    onAlarm: async (alarm) => { searchCalls.push(['onAlarm', alarm.name, alarm.scheduledTime]); },
    ...searchOverrides,
  };
  const chrome = {
    action: { onClicked: { addListener() {} } },
    sidePanel: { open: async () => {} },
    storage: { local: { get: async () => ({ run_recherche: null, ps5_settings: { dryRun: false } }), set: async () => {} } },
    runtime: { onMessage: { addListener(fn) { handler = fn; } } },
    alarms: { onAlarm: { addListener(fn) { alarmHandler = fn; } } },
    tabs: {
      onUpdated: { addListener(fn) { updated.add(fn); }, removeListener(fn) { updated.delete(fn); } },
      onRemoved: { addListener(fn) { removed.add(fn); }, removeListener(fn) { removed.delete(fn); } },
      create: async (options) => { opened.push(options); return tab; },
      get: async () => tab,
      remove: async () => {},
    },
    scripting: { executeScript: async ({ files, args }) => {
      if (files) return [{}];
      if (!args) return [{ result: true }];
      tab.url = SUCCESS;
      for (const fn of [...updated]) fn(tab.id, { status: 'complete', url: SUCCESS }, tab);
      return [{ result: { ok: true, clique: true } }];
    } },
  };
  installerServiceWorker({ chrome, conversationPoller, searchAutopilot, api: {
    shortlist: async () => ({ annonces: [] }),
    reserverContact: async () => ({ reservee: true,
      reservation_token: '12345678-1234-4234-8234-123456789abc', reservation_le: '2026-09-26T12:00:00.000Z' }),
    finaliserContact: async () => ({ contacte_le: '2026-09-26T12:00:00.000Z' }),
    libererContact: async () => ({ liberee: true }),
    marquerErreurContact: async (_url, code) => ({ contact_erreur_code: code, contact_erreur_le: '2026-09-26T12:00:00.000Z' }),
    ...api,
  } });
  return { chrome, opened, handler, conversationPoller, pollerCalls, searchAutopilot, searchCalls,
    fireAlarm: (name, scheduledTime) => alarmHandler?.({ name, scheduledTime }),
    request: (message, sender = {}) => new Promise((resolve) => {
      const async = handler(message, sender, resolve);
      if (async === false) resolve(false);
      else assert.equal(async, true, 'La réponse asynchrone garde le canal ouvert');
    }),
  };
}

test('contact-shortlist forwards seller rows and reports API errors', async () => {
  const rows = [{ url_annonce: A, vendeur: 'Alice' }];
  const f = fixture({ shortlist: async (options) => { assert.deepEqual(options, { limite: 50, prixMax: 370 }); return { annonces: rows }; } });
  assert.deepEqual(await f.request({ type: 'contact-shortlist' }), { ok: true, annonces: rows });
  const failed = fixture({ shortlist: async () => { throw new Error('Serveur absent'); } });
  assert.deepEqual(await failed.request({ type: 'contact-shortlist' }), { ok: false, error: 'Serveur absent' });
});

test('contact-shortlist applies the current maximum price and fails closed on unreadable settings', async () => {
  const seen = [];
  const f = fixture({ shortlist: async (options) => { seen.push(options.prixMax); return { annonces: [] }; } });
  f.chrome.storage.local.get = async () => ({ ps5_settings: { goodPrice: 250, maxPrice: 280 } });
  await f.request({ type: 'contact-shortlist' });
  f.chrome.storage.local.get = async () => { throw new Error('stockage cassé'); };
  assert.equal((await f.request({ type: 'contact-shortlist' })).ok, false);
  assert.deepEqual(seen, [280]);
});

test('contact-envoyer invokes the guarded sender and rejects commands from pages', async () => {
  const invalid = fixture();
  assert.deepEqual(await invalid.request({ type: 'contact-envoyer', urlAnnonce: 'javascript:alert(1)', texte: 'Bonjour' }),
    { ok: false, error: 'URL d’annonce leboncoin HTTPS invalide.' });

  const f = fixture();
  const response = await f.request({ type: 'contact-envoyer', urlAnnonce: A, texte: 'Bonjour' });
  assert.deepEqual(response, { ok: true, envoye: true, suivi: true, tabId: 9 });
  assert.deepEqual(f.opened, [{ url: REPLY, active: true }]);
  assert.equal(await f.request({ type: 'contact-envoyer', urlAnnonce: A, texte: 'Bonjour' }, { tab: { id: 8 } }), false);
  assert.equal(await f.request({ type: 'contact-shortlist' }, { tab: { id: 8 } }), false);
});

test('conversation poller initializes, receives alarms and exposes panel commands', async () => {
  const f = fixture({ conversations: async () => ({ conversations: [{ id: 1 }] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.pollerCalls, [['initialize']]);
  assert.deepEqual(f.searchCalls, [['initialiser']]);

  f.fireAlarm('ps5-conversation-poll');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.pollerCalls.at(-1), ['onAlarm', 'ps5-conversation-poll']);

  assert.deepEqual(await f.request({ type: 'conversations-etat' }), { etat: { enabled: true, status: 'idle' } });
  assert.deepEqual(await f.request({ type: 'conversations-activer', enabled: false }), { etat: { enabled: false } });
  assert.deepEqual(await f.request({ type: 'conversations-pause' }), { etat: { status: 'paused' } });
  assert.deepEqual(await f.request({ type: 'conversations-reprendre' }), { etat: { status: 'idle' } });
  assert.deepEqual(await f.request({ type: 'conversations-acquitter' }), { etat: { status: 'idle', processingFingerprint: null } });
  assert.deepEqual(await f.request({ type: 'conversations-verifier' }), { etat: { lastResult: 'no_unread' } });
  assert.deepEqual(f.pollerCalls.at(-1), ['runNow', { manual: true }]);
  assert.deepEqual(await f.request({ type: 'conversations-liste' }), { conversations: [{ id: 1 }] });
});

test('l’autopilote de recherche reçoit son alarme et expose les commandes du panneau', async () => {
  const f = fixture();
  await new Promise((resolve) => setImmediate(resolve));
  f.fireAlarm('ps5-search-autopilot', 4567);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.searchCalls.at(-1), ['onAlarm', 'ps5-search-autopilot', 4567]);
  assert.equal(f.pollerCalls.some((call) => call[0] === 'onAlarm' && call[1] === 'ps5-search-autopilot'), false);

  const options = { urlRecherche: 'https://www.leboncoin.fr/recherche?text=ps5', maxPages: 3 };
  assert.deepEqual(await f.request({ type: 'recherche-auto-etat' }), {
    etat: { enabled: true, status: 'idle', nextRunAt: 1234 },
  });
  assert.deepEqual(await f.request({ type: 'recherche-auto-activer', enabled: false, options }), { etat: { enabled: false } });
  assert.deepEqual(await f.request({ type: 'recherche-auto-configurer', options }), { etat: { options } });
  assert.deepEqual(await f.request({ type: 'run-demarrer', options }), { ok: true, etat: { statut: 'en_cours' } });
  assert.deepEqual(f.searchCalls.slice(-3), [
    ['activer', false, options],
    ['configurer', options],
    ['demarrerManuellement', options],
  ]);

  assert.deepEqual(await f.request({ type: 'run-pause' }), { ok: true });
  assert.deepEqual(f.searchCalls.at(-1), ['planifierApresPause']);
  assert.deepEqual(await f.request({ type: 'run-arreter' }), { ok: true });
  assert.deepEqual(f.searchCalls.at(-1), ['relancerApresDecision']);
});

test('un contact attend la fin du cycle conversation qui utilise déjà le navigateur', async () => {
  let libererCycle;
  const cycleTermine = new Promise((resolve) => { libererCycle = resolve; });
  const f = fixture({}, {
    runNow: async () => {
      await cycleTermine;
      return { lastResult: 'no_unread' };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const verification = f.request({ type: 'conversations-verifier' });
  await new Promise((resolve) => setImmediate(resolve));
  const contact = f.request({ type: 'contact-envoyer', urlAnnonce: A, texte: 'Bonjour' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.opened.length, 0, 'aucun onglet contact ne doit concurrencer le poller');
  libererCycle();
  await verification;
  assert.deepEqual(await contact, { ok: true, envoye: true, suivi: true, tabId: 9 });
  assert.deepEqual(f.opened, [{ url: REPLY, active: true }]);
});

test('conversation commands are rejected when sent by an injected page', async () => {
  const f = fixture();
  assert.equal(await f.request({ type: 'conversations-verifier' }, { tab: { id: 8 } }), false);
  assert.equal(await f.request({ type: 'conversations-pause' }, { tab: { id: 8 } }), false);
  assert.deepEqual(f.pollerCalls, [['initialize']]);
});

test('alarm and panel commands wait for persisted poller state to finish loading', async () => {
  let release;
  let initializeStarted = 0;
  const ready = new Promise((resolve) => { release = resolve; });
  const f = fixture({}, { initialize: async () => { initializeStarted += 1; await ready; } });
  await new Promise((resolve) => setImmediate(resolve));
  f.fireAlarm('ps5-conversation-poll');
  const stateRequest = f.request({ type: 'conversations-etat' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initializeStarted, 1);
  assert.deepEqual(f.pollerCalls, []);
  release();
  await stateRequest;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.pollerCalls, [['onAlarm', 'ps5-conversation-poll']]);
});

test('commandes des réservations bloquées et des reprises humaines', async () => {
  const dismissed = [];
  const f = fixture({
    reservationsBloquees: async () => ({ reservations: [{ url_annonce: A }] }),
    resoudreReservation: async (url, resultat) => { assert.deepEqual([url, resultat], [A, 'envoye']); return { resolue: true }; },
  }, {
    dismissHandoff: async (id) => { dismissed.push(id); return { handoffs: {} }; },
    dismissFailure: async (url) => { dismissed.push(url); return { echecs: {} }; },
  });
  assert.deepEqual(await f.request({ type: 'contact-reservations' }), { ok: true, reservations: [{ url_annonce: A }] });
  assert.deepEqual(await f.request({ type: 'contact-reservation-resoudre', urlAnnonce: A, resultat: 'envoye' }), { ok: true, resolue: true });
  assert.deepEqual(await f.request({ type: 'conversations-handoff-traite', fingerprint: 'abc' }), { etat: { handoffs: {} } });
  assert.deepEqual(await f.request({ type: 'conversations-echec-traite', url_conversation: A }), { etat: { echecs: {} } });
  assert.deepEqual(dismissed, ['abc', A]);
  assert.equal(await f.request({ type: 'contact-reservation-resoudre' }, { tab: { id: 1 } }), false);
});

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('a confirmed panel send is listed by envois-liste, and pages cannot read it', async () => {
  const f = fixture();
  const stored = {};
  f.chrome.storage.local.get = async (key) => ({ run_recherche: null, ps5_settings: { dryRun: false }, ...stored, requested: key });
  f.chrome.storage.local.set = async (value) => { Object.assign(stored, value); };
  assert.deepEqual(await f.request({ type: 'envois-liste' }), { ok: true, envois: [] });
  const result = await f.request({ type: 'contact-envoyer', urlAnnonce: A, texte: 'Bonjour', vendeur: 'Alice' });
  assert.equal(result.envoye, true);
  await settle();
  const { envois } = await f.request({ type: 'envois-liste' });
  assert.equal(envois.length, 1);
  assert.deepEqual({ ...envois[0], date: 0 },
    { kind: 'premier_contact', simulated: false, vendeur: 'Alice', debut: 'Bonjour', tronque: false, url: A, date: 0 });
  assert.equal(await f.request({ type: 'envois-liste' }, { tab: { id: 1 } }), false);
});
