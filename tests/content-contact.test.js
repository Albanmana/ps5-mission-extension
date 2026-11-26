import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { SETTINGS_KEY } from '../extension/lib/settings.js';

const root = new URL('../extension/', import.meta.url);
const fieldSelector = 'textarea#body';
const clearSelector = 'button[aria-label="Supprimer le message"]';
const sendSelector = 'button[aria-label="Envoyer mon message"]';

function page({ blocked = false, field = true, clear = true, send = true, disabled = false } = {}) {
  const effects = { clicks: [], values: [], events: [], selectors: [], focus: 0 };
  let value = 'Message pré-rempli';
  class Textarea {
    get value() { return value; }
    set value(next) { value = next; effects.values.push(next); }
    focus() { effects.focus += 1; }
    dispatchEvent(event) { effects.events.push({ type: event.type, bubbles: event.bubbles }); }
  }
  const textarea = new Textarea();
  const clearButton = { click() { effects.clicks.push('clear'); textarea.value = ''; } };
  const sendButton = { disabled, click() { effects.clicks.push('send'); } };
  const document = {
    body: { textContent: blocked ? 'Accès temporairement restreint' : 'Envoyer un message' },
    querySelector(selector) {
      effects.selectors.push(selector);
      if (selector === fieldSelector) return field ? textarea : null;
      if (selector === clearSelector) return clear ? clearButton : null;
      if (selector === sendSelector) return send ? sendButton : null;
      if (selector.includes('captcha-delivery')) return null;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  return { document, field: textarea, effects, sendButton };
}

function inject(document, { invalidImport = false, settings = () => ({ dryRun: false }),
  location = { origin: 'https://www.leboncoin.fr', pathname: '/reply/123' } } = {}) {
  const imports = [];
  const context = vm.createContext({ window: {}, document, Event, location,
    chrome: { storage: { local: { get: async (key) => {
      assert.equal(key, SETTINGS_KEY);
      return { [key]: settings() };
    } } }, runtime: { getURL(path) {
      imports.push(path);
      return new URL(invalidImport ? 'missing-typing-module.js' : path, root).href;
    } } },
  });
  const script = new vm.Script(readFileSync(new URL('content/contact.js', root), 'utf8'), {
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  script.runInContext(context);
  return { window: context.window, location, imports, reinject: () => script.runInContext(context) };
}

test('classic script exposes the direct reply sender and tolerates reinjection', async () => {
  const { window, imports, reinject } = inject(page().document);
  assert.equal(typeof window.__ps5ContactReady?.then, 'function');
  const ready = window.__ps5ContactReady;
  await ready;
  assert.equal(typeof window.__ps5EnvoyerContact, 'function');
  assert.equal(window.__ps5PreparerContact, undefined);
  reinject();
  assert.equal(window.__ps5ContactReady, ready);
  assert.deepEqual(imports, ['lib/typing.js', 'lib/settings.js']);
});

test('readiness rejects if the shared module cannot load without exposing a sender', async () => {
  const { window } = inject(page().document, { invalidImport: true });
  await assert.rejects(window.__ps5ContactReady, /Cannot find module/);
  assert.equal(window.__ps5EnvoyerContact, undefined);
});

test('clears the reply field, types the exact message and clicks send once', async () => {
  const { document, effects, field } = page();
  const { window } = inject(document);
  await window.__ps5ContactReady;
  const result = await window.__ps5EnvoyerContact('Ça', { timeoutMs: 20 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, clique: true });
  assert.equal(field.value, 'Ça');
  assert.deepEqual(effects.clicks, ['clear', 'send']);
  assert.deepEqual(effects.values, ['', 'Ç', 'Ça']);
  assert.ok(effects.focus >= 1);
  assert.deepEqual(effects.events, [{ type: 'input', bubbles: true }, { type: 'input', bubbles: true }]);
  assert.equal(effects.selectors.includes('button[data-pub-id="adview_button_contact_navbar"]'), false);
});

test('missing clear button uses the native setter before typing and sending', async () => {
  const { document, effects, field } = page({ clear: false });
  const { window } = inject(document);
  await window.__ps5ContactReady;
  const result = await window.__ps5EnvoyerContact('A', { timeoutMs: 20 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, clique: true });
  assert.equal(field.value, 'A');
  assert.deepEqual(effects.clicks, ['send']);
  assert.deepEqual(effects.values, ['', 'A']);
  assert.deepEqual(effects.events, [{ type: 'input', bubbles: true }, { type: 'input', bubbles: true }]);
});

test('blocked page stays retryable and never modifies or clicks anything', async () => {
  const { document, effects } = page({ blocked: true });
  const { window } = inject(document);
  await window.__ps5ContactReady;
  assert.deepEqual(plain(await window.__ps5EnvoyerContact('Bonjour', { timeoutMs: 20 })),
    { ok: false, clique: false, bloque: true });
  assert.deepEqual(effects.clicks, []);
  assert.deepEqual(effects.values, []);
});

test('empty, whitespace-only and non-string messages reject before touching the page', async () => {
  const { document, effects } = page();
  const { window } = inject(document);
  await window.__ps5ContactReady;
  for (const text of ['', '  \n\t', undefined, null, 3, {}, ['message']]) {
    await assert.rejects(window.__ps5EnvoyerContact(text, { timeoutMs: 20 }), /message.*vide|texte.*vide/i);
  }
  assert.deepEqual(effects.clicks, []);
  assert.deepEqual(effects.values, []);
});

test('a loaded reply page without a message field is terminal and sends nothing', async () => {
  const { document, effects } = page({ field: false });
  const { window } = inject(document);
  await window.__ps5ContactReady;
  const result = await window.__ps5EnvoyerContact('Bonjour', { timeoutMs: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false, terminal: true, erreurCode: 'formulaire_absent',
  });
  assert.deepEqual(effects.clicks, []);
  assert.deepEqual(effects.values, []);
});

test('an absent or permanently disabled send button is terminal without a click', async () => {
  for (const options of [{ send: false }, { disabled: true }]) {
    const { document, effects } = page(options);
    const { window } = inject(document);
    await window.__ps5ContactReady;
    const result = await window.__ps5EnvoyerContact('A', { timeoutMs: 5 });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      ok: false, terminal: true, erreurCode: 'formulaire_absent',
    });
    assert.equal(effects.clicks.includes('send'), false);
  }
});

test('shared typing module is exposed only to the Leboncoin origin in the manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  const entries = manifest.web_accessible_resources.filter((entry) => entry.resources.includes('lib/typing.js'));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].matches, ['https://www.leboncoin.fr/*']);
});

function plain(value) { return JSON.parse(JSON.stringify(value)); }

for (const [nom, options, appel] of [
  ['stored dryRun', { settings: () => ({ dryRun: true }) }, {}],
  ['a stored non-boolean mode', { settings: () => ({ dryRun: 'false' }) }, {}],
  ['a stored null mode', { settings: () => ({ dryRun: null }) }, {}],
  ['corrupted stored settings', { settings: () => 'x' }, {}],
  ['null stored settings', { settings: () => null }, {}],
  ['dryRun at start of the operation', {}, { dryRun: true }],
]) {
  test(`${nom} types the message without clicking send`, async () => {
    const { document, effects, field } = page();
    const { window } = inject(document, options);
    await window.__ps5ContactReady;
    assert.deepEqual(plain(await window.__ps5EnvoyerContact('Ab', { timeoutMs: 20, ...appel })),
      { ok: true, clique: false, dryRun: true });
    assert.equal(field.value, 'Ab');
    assert.equal(effects.clicks.includes('send'), false);
  });
}

for (const [nom, settings] of [
  ['nothing stored (fresh install)', () => undefined],
  ['settings stored without a mode', () => ({ goodPrice: 300 })],
]) {
  test(`${nom} sends for real`, async () => {
    const { document, effects } = page();
    const { window } = inject(document, { settings });
    await window.__ps5ContactReady;
    assert.deepEqual(plain(await window.__ps5EnvoyerContact('Ab', { timeoutMs: 20 })), { ok: true, clique: true });
    assert.equal(effects.clicks.filter((click) => click === 'send').length, 1);
  });
}

test('dryRun is re-read after typing, right before the click', async () => {
  const { document, effects, field } = page();
  const { window } = inject(document, { settings: () => ({ dryRun: field.value === 'Ab' }) });
  await window.__ps5ContactReady;
  assert.equal((await window.__ps5EnvoyerContact('Ab', { timeoutMs: 20 })).dryRun, true);
  assert.equal(effects.clicks.includes('send'), false);
});

test('unreadable settings never click', async () => {
  const { document, effects } = page();
  const { window } = inject(document, { settings: () => { throw new Error('boom'); } });
  await window.__ps5ContactReady;
  const result = await window.__ps5EnvoyerContact('A', { timeoutMs: 20 });
  assert.equal(result.clique, false);
  assert.match(result.error, /rien n’a été envoyé/);
  assert.equal(effects.clicks.includes('send'), false);
});

test('an abort during typing stops typing and never clicks', async () => {
  const { document, effects, field } = page();
  const { window } = inject(document);
  await window.__ps5ContactReady;
  const dispatch = field.dispatchEvent.bind(field);
  field.dispatchEvent = (event) => { dispatch(event); if (field.value === 'A') window.__ps5ContactAnnule = true; };
  assert.deepEqual(plain(await window.__ps5EnvoyerContact('ABC', { timeoutMs: 20 })),
    { ok: false, clique: false, annule: true });
  assert.equal(field.value, 'A');
  assert.equal(effects.clicks.includes('send'), false);
});

test('an abort arriving during the last settings read prevents the click', async () => {
  const { document, effects } = page();
  let window;
  ({ window } = inject(document, { settings: () => { window.__ps5ContactAnnule = true; return { dryRun: false }; } }));
  await window.__ps5ContactReady;
  assert.equal((await window.__ps5EnvoyerContact('A', { timeoutMs: 20 })).annule, true);
  assert.equal(effects.clicks.includes('send'), false);
});

test('a page that left /reply/<listId> is never clicked', async () => {
  for (const pathname of ['/reply/999', '/messages']) {
    const { document, effects } = page();
    const location = { origin: 'https://www.leboncoin.fr', pathname: '/reply/123' };
    const { window } = inject(document, { location,
      settings: () => { location.pathname = pathname; return { dryRun: false }; } });
    await window.__ps5ContactReady;
    const result = await window.__ps5EnvoyerContact('A', { timeoutMs: 20, listId: '123' });
    assert.equal(result.clique, false);
    assert.match(result.error, /a changé/);
    assert.equal(effects.clicks.includes('send'), false);
  }
});

test('a DataDome page without a form is a block, not a missing form', async () => {
  const { document } = page({ field: false });
  document.title = 'Device Check';
  const { window } = inject(document);
  await window.__ps5ContactReady;
  assert.equal((await window.__ps5EnvoyerContact('A', { timeoutMs: 5 })).bloque, true);
});

test('a send button that vanishes after typing stays retryable', async () => {
  const options = {};
  const { document, effects, sendButton } = page(options);
  const { window } = inject(document, { settings: () => { sendButton.disabled = true; return { dryRun: false }; } });
  await window.__ps5ContactReady;
  const result = await window.__ps5EnvoyerContact('A', { timeoutMs: 20 });
  assert.equal(result.clique, false);
  assert.equal(result.terminal, undefined);
  assert.equal(effects.clicks.includes('send'), false);
});

test('an abort while waiting for the send button is an abort, not a missing form', async () => {
  const { document } = page({ disabled: true });
  const { window } = inject(document);
  await window.__ps5ContactReady;
  const pending = window.__ps5EnvoyerContact('A', { timeoutMs: 3000 });
  setTimeout(() => { window.__ps5ContactAnnule = true; }, 800);
  assert.equal((await pending).annule, true);
});
