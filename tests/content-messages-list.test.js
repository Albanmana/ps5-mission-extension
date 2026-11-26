import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../extension/content/messages-list.js', import.meta.url), 'utf8');

function inject({ blocked = false, login = false, allRows = [], unread = [], staleUnread = [], settleDelayMs = 0,
  listContainer = true, rowsDelayMs = 0, scrolledRows = [] } = {}) {
  const injectedAt = Date.now();
  let clickedAt = 0;
  const observers = new Set();
  const all = { value: 'all', pressed: true, getAttribute(name) { return name === 'aria-pressed' ? String(this.pressed) : this.value; }, click() {
    this.pressed = true; unreadChip.pressed = false; clickedAt = Date.now();
    setTimeout(() => { for (const observer of observers) observer.callback([{ type: 'childList' }]); }, settleDelayMs);
  } };
  const unreadChip = { value: 'unread', pressed: false, getAttribute(name) { return name === 'aria-pressed' ? String(this.pressed) : this.value; }, click() {
    this.pressed = true; all.pressed = false; clickedAt = Date.now();
    setTimeout(() => { for (const observer of observers) observer.callback([{ type: 'childList' }]); }, settleDelayMs);
  } };
  const scrollList = {
    clientHeight: 100,
    scrollHeight: scrolledRows.length ? 200 : 100,
    scrollTop: 0,
    dispatchEvent() {},
  };
  const filterList = { clientHeight: 40, scrollHeight: 40, scrollTop: 0, dispatchEvent() {} };
  const document = {
    body: { textContent: blocked ? 'Accès temporairement restreint' : 'Messagerie' },
    querySelector(selector) {
      if (selector.includes('value="unread"')) return unreadChip;
      if (selector.includes('value="all"')) return all;
      if (selector === '[aria-label="Liste des conversations"] [role="list"]') return listContainer ? scrollList : null;
      if (selector.includes('Liste des conversations')) return listContainer ? this.body : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[aria-label="Liste des conversations"] [role="list"]') {
        return listContainer ? [filterList, scrollList] : [];
      }
      if (selector === 'a[href^="/messages/id/"]') {
        const visibleAllRows = scrollList.scrollTop > 0 && scrolledRows.length ? scrolledRows : allRows;
        const rows = all.pressed ? (Date.now() - injectedAt >= rowsDelayMs ? visibleAllRows : [])
          : (Date.now() - clickedAt >= settleDelayMs ? unread : staleUnread);
        return rows.map((row) => {
          const value = typeof row === 'string' ? { href: row, preview: row } : row;
          return {
            getAttribute: () => value.href,
            textContent: value.preview,
            innerText: value.preview,
            querySelectorAll(selector) {
              if (selector !== 'p') return [];
              return [value.title, value.message].filter(Boolean).map((innerText) => ({ innerText, textContent: innerText }));
            },
            querySelector(selector) {
              if (selector !== 'span') return null;
              const innerText = [value.seller, value.time].filter(Boolean).join(' - ');
              return innerText ? { innerText, textContent: innerText } : null;
            },
          };
        });
      }
      return [];
    },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const context = vm.createContext({ window: {}, document, MutationObserver, URL, location: {
    href: login ? 'https://auth.leboncoin.fr/login' : 'https://www.leboncoin.fr/messages',
    origin: 'https://www.leboncoin.fr',
  }, setTimeout, clearTimeout });
  new vm.Script(source).runInContext(context);
  return { window: context.window, all, unreadChip };
}

test('rend la première conversation même lue quand son aperçu a changé', async () => {
  const href = '/messages/id/00000000-0000-4000-8000-000000000101';
  const f = inject({ allRows: [{ href, preview: 'PlayStation 5 La PS5 est à 500 VendeurGamma' }] });
  const result = await f.window.__ps5ChoisirCandidate({ previousPreviews: {
    [`https://www.leboncoin.fr${href}`]: { preview: 'PlayStation 5 Toujours disponible VendeurGamma' },
  }, timeoutMs: 20 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    url_conversation: `https://www.leboncoin.fr${href}`,
    preview: 'PlayStation 5 La PS5 est à 500 VendeurGamma',
    source: 'first_changed',
  });
  assert.equal(f.all.pressed, true);
});

