import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createContact, urlReplyPourAnnonce } from '../extension/sw/run-contact.js';

const A = 'https://www.leboncoin.fr/ad/consoles/123';
const REPLY = 'https://www.leboncoin.fr/reply/123';
const SUCCESS = 'https://www.leboncoin.fr/reply/success/conversations?cat=43&adId=123';
const TOKEN = '12345678-1234-4234-8234-123456789abc';
const NOW = '2026-09-26T12:00:00.000Z';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function fixture({ status = 'complete', openedUrl = REPLY, sendResult = { ok: true, clique: true },
  onSend, acknowledgeSend, injectError, probeError, getError, createError, markContact, markError, reserve, release, finalize, timeoutMs = 25,
  formReady = true, sleep = async () => {}, settings = { dryRun: false }, settingsError,
  antiRobot = () => false, onAbort, saved = {}, journalEnvois } = {}) {
  const updated = new Set(), removed = new Set(), tabs = new Map(), log = [], envois = [];
  const event = (listeners) => ({ addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) });
  const navigate = (url, nextStatus = 'complete') => {
    const tab = tabs.get(7);
    if (!tab) return;
    Object.assign(tab, { url, status: nextStatus });
    for (const fn of [...updated]) fn(7, { url, status: nextStatus }, { ...tab });
  };
  const chrome = {
    storage: { local: { get: async () => {
      if (settingsError) throw new Error(settingsError);
      return { ps5_settings: settings, ...saved };
    }, set: async (valeurs) => { Object.assign(saved, valeurs); } } },
    tabs: {
      onUpdated: event(updated), onRemoved: event(removed),
      create: async (options) => {
        log.push(['open', options]);
        if (createError) throw new Error(createError);
        tabs.set(7, { id: 7, status, url: openedUrl });
        return { id: 7, status: 'loading', url: options.url };
      },
      get: async (id) => { if (typeof getError === 'function') await getError(); else if (getError) throw new Error(getError); return tabs.get(id); },
      remove: async (id) => { log.push(['close', id]); tabs.delete(id); },
    },
    scripting: { executeScript: async ({ target, files, func, args, world }) => {
      assert.equal(target.tabId, 7);
      assert.equal(world, 'ISOLATED');
      if (files) {
        assert.deepEqual(files, ['content/contact.js']);
        log.push(['inject']);
        if (injectError) throw new Error(injectError);
        tabs.get(7).window = {
          __ps5ContactReady: Promise.resolve(),
          __ps5EnvoyerContact: async (text, options) => {
            log.push(['send', text]);
            envois.push(options);
            await onSend?.({ navigate, tabs, log });
            if (sendResult instanceof Error) throw sendResult;
            return typeof sendResult === 'function' ? sendResult() : sendResult;
          },
        };
        return [{}];
      }
      if (func.name === 'sonderAntiRobot') return [{ result: { antiRobot: antiRobot(tabs.get(7)) } }];
      if (func.name === 'annulerEnvoiContact') { log.push(['abort']); await onAbort?.(); return [{}]; }
      if (probeError && !args?.length) throw new Error(probeError);
      const result = await vm.runInNewContext(`(${func.toString()})(...args)`, {
        window: tabs.get(7).window,
        document: { querySelector: (selector) => selector === 'textarea#body'
          && (typeof formReady === 'function' ? formReady() : formReady) },
        args: args ?? [],
      });
      return args?.length && acknowledgeSend ? acknowledgeSend(result) : [{ result }];
    } },
  };
  const api = {
    reserverContact: async (url) => {
      log.push(['reserve', url]);
      return reserve ? reserve(url) : { reservee: true, reservation_token: TOKEN, reservation_le: NOW };
    },
    libererContact: async (url, token) => {
      log.push(['release', url, token]);
      return release ? release(url, token) : { liberee: true };
    },
    finaliserContact: async (url, token, resultat) => {
      log.push(['finalize', url, token, resultat]);
      if (finalize) return finalize(url, token, resultat);
      if (resultat === 'confirme') return markContact ? markContact(url) : { contacte_le: NOW };
      return markError ? markError(url, 'envoi_incertain', token) : {
        contact_erreur_code: 'envoi_incertain', contact_erreur_le: NOW,
      };
    },
    marquerContactee: async (url) => {
      log.push(['mark-contacted', url]);
      return markContact ? markContact(url) : { contacte_le: '2026-09-26T12:00:00.000Z' };
    },
    marquerErreurContact: async (url, code, token) => {
      log.push(['mark-error', url, code, token]);
      return markError ? markError(url, code, token) : {
        contact_erreur_code: code, contact_erreur_le: '2026-09-26T12:00:00.000Z',
      };
    },
  };
  const contact = createContact({ chrome, api, timeoutMs, sleep, journalEnvois });
  return { contact, chrome, log, envois, saved, tabs, updated, removed, navigate,
    complete(url = openedUrl) { navigate(url, 'complete'); },
    close() { tabs.delete(7); for (const fn of [...removed]) fn(7); },
  };
}

