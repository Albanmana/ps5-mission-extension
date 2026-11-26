import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../extension/', import.meta.url);
const source = readFileSync(new URL('content/send-message.js', root), 'utf8');

function page({ blocked = false, disabled = false, confirm = true } = {}) {
  const effects = { clicks: 0, values: [], events: [] };
  let value = '';
  let sent = false;
  class Textarea {
    get value() { return value; }
    set value(next) { value = next; effects.values.push(next); }
    focus() {}
    dispatchEvent(event) { effects.events.push(event.type); }
  }
  const field = new Textarea();
  const send = { disabled, click() { effects.clicks += 1; if (confirm) sent = true; } };
  const outgoing = () => sent ? [{ textContent: value, parentElement: { classList: { contains: (v) => v === 'justify-end' } } }] : [];
  const document = {
    body: { textContent: blocked ? 'Accès temporairement restreint' : 'Conversation' },
    querySelector(selector) {
      if (selector === 'textarea[aria-label="Ecrire mon message"]') return field;
      if (selector === 'button[aria-label="Envoyer mon message"]') return send;
      return null;
    },
    querySelectorAll(selector) { return selector === '[data-qa-id="message-bubble"]' ? outgoing() : []; },
  };
  return { document, effects, field };
}

const CONVERSATION = 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101';
const OTHER = 'https://www.leboncoin.fr/messages/id/cccccccc-1111-2222-3333-dddddddddddd';

const ABSENT = Symbol('absent');

function inject(document, { state = { activationVersion: 2, enabled: true, pauseSeq: 0 },
  settings = { dryRun: false }, storageError, location = { href: CONVERSATION }, onGet } = {}) {
  let reads = 0;
  const context = vm.createContext({ window: {}, document, Event, setTimeout, URL, location,
    chrome: {
      runtime: { getURL: (path) => new URL(path, root).href },
      storage: { local: { async get() {
        reads += 1;
        await onGet?.(reads);
        if (storageError) throw storageError;
        return { conversation_poller_state: state, ...(settings === ABSENT ? {} : { ps5_settings: settings }) };
      } } },
    },
  });
  const script = new vm.Script(source, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  script.runInContext(context);
  return context.window;
}

const options = { expectedUrl: CONVERSATION, dryRun: false, pauseSeq: 0 };

test('tape le texte exact, clique une seule fois et confirme la nouvelle bulle sortante', async () => {
  const f = page();
  const window = inject(f.document);
  await window.__ps5SendMessageReady;
  const result = await window.__ps5EnvoyerMessage('A', { ...options, timeoutMs: 500 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, clique: true, confirme: true });
  assert.equal(f.field.value, 'A');
  assert.equal(f.effects.clicks, 1);
  assert.deepEqual(f.effects.events, ['input', 'input']);
});

test('un clic sans nouvelle bulle est incertain et ne clique jamais deux fois', async () => {
  const f = page({ confirm: false });
  const window = inject(f.document);
  await window.__ps5SendMessageReady;
  const result = await window.__ps5EnvoyerMessage('A', { ...options, timeoutMs: 120 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false, clique: true, confirme: false, erreurCode: 'envoi_incertain',
  });
  assert.equal(f.effects.clicks, 1);
});

test('les entrées invalides, le blocage et un bouton désactivé ne cliquent pas', async () => {
  for (const [config, text] of [[{}, ' '], [{ blocked: true }, 'A'], [{ disabled: true }, 'A']]) {
    const f = page(config);
    const window = inject(f.document);
    await window.__ps5SendMessageReady;
    if (!text.trim() || config.blocked) await assert.rejects(window.__ps5EnvoyerMessage(text, { expectedUrl: CONVERSATION, dryRun: false, pauseSeq: 0, timeoutMs: 20 }));
    else assert.equal((await window.__ps5EnvoyerMessage(text, { expectedUrl: CONVERSATION, dryRun: false, pauseSeq: 0, timeoutMs: 20 })).clique, false);
    assert.equal(f.effects.clicks, 0);
  }
});

async function run(config, extra = {}) {
  const f = page();
  const window = inject(f.document, config);
  await window.__ps5SendMessageReady;
  const result = await window.__ps5EnvoyerMessage('AB', { ...options, timeoutMs: 200, ...extra });
  return { f, result: JSON.parse(JSON.stringify(result)) };
}

test('en simulation le texte est tapé, jamais cliqué, et reste visible', async () => {
  for (const [config, extra] of [[{ settings: { dryRun: true } }, {}], [{ settings: null }, {}],
    [{ settings: { dryRun: 'false' } }, {}], [{}, { dryRun: true }]]) {
    const { f, result } = await run(config, extra);
    assert.deepEqual(result, { ok: true, clique: false, dryRun: true });
    assert.equal(f.field.value, 'AB');
    assert.equal(f.effects.clicks, 0);
  }
});

test('sans réglage enregistré, la réponse part réellement', async () => {
  for (const settings of [undefined, {}]) {
    const f = page();
    // « undefined » explicite : le défaut du faux stockage ne doit pas s’appliquer.
    const window = inject(f.document, { settings: settings ?? ABSENT });
    await window.__ps5SendMessageReady;
    const result = await window.__ps5EnvoyerMessage('AB', { ...options, timeoutMs: 200 });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, clique: true, confirme: true });
    assert.equal(f.effects.clicks, 1);
  }
});