test('ignore le temps relatif de la liste pour ne pas rouvrir la première conversation chaque minute', async () => {
  const href = '/messages/id/00000000-0000-4000-8000-000000000101';
  const row = {
    href,
    title: 'PlayStation 5',
    message: 'Message fictif : la console est à 500€',
    seller: 'VendeurGamma',
    time: 'il y a 48 min',
    preview: 'PlayStation 5 Message fictif : la console est à 500€ VendeurGamma - il y a 48 min',
  };
  const stablePreview = 'PlayStation 5 Message fictif : la console est à 500€ VendeurGamma';
  const f = inject({ allRows: [row] });
  const result = await f.window.__ps5ChoisirCandidate({ previousPreviews: {
    [`https://www.leboncoin.fr${href}`]: { preview: stablePreview },
  }, timeoutMs: 20 });
  assert.equal(result, null);
});

test('retombe sur le premier non-lu quand la première conversation est inchangée', async () => {
  const first = '/messages/id/00000000-0000-4000-8000-000000000101';
  const unread = '/messages/id/cccccccc-1111-2222-3333-dddddddddddd';
  const preview = 'PlayStation 5 Mon dernier message VendeurGamma';
  const f = inject({
    allRows: [{ href: first, preview }],
    unread: [{ href: unread, preview: 'Ps5 Oui elle est disponible VendeurEpsilon' }],
  });
  const result = await f.window.__ps5ChoisirCandidate({ previousPreviews: {
    [`https://www.leboncoin.fr${first}`]: { preview },
  }, timeoutMs: 20 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    url_conversation: `https://www.leboncoin.fr${unread}`,
    preview: 'Ps5 Oui elle est disponible VendeurEpsilon',
    source: 'unread',
  });
  assert.equal(f.unreadChip.pressed, true);
});

test('préfère un non-lu à un aperçu changé par notre propre réponse', async () => {
  const changed = '/messages/id/00000000-0000-4000-8000-000000000101';
  const unread = '/messages/id/cccccccc-1111-2222-3333-dddddddddddd';
  const f = inject({
    allRows: [{ href: changed, preview: 'PS5 Notre réponse VendeurDelta' }],
    unread: [{ href: unread, preview: 'PS5 Oui disponible VendeurBeta' }],
  });
  const result = await f.window.__ps5ChoisirCandidate({ previousPreviews: {
    [`https://www.leboncoin.fr${changed}`]: { preview: 'PS5 Réponse vendeur VendeurDelta' },
  }, timeoutMs: 20 });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    url_conversation: `https://www.leboncoin.fr${unread}`,
    preview: 'PS5 Oui disponible VendeurBeta',
    source: 'unread',
  });
});

test('rend null quand la première conversation est inchangée et aucun non-lu ne reste', async () => {
  const href = '/messages/id/00000000-0000-4000-8000-000000000101';
  const preview = 'PlayStation 5 Mon dernier message VendeurGamma';
  const f = inject({ allRows: [{ href, preview }] });
  assert.equal(await f.window.__ps5ChoisirCandidate({ previousPreviews: {
    [`https://www.leboncoin.fr${href}`]: { preview },
  }, timeoutMs: 20 }), null);
});

test('saute une conversation inchangée pour traiter un aperçu vendeur plus bas dans la liste', async () => {
  const first = '/messages/id/00000000-0000-4000-8000-000000000101';
  const second = '/messages/id/cccccccc-1111-2222-3333-dddddddddddd';
  const firstPreview = 'PS5 Notre réponse VendeurZeta';
  const secondPreview = 'Console ps5 Oui disponible VendeurEta';
  const f = inject({ allRows: [
    { href: first, preview: firstPreview },
    { href: second, preview: secondPreview },
  ] });

  const result = await f.window.__ps5ChoisirCandidate({ previousPreviews: {
    [`https://www.leboncoin.fr${first}`]: { preview: firstPreview },
    [`https://www.leboncoin.fr${second}`]: { preview: 'Console ps5 Bonjour VendeurEta' },
  }, timeoutMs: 20 });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    url_conversation: `https://www.leboncoin.fr${second}`,
    preview: secondPreview,
    source: 'first_changed',
  });
});