test('converts only strict Leboncoin ad URLs to deterministic reply URLs', () => {
  assert.equal(urlReplyPourAnnonce(A), REPLY);
  assert.equal(urlReplyPourAnnonce(`${A}?foo=bar`), REPLY);
  for (const url of ['https://www.leboncoin.fr/messages', 'https://evil.example/ad/consoles/123',
    'https://www.leboncoin.fr/ad/consoles/123/extra', 'javascript:alert(1)', undefined]) {
    assert.equal(urlReplyPourAnnonce(url), null);
  }
});

test('opens reply, sends once, verifies the exact success adId, then marks contacted', async () => {
  const f = fixture({ onSend: async ({ navigate }) => navigate(SUCCESS) });
  const result = await f.contact.envoyerContact(A, 'Bonjour personnalisé');
  assert.deepEqual(result, { ok: true, envoye: true, suivi: true, tabId: 7 });
  assert.deepEqual(f.log.slice(0, 2), [
    ['reserve', A],
    ['open', { url: REPLY, active: true }],
  ]);
  assert.deepEqual(f.log, [
    ['reserve', A], ['open', { url: REPLY, active: true }], ['inject'], ['send', 'Bonjour personnalisé'],
    ['finalize', A, TOKEN, 'confirme'], ['close', 7],
  ]);
  assert.equal(f.tabs.size, 0);
  assert.equal(f.updated.size + f.removed.size, 0);
});

test('waits for the reply form before injection', async () => {
  let ready = false;
  const gate = deferred();
  const f = fixture({
    status: 'loading',
    formReady: () => ready,
    sleep: () => gate.promise,
    onSend: async ({ navigate }) => navigate(SUCCESS),
    timeoutMs: 100,
  });
  const pending = f.contact.envoyerContact(A, 'Bonjour');
  await tick();
  assert.deepEqual(f.log, [['reserve', A], ['open', { url: REPLY, active: true }]]);
  ready = true;
  gate.resolve();
  assert.equal((await pending).ok, true);
});

test('uses a ready reply form even while Chrome still reports the tab as loading', async () => {
  const f = fixture({
    status: 'loading',
    timeoutMs: 10,
    onSend: async ({ navigate }) => navigate(SUCCESS),
  });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.ok, true);
  assert.equal(f.log.filter(([type]) => type === 'send').length, 1);
});

test('a loading reply without a form times out as retryable and is never persisted', async () => {
  const f = fixture({ status: 'loading', formReady: false, timeoutMs: 0 });
  await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), /chargement.*expiré/i);
  assert.equal(f.log.some(([type]) => type === 'mark-error'), false);
  assert.deepEqual(f.log.filter(([type]) => type === 'release'), [['release', A, TOKEN]]);
  assert.deepEqual(f.log.at(-1), ['close', 7]);
});

test('a completed reply without a form is persisted as terminal', async () => {
  const f = fixture({ status: 'complete', formReady: false, timeoutMs: 0 });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.skip, true);
  assert.equal(result.erreurCode, 'formulaire_absent');
  assert.deepEqual(f.log.slice(-2), [['mark-error', A, 'formulaire_absent', TOKEN], ['close', 7]]);
  assert.equal(f.log.some(([type]) => type === 'release'), false);
});