test('une pause, avant ou pendant la frappe, empêche le clic et vide le champ', async () => {
  for (const config of [{ state: { activationVersion: 2, enabled: false, pauseSeq: 1 } },
    { state: { activationVersion: 2, enabled: true, pauseSeq: 2 } }, { state: null }]) {
    const { f, result } = await run(config);
    assert.equal(result.erreurCode, 'interrompu');
    assert.equal(f.effects.clicks, 0);
    assert.deepEqual(f.effects.values, []);
  }
  const state = { activationVersion: 2, enabled: true, pauseSeq: 0 };
  const { f, result } = await run({ state, onGet: (reads) => { if (reads > 1) state.enabled = false; } });
  assert.equal(result.erreurCode, 'interrompu');
  assert.ok(f.effects.values.includes('AB'));
  assert.equal(f.field.value, '');
  assert.equal(f.effects.clicks, 0);
});

test('la simulation activée pendant la frappe empêche le clic', async () => {
  const settings = { dryRun: false };
  const { f, result } = await run({ settings, onGet: (reads) => { if (reads > 1) settings.dryRun = true; } });
  assert.equal(result.dryRun, true);
  assert.equal(f.effects.clicks, 0);
});

test('un autre destinataire n’est jamais tapé ni cliqué', async () => {
  const wrong = await run({ location: { href: OTHER } });
  assert.equal(wrong.result.erreurCode, 'mauvaise_conversation');
  assert.deepEqual(wrong.f.effects.values, []);
  assert.equal(wrong.f.effects.clicks, 0);
  const missing = await run({}, { expectedUrl: undefined });
  assert.equal(missing.result.erreurCode, 'mauvaise_conversation');

  const location = { href: CONVERSATION };
  const f = page();
  const original = f.field.dispatchEvent.bind(f.field);
  f.field.dispatchEvent = (event) => { original(event); if (f.field.value === 'A') location.href = OTHER; };
  const window = inject(f.document, { location });
  await window.__ps5SendMessageReady;
  const during = await window.__ps5EnvoyerMessage('ABC', { ...options, timeoutMs: 200 });
  assert.equal(during.erreurCode, 'mauvaise_conversation');
  assert.equal(f.effects.values.includes('AB'), false);
  assert.equal(f.effects.clicks, 0);

  const last = { href: CONVERSATION };
  const { f: g, result } = await run({ location: last, onGet: (reads) => { if (reads > 1) last.href = OTHER; } });
  assert.equal(result.erreurCode, 'mauvaise_conversation');
  assert.equal(g.effects.clicks, 0);
});

test('un stockage illisible ne clique jamais', async () => {
  const f = page();
  const window = inject(f.document, { storageError: new Error('illisible') });
  await window.__ps5SendMessageReady;
  await assert.rejects(window.__ps5EnvoyerMessage('A', { ...options, timeoutMs: 50 }));
  assert.equal(f.effects.clicks, 0);
});