test('le scan manuel ignore les conversations déjà visitées pendant le même lot', async () => {
  const first = '/messages/id/00000000-0000-4000-8000-000000000101';
  const second = '/messages/id/cccccccc-1111-2222-3333-dddddddddddd';
  const f = inject({ allRows: [
    { href: first, preview: 'PS5 Notre réponse VendeurZeta' },
    { href: second, preview: 'Console ps5 Oui disponible VendeurEta' },
  ] });

  const result = await f.window.__ps5ChoisirCandidate({
    previousPreviews: {},
    excludedUrls: [`https://www.leboncoin.fr${first}`],
    timeoutMs: 20,
  });

  assert.equal(result.url_conversation, `https://www.leboncoin.fr${second}`);
});

const U = (n) => `/messages/id/aaaaaaaa-1111-2222-3333-00000000000${n}`;
const full = (n) => `https://www.leboncoin.fr${U(n)}`;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('le relevé initial rend tous les aperçus affichés et signale les non-lus', async () => {
  const f = inject({ allRows: [{ href: U(1), preview: 'neuf' }, { href: U(2), preview: 'ancien' }],
    unread: [{ href: U(1), preview: 'neuf' }] });
  assert.deepEqual(plain(await f.window.__ps5LireApercus({ timeoutMs: 200, stableMs: 5 })), { lignes: [
    { url_conversation: full(1), preview: 'neuf', non_lu: true },
    { url_conversation: full(2), preview: 'ancien', non_lu: false },
  ] });
  assert.equal(f.all.pressed, true);
});

test('le relevé initial attend le rendu des lignes, et rend une liste vide si rien n’apparaît', async () => {
  const late = inject({ allRows: [U(1)], rowsDelayMs: 40 });
  assert.equal((await late.window.__ps5LireApercus({ timeoutMs: 500, stableMs: 5 })).lignes.length, 1);
  assert.deepEqual(plain(await inject().window.__ps5LireApercus({ timeoutMs: 30, stableMs: 5 })), { lignes: [] });
});

test('un fil jamais observé sous un fil inchangé est ancien et n’est pas ouvert', async () => {
  const rows = [{ href: U(1), preview: 'inchangé' }, { href: U(2), preview: 'chargé plus tard' }];
  const previousPreviews = { [full(1)]: { preview: 'inchangé' } };
  assert.equal(await inject({ allRows: rows }).window.__ps5ChoisirCandidate({ previousPreviews, timeoutMs: 20 }), null);
  // Au-dessus des fils inchangés, il s’agit d’une nouveauté.
  const above = await inject({ allRows: [...rows].reverse() }).window.__ps5ChoisirCandidate({ previousPreviews, timeoutMs: 20 });
  assert.equal(above.url_conversation, full(2));
  // Un fil connu à retraiter reste ouvert, où qu’il soit.
  const retry = await inject({ allRows: rows }).window.__ps5ChoisirCandidate({ timeoutMs: 20,
    previousPreviews: { ...previousPreviews, [full(2)]: { preview: null } } });
  assert.equal(retry.url_conversation, full(2));
});

test('un fil écarté n’est sauté que tant que son aperçu reste celui de l’échec', async () => {
  const rows = [{ href: U(1), preview: 'en échec' }, { href: U(2), preview: 'réponse arrivée' }];
  for (const unread of [[], [rows[0]]]) {
    const result = await inject({ allRows: rows, unread }).window.__ps5ChoisirCandidate({ timeoutMs: 20,
      previousPreviews: { [full(1)]: { preview: null }, [full(2)]: { preview: 'ancien' } },
      ignoredPreviews: { [full(1)]: { preview: 'en échec', ouvert: false } } });
    assert.equal(result.url_conversation, full(2));
  }
  const changed = await inject({ allRows: rows }).window.__ps5ChoisirCandidate({ timeoutMs: 20,
    previousPreviews: { [full(1)]: { preview: null } },
    ignoredPreviews: { [full(1)]: { preview: 'ancien échec', ouvert: false } } });
  assert.equal(changed.url_conversation, full(1));
});

