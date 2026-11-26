// Faux chrome complet du panneau : chaque test remplace les réponses qui l'intéressent.
import { monterPanneau } from '../../extension/panel/app.js';
import { SETTINGS_KEY } from '../../extension/lib/settings.js';
import { documentTest, settle, buttons } from './panel-dom.js';

export const OPTIONS = {
  urlsRecherche: ['https://www.leboncoin.fr/recherche?text=ps5'],
  maxPages: 3, maxResultats: 200, maxFiches: 50, force: false, contactAuto: false,
};

export function chromeTest({ settings, failGet = false, templates, storageError } = {}) {
  const data = settings ? { [SETTINGS_KEY]: settings } : {};
  if (templates !== undefined) data.templates_contact = templates;
  const storageListeners = [], runtimeListeners = [], writes = [], messages = [];
  const flags = { failGet, failSet: false };
  const emit = (value, area = 'local') => {
    for (const listener of storageListeners) listener({ [SETTINGS_KEY]: { newValue: value } }, area);
  };
  const chrome = {
    data, writes, flags, emit, messages,
    replies: {},
    storage: {
      local: {
        async get(key) {
          if (flags.failGet) throw new Error('lecture impossible');
          if (storageError && key === 'templates_contact') throw new Error(storageError);
          return { ...data };
        },
        async set(next) {
          if (flags.failSet) throw new Error('écriture impossible');
          if (SETTINGS_KEY in next) writes.push(next[SETTINGS_KEY]);
          Object.assign(data, next);
          if (SETTINGS_KEY in next) emit(next[SETTINGS_KEY]);
        },
      },
      onChanged: { addListener(fn) { storageListeners.push(fn); } },
    },
    tabs: { query: async () => [] },
    runtime: {
      onMessage: { addListener(fn) { runtimeListeners.push(fn); } },
      sendMessage(message, respond) {
        messages.push(message);
        const reply = chrome.replies[message.type];
        if (reply === undefined) throw new Error(`Message sans réponse prévue : ${message.type}`);
        Promise.resolve(typeof reply === 'function' ? reply(message) : reply).then((value) => {
          if (value === HOLD) return;
          if (value?.lastError) chrome.runtime.lastError = { message: value.lastError };
          respond(value?.lastError ? undefined : value);
          delete chrome.runtime.lastError;
        });
      },
    },
    live(message) { for (const listener of runtimeListeners) listener(message); },
  };
  Object.assign(chrome.replies, {
    'ping-serveur': { ok: true },
    'run-etat': { etat: null },
    'recherche-auto-etat': { etat: { enabled: false, status: 'paused', options: OPTIONS } },
    'recherche-auto-configurer': (m) => ({ etat: { enabled: false, status: 'paused', options: m.options } }),
    'recherche-auto-activer': (m) => ({
      etat: { enabled: m.enabled, status: m.enabled ? 'idle' : 'paused', options: m.options },
    }),
    'run-demarrer': { ok: true, etat: null },
    'run-pause': { ok: true }, 'run-reprendre': { ok: true }, 'run-arreter': { ok: true },
    'conversations-etat': { etat: { enabled: false, status: 'paused' } },
    'conversations-liste': { conversations: [] },
    'contact-shortlist': { ok: true, annonces: [] },
    'contact-reservations': { ok: true, reservations: [] },
    'envois-liste': { ok: true, envois: [] },
  });
  return chrome;
}

export const HOLD = Symbol('sans réponse');
export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

export async function monter({ replies = {}, now, wait = true, ...options } = {}) {
  const chrome = chromeTest(options);
  Object.assign(chrome.replies, replies);
  const root = documentTest().createElement('div');
  const panneau = monterPanneau(root, { chrome, ...(now ? { maintenant: now } : {}) });
  if (wait) await panneau.pret;
  const el = (id) => {
    const node = root.querySelector(`#${id}`);
    if (!node) throw new Error(`Élément absent : #${id}`);
    return node;
  };
  const sent = (type) => chrome.messages.filter((message) => message.type === type);
  return {
    root, chrome, el, sent, panneau,
    click: (id) => el(id).fire('click'),
    // Ligne de la liste des annonces, par URL.
    row: (url) => buttons(el('annonces-liste')).find((node) => node.getAttribute('data-url') === url),
    rows: () => el('annonces-liste').children,
    async type(id, value, event = 'input') { el(id).value = value; await el(id).fire(event); },
    settle,
  };
}