test('a DOM probe failure stays retryable and is never persisted as a missing form', async () => {
  const f = fixture({ status: 'complete', formReady: false, probeError: 'sonde refusée', timeoutMs: 0 });
  await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), /sonde refusée/i);
  assert.equal(f.log.some(([type]) => type === 'mark-error'), false);
  assert.deepEqual(f.log.filter(([type]) => type === 'release'), [['release', A, TOKEN]]);
  assert.deepEqual(f.log.at(-1), ['close', 7]);
});

test('a loaded redirect without reply support is persisted and skipped without sending', async () => {
  const f = fixture({ openedUrl: 'https://www.leboncoin.fr/ad/consoles/123' });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.ok, false);
  assert.equal(result.skip, true);
  assert.equal(result.erreurCode, 'reply_indisponible');
  assert.deepEqual(f.log, [
    ['reserve', A], ['open', { url: REPLY, active: true }], ['mark-error', A, 'reply_indisponible', TOKEN], ['close', 7],
  ]);
});

test('a login redirect before send dispatch stays retryable without database error', async () => {
  const login = fixture({ openedUrl: 'https://www.leboncoin.fr/compte/connexion?error=login_required' });
  await assert.rejects(login.contact.envoyerContact(A, 'Bonjour'), /connexion|session/i);
  assert.equal(login.log.some(([type]) => type === 'mark-error'), false);
  assert.deepEqual(login.log.filter(([type]) => type === 'release'), [['release', A, TOKEN]]);
  assert.deepEqual(login.log.at(-1), ['close', 7]);
});

test('terminal content result is persisted and closes the unsent tab', async () => {
  const f = fixture({ sendResult: { ok: false, terminal: true, erreurCode: 'formulaire_absent' } });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.deepEqual(result, {
    ok: false, envoye: false, skip: true, suivi: true,
    erreurCode: 'formulaire_absent', tabId: 7,
    error: 'Cette annonce ne permet pas l’envoi d’un message.',
  });
  assert.deepEqual(f.log.slice(-2), [['mark-error', A, 'formulaire_absent', TOKEN], ['close', 7]]);
  assert.equal(f.log.some(([type]) => type === 'release'), false);
  assert.equal(f.log.some(([type]) => type === 'mark-contacted'), false);
});

test('a click without exact success becomes uncertain, is persisted, and keeps the tab', async () => {
  for (const onSend of [undefined, async ({ navigate }) => navigate('https://www.leboncoin.fr/reply/success/conversations?adId=999')]) {
    const f = fixture({ onSend, timeoutMs: 5 });
    const result = await f.contact.envoyerContact(A, 'Bonjour');
    assert.equal(result.ok, false);
    assert.equal(result.skip, true);
    assert.equal(result.erreurCode, 'envoi_incertain');
    assert.deepEqual(f.log.at(-1), ['finalize', A, TOKEN, 'incertain']);
    assert.equal(f.log.some(([type]) => type === 'release'), false);
    assert.equal(f.tabs.size, 1);
    assert.equal(f.log.some(([type]) => type === 'mark-contacted'), false);
  }
});

test('tracking failure after verified send reports partial success and keeps the success tab', async () => {
  const f = fixture({
    onSend: async ({ navigate }) => navigate(SUCCESS),
    markContact: async () => { throw new Error('Serveur indisponible'); },
  });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.ok, false);
  assert.equal(result.envoye, true);
  assert.equal(result.suivi, false);
  assert.match(result.error, /envoyé.*suivi.*échoué/i);
  assert.equal(f.tabs.size, 1);
  assert.equal(f.log.some(([type]) => type === 'release'), false);
});

test('invalid inputs and simultaneous sends cannot open a second tab', async () => {
  const f = fixture();
  for (const url of ['https://evil.example/ad/consoles/123', 'https://www.leboncoin.fr/messages', undefined]) {
    await assert.rejects(f.contact.envoyerContact(url, 'Bonjour'), /URL.*annonce/i);
  }
  for (const text of ['', '  ', null, {}]) await assert.rejects(f.contact.envoyerContact(A, text), /message/i);
  assert.deepEqual(f.log, []);

  const gate = deferred();
  const busy = fixture({ onSend: () => gate.promise, timeoutMs: 100 });
  const first = busy.contact.envoyerContact(A, 'Bonjour');
  await tick();
  await assert.rejects(busy.contact.envoyerContact(A, 'Encore'), /cours/i);
  assert.equal(busy.log.filter(([type]) => type === 'open').length, 1);
  assert.equal(busy.log.filter(([type]) => type === 'reserve').length, 1);
  gate.resolve(); busy.navigate(SUCCESS);
  await first;
});