test('un fil ouvert puis de nouveau non lu porte un nouveau message, même à aperçu identique', async () => {
  const rows = [{ href: U(1), preview: 'ok' }];
  const choose = (unread) => inject({ allRows: rows, unread }).window.__ps5ChoisirCandidate({ timeoutMs: 20,
    previousPreviews: { [full(1)]: { preview: null } },
    ignoredPreviews: { [full(1)]: { preview: 'ok', ouvert: true } } });
  assert.equal(await choose([]), null);
  assert.equal((await choose(rows)).url_conversation, full(1));
});

// Vu sur la vraie messagerie : sous « Tous », la première ligne est une
// promotion saisonnière, absente de « Non lus ».
const PROMO = { href: '/messages/id/santa', title: 'Père Noël', message: 'Ouvrez votre cadeau',
  seller: 'Père Noël', time: 'il y a 1 min', preview: 'Père Noël Ouvrez votre cadeau' };

test('le relevé initial ignore la ligne promotionnelle en tête de liste', async () => {
  const f = inject({ allRows: [PROMO, { href: U(1), preview: 'neuf' }], unread: [{ href: U(1), preview: 'neuf' }] });
  assert.deepEqual(plain(await f.window.__ps5LireApercus({ timeoutMs: 200, stableMs: 5 })), { lignes: [
    { url_conversation: full(1), preview: 'neuf', non_lu: true },
  ] });
});

test('le relevé initial n’est pas stable tant que seule la promotion est affichée', async () => {
  const rows = [PROMO];
  const f = inject({ allRows: rows });
  setTimeout(() => rows.push(U(1)), 40);
  const result = await f.window.__ps5LireApercus({ timeoutMs: 500, stableMs: 5 });
  assert.deepEqual(plain(result.lignes.map((ligne) => ligne.url_conversation)), [full(1)]);
});

test('une liste réduite à la promotion est vide, sans erreur ni ouverture', async () => {
  const f = inject({ allRows: [PROMO] });
  assert.deepEqual(plain(await f.window.__ps5LireApercus({ timeoutMs: 30, stableMs: 5 })), { lignes: [] });
  assert.equal(await f.window.__ps5ChoisirCandidate({ timeoutMs: 20 }), null);
  assert.equal(await inject({ unread: [PROMO] }).window.__ps5PremiereNonLue({ timeoutMs: 20 }), null);
});

test('la promotion n’est jamais ouverte, ni en non-lu ni comme aperçu changé', async () => {
  const rows = [PROMO, { href: U(1), preview: 'réponse arrivée' }];
  const previousPreviews = { [full(1)]: { preview: 'ancien' } };
  for (const unread of [[], [PROMO]]) {
    const result = await inject({ allRows: rows, unread }).window.__ps5ChoisirCandidate({ previousPreviews, timeoutMs: 20 });
    assert.equal(result.url_conversation, full(1));
  }
  const behind = await inject({ unread: rows }).window.__ps5ChoisirCandidate({ timeoutMs: 20 });
  assert.equal(behind.url_conversation, full(1));
});

test('la promotion ne fausse pas la règle des fils anciens, où qu’elle soit', async () => {
  const known = { href: U(1), preview: 'inchangé' };
  const later = { href: U(2), preview: 'chargé plus tard' };
  // Même un aperçu déjà relevé pour la promotion ne compte pas comme fil inchangé.
  const previousPreviews = { 'https://www.leboncoin.fr/messages/id/santa': { preview: 'Père Noël Ouvrez votre cadeau Père Noël' } };
  const above = await inject({ allRows: [PROMO, later] }).window.__ps5ChoisirCandidate({ previousPreviews, timeoutMs: 20 });
  assert.equal(above.url_conversation, full(2));
  assert.equal(await inject({ allRows: [known, PROMO, later] }).window.__ps5ChoisirCandidate({ timeoutMs: 20,
    previousPreviews: { [full(1)]: { preview: 'inchangé' } } }), null);
});

test('des liens tous inconnus signalent une erreur visible au lieu d’une liste vide', async () => {
  const rows = [PROMO, '/messages/id/Xk93LmQ2pZ', '/messages/id/b7Tq0'];
  const erreur = /aucune conversation reconnue/i;
  await assert.rejects(inject({ allRows: rows }).window.__ps5LireApercus({ timeoutMs: 30, stableMs: 5 }), erreur);
  await assert.rejects(inject({ allRows: rows }).window.__ps5ChoisirCandidate({ timeoutMs: 20 }), erreur);
  await assert.rejects(inject({ unread: rows }).window.__ps5ChoisirCandidate({ timeoutMs: 20 }), erreur);
  await assert.rejects(inject({ unread: rows }).window.__ps5PremiereNonLue({ timeoutMs: 20 }), erreur);
});