test('browser failures before send dispatch close only the created tab and never mark', async () => {
  for (const options of [
    { createError: 'création refusée' },
    { injectError: 'injection refusée' }, { getError: 'onglet introuvable' },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'));
    assert.equal(f.log.some(([type]) => type.startsWith('mark-')), false);
    assert.equal(f.tabs.size, 0);
    assert.deepEqual(f.log.filter(([type]) => type === 'release'), [['release', A, TOKEN]]);
    assert.equal(f.updated.size + f.removed.size, 0);
  }
});

for (const [acknowledgement, acknowledgeSend] of [
  ['rejected', () => { throw new Error('contexte détruit'); }],
  ['missing', () => []],
]) {
  for (const navigation of ['absent', 'delayed']) {
    test(`a ${acknowledgement} send acknowledgement with ${navigation} success stays uncertain and never releases`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = fixture({ acknowledgeSend, onSend: navigation === 'delayed'
        ? ({ navigate }) => { setTimeout(() => navigate(SUCCESS), 50); }
        : undefined });
      const result = await f.contact.envoyerContact(A, 'Bonjour');
      assert.equal(result.erreurCode, 'envoi_incertain');
      assert.equal(result.suivi, true);
      assert.equal(result.skip, true);
      assert.deepEqual(f.log.filter(([type]) => ['finalize', 'release', 'mark-error'].includes(type)), [
        ['finalize', A, TOKEN, 'incertain'],
      ]);
      assert.equal(f.tabs.size, 1);
      assert.equal(f.updated.size + f.removed.size, 0);
      t.mock.timers.tick(50);
      assert.equal(f.tabs.get(7).url, navigation === 'delayed' ? SUCCESS : REPLY);
      assert.equal(f.log.some(([type]) => ['release', 'close'].includes(type)), false);
    });
  }
}

for (const [description, sendResult] of [
  ['missing result', null],
  ['nonterminal failure', { ok: false }],
  ['terminal result after a click', { ok: false, terminal: true, erreurCode: 'formulaire_absent', clique: true }],
  ['contradictory terminal result', { ok: true, terminal: true, erreurCode: 'formulaire_absent' }],
  ['uncertain terminal result', { ok: false, terminal: true, erreurCode: 'envoi_incertain' }],
]) {
  test(`a ${description} cannot be treated as positive pre-click evidence`, async () => {
    const f = fixture({ sendResult });
    const result = await f.contact.envoyerContact(A, 'Bonjour');
    assert.equal(result.erreurCode, 'envoi_incertain');
    assert.deepEqual(f.log.filter(([type]) => ['finalize', 'release', 'mark-error'].includes(type)), [
      ['finalize', A, TOKEN, 'incertain'],
    ]);
    assert.equal(f.tabs.size, 1);
  });
}

test('a rejected send acknowledgement keeps the tab and reservation when uncertain finalization fails', async () => {
  const f = fixture({ sendResult: new Error('Accès temporairement restreint'),
    finalize: async () => { throw new Error('base indisponible'); } });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.erreurCode, 'envoi_incertain');
  assert.equal(result.suivi, false);
  assert.match(result.error, /base indisponible/);
  assert.deepEqual(f.log.filter(([type]) => ['finalize', 'release', 'mark-error'].includes(type)), [
    ['finalize', A, TOKEN, 'incertain'],
  ]);
  assert.equal(f.tabs.size, 1);
});

test('a refused reservation skips before any browser work and clears the local guard', async () => {
  const f = fixture({ reserve: async () => ({ reservee: false, raison: 'deja_contacte' }) });
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await f.contact.envoyerContact(A, 'Bonjour'), {
      ok: false, envoye: false, skip: true, dedoublonne: true, raison: 'deja_contacte',
    });
  }
  assert.deepEqual(f.log, [['reserve', A], ['reserve', A]]);
});