test('une promotion de forme inconnue sous « Non lus » laisse examiner « Tous »', async () => {
  const previousPreviews = { [full(1)]: { preview: 'ancien' } };
  for (const href of ['/messages/id/santa2026', '/messages/id/black-friday-2026', '/messages/id/Noel']) {
    const f = () => inject({ unread: [href], allRows: [href, { href: U(1), preview: 'réponse arrivée' }] });
    assert.equal((await f().window.__ps5ChoisirCandidate({ previousPreviews, timeoutMs: 20 })).url_conversation, full(1), href);
    const fixture = f();
    assert.equal(await fixture.window.__ps5PremiereNonLue({ timeoutMs: 20 }), null, href);
    assert.equal(fixture.all.pressed, true);
  }
});

test('un lien inconnu parmi de vraies conversations est ignoré, même s’il sort de la messagerie', async () => {
  const rows = ['/messages/id/../../compte', `${U(1)}/supprimer`, '/messages/id/Xk93LmQ2pZ', U(2)];
  const result = await inject({ allRows: rows }).window.__ps5ChoisirCandidate({ timeoutMs: 20 });
  assert.equal(result.url_conversation, full(2));
});

test('sélectionne le filtre non lu et rend uniquement la première URL de conversation', async () => {
  const f = inject({ unread: ['/messages/id/00000000-0000-4000-8000-000000000101', U(2)] });
  const result = await f.window.__ps5PremiereNonLue({ timeoutMs: 20 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    url_conversation: 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101',
  });
  assert.equal(f.unreadChip.pressed, true);
});

test('rend null sans non-lu et permet de rétablir le filtre Tout', async () => {
  const f = inject();
  assert.equal(await f.window.__ps5PremiereNonLue({ timeoutMs: 20 }), null);
  assert.equal(f.all.pressed, true);
});

test('attend le rerendu du filtre au lieu de rendre une ancienne conversation lue', async () => {
  const stale = '/messages/id/aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const fresh = '/messages/id/cccccccc-1111-2222-3333-dddddddddddd';
  const f = inject({ unread: [fresh], staleUnread: [stale], settleDelayMs: 30 });
  assert.deepEqual(JSON.parse(JSON.stringify(await f.window.__ps5PremiereNonLue({ timeoutMs: 100 }))), {
    url_conversation: `https://www.leboncoin.fr${fresh}`,
  });
});

test('signale blocage et connexion sans retourner de conversation', async () => {
  await assert.rejects(inject({ blocked: true }).window.__ps5PremiereNonLue(), /restreint/i);
  await assert.rejects(inject({ login: true }).window.__ps5PremiereNonLue(), /connexion/i);
});

test('refuse de lire une liste dont le conteneur stable a disparu', async () => {
  await assert.rejects(inject({ listContainer: false, unread: [
    '/messages/id/00000000-0000-4000-8000-000000000101',
  ] }).window.__ps5PremiereNonLue({ timeoutMs: 20 }), /liste.*introuvable/i);
});

test('la réinjection conserve les fonctions déjà exposées', () => {
  const f = inject();
  const first = f.window.__ps5PremiereNonLue;
  const context = vm.createContext({ window: f.window, document: {}, location: {}, URL, setTimeout });
  new vm.Script(source).runInContext(context);
  assert.equal(f.window.__ps5PremiereNonLue, first);
});

test('une nouvelle version remplace les fonctions restées dans une page déjà ouverte', () => {
  const old = () => 'ancienne version';
  const window = {
    __ps5MessagesListVersion: 1,
    __ps5PremiereNonLue: old,
    __ps5ChoisirCandidate: old,
  };
  const context = vm.createContext({ window, document: {}, location: {}, URL, setTimeout, clearTimeout });

  new vm.Script(source).runInContext(context);

  assert.equal(window.__ps5MessagesListVersion, 7);
  assert.notEqual(window.__ps5ChoisirCandidate, old);
  assert.equal(typeof window.__ps5LireApercus, 'function');
});