test('reservation errors and malformed grants fail closed before opening a tab', async () => {
  for (const response of [null, {}, { reservee: true },
    { reservee: true, reservation_token: 'bad', reservation_le: NOW },
    { reservee: true, reservation_token: TOKEN, reservation_le: 'bad' }]) {
    const f = fixture({ reserve: async () => response });
    await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), /réservation/i);
    assert.deepEqual(f.log, [['reserve', A]]);
  }
  const f = fixture({ reserve: async () => { throw new Error('réservation indisponible'); } });
  await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), /indisponible/);
  assert.deepEqual(f.log, [['reserve', A]]);
});

test('release failure retains the original pre-click error and reports the retained reservation', async () => {
  const f = fixture({ injectError: 'injection refusée', release: async () => { throw new Error('base indisponible'); } });
  await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), (error) => {
    assert.match(error.message, /injection refusée/);
    assert.match(error.message, /réservation.*conservée/i);
    assert.match(error.message, /base indisponible/);
    return true;
  });
  assert.deepEqual(f.log.filter(([type]) => type === 'release'), [['release', A, TOKEN]]);
  assert.equal(f.tabs.size, 0);
});

test('terminal persistence failure remains fail-closed without releasing', async () => {
  const f = fixture({ formReady: false, timeoutMs: 0, markError: async () => { throw new Error('base indisponible'); } });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.terminal, true);
  assert.equal(result.suivi, false);
  assert.equal(f.log.some(([type]) => type === 'release'), false);
});

test('uncertain persistence failure keeps the clicked tab and reservation', async () => {
  const f = fixture({ timeoutMs: 0, finalize: async () => { throw new Error('base indisponible'); } });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.erreurCode, 'envoi_incertain');
  assert.equal(result.suivi, false);
  assert.match(result.error, /suivi.*échoué/i);
  assert.equal(f.tabs.size, 1);
  assert.equal(f.log.some(([type]) => type === 'release'), false);
});

test('typing longer than timeout still gets a fresh confirmation window after the click', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const gate = deferred();
  const f = fixture({ timeoutMs: 100, onSend: () => gate.promise });
  const pending = f.contact.envoyerContact(A, 'Bonjour');
  await tick();
  assert.equal(f.updated.size, 1);
  assert.equal(f.removed.size, 1);
  t.mock.timers.tick(500);
  gate.resolve();
  await tick();
  t.mock.timers.tick(50);
  f.navigate(SUCCESS);
  assert.equal((await pending).ok, true);
  assert.deepEqual(f.log.filter(([type]) => type === 'finalize'), [['finalize', A, TOKEN, 'confirme']]);
});

test('tab lookup failure after the click finalizes uncertain and never releases', async () => {
  let reads = 0;
  const f = fixture({ getError: () => { if (++reads === 2) throw new Error('onglet perdu'); } });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.erreurCode, 'envoi_incertain');
  assert.deepEqual(f.log.filter(([type]) => type === 'finalize'), [['finalize', A, TOKEN, 'incertain']]);
  assert.equal(f.log.some(([type]) => type === 'release'), false);
  assert.equal(f.tabs.size, 1);
  assert.equal(f.updated.size + f.removed.size, 0);
});

for (const [acknowledgement, sendResult] of [['rejected', new Error('contexte détruit')], ['missing', null]]) {
  test(`observed exact success finalizes confirmed despite ${acknowledgement} script acknowledgement`, async () => {
    const f = fixture({ onSend: async ({ navigate }) => navigate(SUCCESS), sendResult });
    assert.deepEqual(await f.contact.envoyerContact(A, 'Bonjour'), {
      ok: true, envoye: true, suivi: true, tabId: 7,
    });
    assert.deepEqual(f.log.filter(([type]) => ['finalize', 'release', 'mark-error'].includes(type)), [
      ['finalize', A, TOKEN, 'confirme'],
    ]);
    assert.deepEqual(f.log.slice(-2), [['finalize', A, TOKEN, 'confirme'], ['close', 7]]);
    assert.equal(f.updated.size + f.removed.size, 0);
  });
}

test('success observed before acknowledgement keeps the tab and reservation if finalization fails', async () => {
  const f = fixture({ onSend: async ({ navigate }) => navigate(SUCCESS),
    sendResult: new Error('contexte détruit'), finalize: async () => { throw new Error('base indisponible'); } });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.envoye, true);
  assert.equal(result.suivi, false);
  assert.match(result.error, /base indisponible/);
  assert.deepEqual(f.log.filter(([type]) => ['finalize', 'release', 'mark-error'].includes(type)), [
    ['finalize', A, TOKEN, 'confirme'],
  ]);
  assert.equal(f.tabs.size, 1);
});

test('already observed success skips the redundant post-click tab lookup', async () => {
  let reads = 0;
  const f = fixture({ onSend: async ({ navigate }) => navigate(SUCCESS),
    getError: () => { if (++reads === 2) throw new Error('onglet perdu'); } });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.ok, true);
  assert.equal(reads, 1);
  assert.deepEqual(f.log.filter(([type]) => ['finalize', 'release'].includes(type)), [
    ['finalize', A, TOKEN, 'confirme'],
  ]);
});

test('success arriving during a failing post-click lookup wins over its rejection', async () => {
  let reads = 0;
  const f = fixture({ getError: async () => {
    if (++reads === 2) {
      f.navigate(SUCCESS);
      throw new Error('onglet perdu');
    }
  } });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.ok, true);
  assert.deepEqual(f.log.filter(([type]) => ['finalize', 'release'].includes(type)), [
    ['finalize', A, TOKEN, 'confirme'],
  ]);
  assert.equal(f.updated.size + f.removed.size, 0);
});

// --- Mode test, annulation, cible et anti-robot ----------------------------

const suivis = (f) => f.log.filter(([type]) => ['finalize', 'release', 'mark-error', 'mark-contacted'].includes(type));
const SIMULE = { ok: true, clique: false, dryRun: true };

test('dry run releases the reservation, records nothing and keeps the typed tab open', async () => {
  const f = fixture({ settings: { dryRun: true }, sendResult: SIMULE });
  assert.deepEqual(await f.contact.envoyerContact(A, 'Bonjour'),
    { ok: true, envoye: false, dryRun: true, tabId: 7 });
  assert.deepEqual(suivis(f), [['release', A, TOKEN]]);
  assert.equal(f.tabs.size, 1);
  assert.equal(f.envois[0].dryRun, true);
  assert.equal(f.envois[0].listId, '123');
});

test('only one simulation reply tab stays open, and a tab the user moved is left alone', async () => {
  for (const [url, ferme] of [['https://www.leboncoin.fr/reply/999', true],
    ['https://www.leboncoin.fr/messages', false], ['https://www.leboncoin.fr/reply/success/conversations?adId=999', false]]) {
    const f = fixture({ settings: { dryRun: true }, sendResult: SIMULE,
      saved: { ps5_onglet_simulation: { tabId: 3, listId: '999' } } });
    f.tabs.set(3, { id: 3, url, status: 'complete' });
    assert.equal((await f.contact.envoyerContact(A, 'Bonjour')).dryRun, true);
    assert.equal(f.tabs.has(3), !ferme, url);
    assert.equal(f.tabs.has(7), true);
    assert.deepEqual(f.saved.ps5_onglet_simulation, { tabId: 7, listId: '123' });
  }
});

test('with nothing stored the contact is a real send', async () => {
  const f = fixture({ saved: { ps5_settings: undefined }, onSend: async ({ navigate }) => navigate(SUCCESS) });
  assert.equal((await f.contact.envoyerContact(A, 'Bonjour')).envoye, true);
  assert.equal(f.envois[0].dryRun, false);
});

test('corrupted settings stay in dry run, and unreadable settings send nothing at all', async () => {
  const defaut = fixture({ settings: null, sendResult: SIMULE });
  assert.equal((await defaut.contact.envoyerContact(A, 'Bonjour')).dryRun, true);
  assert.equal(defaut.envois[0].dryRun, true);
  const f = fixture({ settingsError: 'stockage cassé' });
  await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), /stockage cassé/);
  assert.deepEqual(f.log, []);
});

test('dry run switched on during typing is honoured from the content result', async () => {
  const f = fixture({ sendResult: SIMULE });
  assert.equal((await f.contact.envoyerContact(A, 'Bonjour')).dryRun, true);
  assert.deepEqual(suivis(f), [['release', A, TOKEN]]);
  assert.equal(f.tabs.size, 1);
});

test('a lost acknowledgement in dry run cannot be an uncertain send', async () => {
  const f = fixture({ settings: { dryRun: true }, sendResult: null });
  await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), /Accusé/);
  assert.deepEqual(suivis(f), [['release', A, TOKEN]]);
});

test('dry run never persists a terminal contact error', async () => {
  for (const options of [{ formReady: false, timeoutMs: 0 },
    { openedUrl: 'https://www.leboncoin.fr/ad/consoles/123' },
    { sendResult: { ok: false, terminal: true, erreurCode: 'formulaire_absent' } }]) {
    const f = fixture({ ...options, settings: { dryRun: true } });
    const result = await f.contact.envoyerContact(A, 'Bonjour');
    assert.equal(result.dryRun, true);
    assert.equal(result.skip, true);
    assert.deepEqual(suivis(f), [['release', A, TOKEN]]);
    assert.equal(f.tabs.size, 0);
  }
});

test('dry run reports a reservation that could not be released', async () => {
  const f = fixture({ settings: { dryRun: true }, sendResult: SIMULE,
    release: async () => { throw new Error('base indisponible'); } });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.ok, false);
  assert.equal(result.dryRun, true);
  assert.match(result.error, /réservation.*base indisponible/i);
  assert.equal(f.tabs.size, 1);
});

for (const [nom, options] of [
  ['no form', { formReady: false, timeoutMs: 0 }],
  ['redirect', { openedUrl: 'https://www.leboncoin.fr/blocked' }],
  ['load timeout', { status: 'loading', formReady: false, timeoutMs: 0 }],
  ['content terminal result', { sendResult: { ok: false, terminal: true, erreurCode: 'formulaire_absent' } }],
  ['injection failure', { injectError: 'injection refusée' }],
]) {
  test(`an anti-bot page (${nom}) blocks without any terminal record and releases`, async () => {
    const f = fixture({ ...options, antiRobot: () => true });
    await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), /leboncoin a restreint/);
    assert.deepEqual(suivis(f), [['release', A, TOKEN]]);
    assert.equal(f.tabs.size, 1, 'la page de vérification reste visible');
  });
}

test('an off-site DataDome challenge is detected from its URL', async () => {
  const f = fixture({ openedUrl: 'https://geo.captcha-delivery.com/captcha/?x=1' });
  await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), /leboncoin a restreint/);
  assert.deepEqual(suivis(f), [['release', A, TOKEN]]);
});

test('a structured pre-click block result releases instead of becoming uncertain', async () => {
  const f = fixture({ sendResult: { ok: false, clique: false, bloque: true } });
  await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), /leboncoin a restreint/);
  assert.deepEqual(suivis(f), [['release', A, TOKEN]]);
});

test('an anti-bot page after the click stays uncertain and is flagged as blocked', async () => {
  const f = fixture({ timeoutMs: 5, antiRobot: () => true });
  const result = await f.contact.envoyerContact(A, 'Bonjour');
  assert.equal(result.erreurCode, 'envoi_incertain');
  assert.equal(result.bloque, true);
  assert.deepEqual(suivis(f), [['finalize', A, TOKEN, 'incertain']]);
});

for (const [nom, sendResult] of [
  ['wrong target', { ok: false, clique: false, error: 'La page de réponse a changé : rien n’a été envoyé.' }],
  ['content failure', { ok: false, clique: false, error: 'Réglages illisibles : rien n’a été envoyé.' }],
]) {
  test(`a proven pre-click ${nom} releases and records nothing`, async () => {
    const f = fixture({ sendResult });
    await assert.rejects(f.contact.envoyerContact(A, 'Bonjour'), /rien n’a été envoyé/);
    assert.deepEqual(suivis(f), [['release', A, TOKEN]]);
    assert.equal(f.tabs.size, 0);
  });
}

test('an already aborted signal opens nothing', async () => {
  const f = fixture();
  const result = await f.contact.envoyerContact(A, 'Bonjour', { signal: AbortSignal.abort() });
  assert.equal(result.annule, true);
  assert.deepEqual(f.log, []);
});

test('abort while waiting for the form releases, closes and never injects', async () => {
  const controleur = new AbortController();
  const f = fixture({ formReady: false, timeoutMs: 1000, sleep: async () => controleur.abort() });
  const result = await f.contact.envoyerContact(A, 'Bonjour', { signal: controleur.signal });
  assert.equal(result.annule, true);
  assert.equal(f.log.some(([type]) => type === 'inject'), false);
  assert.deepEqual(suivis(f), [['release', A, TOKEN]]);
  assert.equal(f.tabs.size, 0);
});

test('abort during typing is forwarded to the tab and releases when nothing was clicked', async () => {
  const controleur = new AbortController();
  const arret = deferred();
  const f = fixture({ onAbort: () => arret.resolve(),
    onSend: async () => { controleur.abort(); await arret.promise; },
    sendResult: { ok: false, clique: false, annule: true } });
  const result = await f.contact.envoyerContact(A, 'Bonjour', { signal: controleur.signal });
  assert.equal(result.annule, true);
  assert.equal(f.log.some(([type]) => type === 'abort'), true);
  assert.deepEqual(suivis(f), [['release', A, TOKEN]]);
  assert.equal(f.tabs.size, 0);
});

const journal = () => { const entries = []; return { entries, record: async (entry) => { entries.push(entry); } }; };

test('journal: a confirmed first contact is recorded once as real, even when tracking then fails', async () => {
  for (const finalize of [undefined, () => { throw new Error('base arrêtée'); }]) {
    const j = journal();
    const f = fixture({ journalEnvois: j, finalize, onSend: async ({ navigate }) => navigate(SUCCESS) });
    const result = await f.contact.envoyerContact(A, 'Bonjour', { vendeur: 'Alice' });
    assert.equal(result.envoye, true);
    assert.deepEqual(j.entries, [{ kind: 'premier_contact', simulated: false, vendeur: 'Alice', message: 'Bonjour', url: A }]);
  }
});

test('journal: an uncertain, refused or failed send is never recorded', async () => {
  for (const options of [
    {},
    { sendResult: { ok: false, clique: false, error: 'rien' } },
    { sendResult: new Error('accusé perdu') },
    { sendResult: { ok: false, terminal: true, erreurCode: 'formulaire_absent' } },
    { reserve: () => ({ reservee: false, raison: 'vendeur_contacte' }) },
  ]) {
    const j = journal();
    const f = fixture({ journalEnvois: j, ...options });
    await f.contact.envoyerContact(A, 'Bonjour').catch(() => {});
    assert.deepEqual(j.entries, []);
  }
});

test('journal: a typed simulation is recorded as simulated, a failed simulation is not', async () => {
  const j = journal();
  const f = fixture({ journalEnvois: j, settings: { dryRun: true }, sendResult: { ok: true, clique: false, dryRun: true } });
  await f.contact.envoyerContact(A, 'Bonjour', { vendeur: 'Alice' });
  assert.deepEqual(j.entries, [{ kind: 'premier_contact', simulated: true, vendeur: 'Alice', message: 'Bonjour', url: A }]);
  const absent = journal();
  await fixture({ journalEnvois: absent, settings: { dryRun: true }, formReady: false }).contact.envoyerContact(A, 'Bonjour');
  assert.deepEqual(absent.entries, []);
});

test('journal: a throwing or hanging journal changes nothing in the send result', async () => {
  for (const record of [() => { throw new Error('x'); }, async () => { throw new Error('x'); }, () => new Promise(() => {})]) {
    const f = fixture({ journalEnvois: { record }, onSend: async ({ navigate }) => navigate(SUCCESS) });
    assert.deepEqual(await f.contact.envoyerContact(A, 'Bonjour'), { ok: true, envoye: true, suivi: true, tabId: 7 });
    assert.ok(f.log.some(([name]) => name === 'finalize'));
  }
});
