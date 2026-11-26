import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { collecterDetailDepuisDocument, extraireDetailDepuisDonneesBrutes } from '../extension/sw/extract-detail.js';

const root = new URL('../extension/', import.meta.url);
const href = 'https://www.leboncoin.fr/recherche?text=ps5';

// Only browser boundaries are doubled; both classic scripts and their shared
// parsing module run unchanged. A real Chrome DOM check remains necessary.
function article({ url = '/ad/consoles/123', text = '', title = null } = {}) {
  return {
    querySelector: (selector) => selector === 'a[href]' && url
      ? { getAttribute: () => url, href: url } : null,
    querySelectorAll: () => [],
    getAttribute: () => title,
    cloneNode: () => ({ textContent: text, querySelectorAll: () => [] }),
  };
}

function doc(articles = [], text = '') {
  return { body: { textContent: text }, querySelectorAll: () => articles };
}

async function results(document, responses = []) {
  const messages = [];
  const requests = [];
  const context = vm.createContext({
    window: {}, document, location: { href }, URL,
    chrome: { runtime: {
      getURL: (path) => new URL(path, root).href,
      sendMessage: async (message) => { messages.push(structuredClone(message)); },
    } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'unexpected extra page fetch');
      return { ok: response.status === undefined, status: response.status ?? 200,
        text: async () => response.html ?? 'page' };
    },
    DOMParser: class { parseFromString() { return document.next; } },
  });
  const source = readFileSync(new URL('content/extract.js', root), 'utf8');
  const script = new vm.Script(source, {
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  script.runInContext(context);
  await context.window.__ps5ExtractReady;
  return { extract: context.window.__ps5Extraire, messages, requests,
    reinject: () => script.runInContext(context) };
}

test('classic result script emits the fullest duplicate, resolves relative URLs and fetches no next page', async () => {
  const page = doc([article(), article({ text: 'Prix: 340 €. Très bon état.', title: 'PS5' })]);
  const { extract, requests, messages } = await results(page);
  const result = await extract({ maxPages: 3 });
  assert.equal(requests.length, 0);
  assert.equal(result.terminee, false);
  assert.equal(result.total, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'annonces-page');
  assert.equal(messages[0].page, 1);
  assert.equal(messages[0].annonces.length, 1);
  assert.equal(messages[0].annonces[0].prix_eur, 340);
  assert.equal(messages[0].annonces[0].url_annonce, 'https://www.leboncoin.fr/ad/consoles/123');
});

test('one call fetches only the requested page and re-emits improved entries without recounting them', async () => {
  const page = doc([article()]);
  page.next = doc([article({ text: 'Prix: 300 €', title: 'PS5' }), article({ url: '/ad/consoles/456' })]);
  const { extract, requests, messages, reinject } = await results(page, [{}]);
  await extract({ maxPages: 3 });
  reinject();
  const result = await extract({ page: 2, maxPages: 3 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://www.leboncoin.fr/recherche?text=ps5&page=2');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(result.total, 2);
  assert.equal(result.terminee, false);
  assert.equal(messages[1].annonces.length, 2);
  assert.equal(messages[1].annonces[0].prix_eur, 300);
});

test('a normal fetched results page is not blocked by a DataDome script reference', async () => {
  const page = doc([article()]);
  page.next = doc([article({ url: '/ad/consoles/456', text: 'Prix: 340 €', title: 'PS5' })]);
  const { extract, messages } = await results(page, [{ html: '<script src="/datadome.js"></script>' }]);
  const result = await extract({ page: 2, maxPages: 3 });
  assert.equal(result.bloque, undefined);
  assert.equal(result.annonces.length, 1);
  assert.equal(result.annonces[0].url_annonce, 'https://www.leboncoin.fr/ad/consoles/456');
  assert.equal(messages.some((message) => message.type === 'leboncoin-bloque'), false);
});

test('result cap trims a page and reports exactly one completed page', async () => {
  const { extract, messages } = await results(doc([article(), article({ url: '/ad/consoles/456' })]));
  const result = await extract({ maxPages: 5, maxResultats: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.terminee, true);
  assert.equal(messages[0].annonces.length, 1);
  assert.deepEqual(messages[1], { type: 'extraction-terminee', pages: 1 });
});

test('empty fetched page ends traversal without inventing an extra parsed results page', async () => {
  const page = doc([article()]);
  page.next = doc();
  const { extract, messages } = await results(page, [{}]);
  await extract({ maxPages: 3 });
  const result = await extract({ page: 2, maxPages: 3 });
  assert.equal(result.terminee, true);
  assert.deepEqual(messages.at(-1), { type: 'extraction-terminee', pages: 1 });
});

test('block on current DOM or fetched HTML stops extraction and emits a block message', async () => {
  for (const current of [true, false]) {
    const page = doc(current ? [] : [article()], current ? 'Accès temporairement restreint' : '');
    const { extract, messages } = await results(page, [{ html: 'Accès temporairement restreint' }]);
    const result = await extract({ page: current ? 1 : 2, maxPages: 3 });
    assert.equal(result.bloque, true);
    assert.equal(result.terminee, true);
    assert.deepEqual(messages, [{ type: 'leboncoin-bloque' }]);
  }
});

test('HTTP and network failures report an error instead of a successful extraction end', async () => {
  for (const response of [{ status: 503 }, new Error('offline')]) {
    const { extract, messages } = await results(doc(), [response]);
    const result = await extract({ page: 2, maxPages: 3 });
    assert.ok(result.erreur);
    assert.equal(result.terminee, true);
    assert.equal(messages[0].type, 'extraction-erreur');
    assert.equal(messages[0].page, 2);
    assert.equal(messages.length, 1);
  }
});

function detail(ad, { text = '', visible, missing = false, raw, livraison = null } = {}) {
  const collecte = new vm.Script(`(${collecterDetailDepuisDocument.toString()})()`)
    .runInNewContext({ location: { href: `${href}&tracking=1` }, document: {
      body: { textContent: text, innerText: visible },
      getElementById: () => missing ? null : { textContent: raw ?? JSON.stringify({ props: { pageProps: { ad } } }) },
      // Le bloc livraison n'est présent que sur une vraie page annonce.
      querySelector: (sel) => (livraison && sel.includes('adview_delivery_container')
        ? { textContent: livraison } : null),
    } });
  return extraireDetailDepuisDonneesBrutes(collecte);
}

const attrs = (paires) => Object.entries(paires).map(([key, value]) => ({ key, value }));

test('detail script returns structured data as its last expression', () => {
  const result = detail({ list_id: 123, subject: 'PS5', body: 'Description intégrale', price: [300],
    attributes: [{ key: 'item_condition', value_label: 'Très bon état' }],
    location: { city: 'Tours', zipcode: '37000' },
    images: { urls_large: ['https://img.leboncoin.fr/images/a?rule=avif'] },
    first_publication_date: '2026-09-25 23:30:00' });
  assert.equal(result.list_id, '123');
  assert.equal(result.description, 'Description intégrale');
  assert.equal(result.prix_eur, 300);
  assert.equal(result.etat, 'Très bon état');
  assert.equal(result.url_annonce, 'https://www.leboncoin.fr/recherche');
  assert.equal(result.images[0], 'https://img.leboncoin.fr/images/a?rule=ad-image');
  assert.equal(result.date_publication, '2026-09-25T21:30:00.000Z');
});

test('an active detail is not treated as disabled because a hidden dialog mentions it', () => {
  const result = detail({
    list_id: 1000000004,
    status: 'active',
    subject: 'Ps5',
    body: 'Console complète et fonctionnelle',
    price: [450],
  }, { text: 'Ps5 Cette annonce est désactivée' });

  assert.equal(result.list_id, '1000000004');
  assert.equal(result.titre, 'Ps5');
});

test('sans donnée d’annonce, seul le texte visible de désactivation marque l’annonce introuvable', () => {
  const text = 'Cette annonce est désactivée';
  assert.throws(() => detail(undefined, { text, visible: text }), /Annonce leboncoin désactivée/);
  // Texte présent seulement dans une modale masquée : rien n’est conclu.
  assert.throws(() => detail(undefined, { text, visible: 'Chargement' }), /props.pageProps.ad/);
});

test('Paris publication dates handle midnight and winter/summer offsets including DST transition', () => {
  for (const [input, expected] of [
    ['2026-01-25 23:30:00', '2026-01-25T22:30:00.000Z'],
    ['2026-09-25 00:30:00', '2026-09-24T22:30:00.000Z'],
    ['2026-03-29 01:30:00', '2026-03-29T00:30:00.000Z'],
    ['2026-03-29 03:30:00', '2026-03-29T01:30:00.000Z'],
    [null, null],
  ]) assert.equal(detail({ first_publication_date: input }).date_publication, expected);
});

test('detail supports attribute keys already used by the existing Leboncoin script', () => {
  const result = detail({ attributes: [
    { key: 'condition', value_label: 'Bon état' },
    { key: 'console_brand', value: 'Sony' },
    { key: 'console_model', value: 'PS5' },
  ] });
  assert.equal(result.etat, 'Bon état');
  assert.equal(result.marque, 'Sony');
  assert.equal(result.plateforme, 'PS5');
});

test('detail rejects a block, missing or malformed NEXT_DATA, and absent ad', () => {
  assert.throws(() => detail({}, { text: 'Accès temporairement restreint' }), /restreint/);
  assert.throws(() => detail({}, { text: 'Cette annonce est désactivée', missing: true }), /désactivée/);
  assert.throws(() => detail({ status: 'inactive' }), /désactivée/);
  assert.throws(() => detail({}, { missing: true }), /__NEXT_DATA__/);
  assert.throws(() => detail({}, { raw: '{' }));
  assert.throws(() => detail(undefined), /props.pageProps.ad/);
});

test('le script détail relève les favoris et les boutons proposés', () => {
  const result = detail({
    subject: 'PS5', status: 'active', counters: { favorites: 42 },
    attributes: attrs({ negotiation_cta_visible: 'true', purchase_cta_visible: 'true' }),
  });

  assert.equal(result.likes, 42);
  // Array.from : le tableau naît dans le contexte vm, d'un autre realm.
  assert.deepEqual(Array.from(result.call_to_actions), ['Contacter', 'Faire une offre', 'Acheter']);
});

test('une annonce sans bouton d’achat ni d’offre ne garde que Contacter', () => {
  // C'est le cas qui mérite un œil : ni paiement en ligne, ni négociation.
  const result = detail({ subject: 'PS5', status: 'active', attributes: attrs({}) });

  assert.deepEqual(Array.from(result.call_to_actions), ['Contacter']);
});

test('le script détail lit les tarifs d’expédition dans le DOM rendu', () => {
  const result = detail(
    { subject: 'PS5', location: { city: 'Lille' },
      attributes: attrs({ shippable: 'true', shipping_type: 'mondial_relay' }) },
    { livraison: 'Modes de remise Remise en main propre À Lille Rencontrez le vendeur. '
      + 'Point de retrait Dès Dès 6,49 € en 3 à 5 jours ouvrés '
      + 'À domicile Dès Dès 8,48 € en 2 à 5 jours ouvrés' },
  );

  // Ces montants n'existent pas dans le HTML servi : c'est l'apport de l'extension.
  assert.equal(result.modes_remise.point_retrait.prix_min_eur, 6.49);
  assert.equal(result.modes_remise.point_retrait.delai, '3 à 5 jours ouvrés');
  assert.equal(result.modes_remise.domicile.prix_min_eur, 8.48);
  assert.equal(result.modes_remise.main_propre.lieu, 'Lille');
  assert.equal(result.livraison_possible, true);
});

test('sans bloc livraison, la disponibilité se déduit du type d’expédition', () => {
  const result = detail({ subject: 'PS5', location: { city: 'Lille' },
    attributes: attrs({ shippable: 'false', shipping_type: 'face_to_face' }) });

  assert.equal(result.modes_remise.type_expedition, 'face_to_face');
  assert.equal(result.modes_remise.point_retrait.disponible, false);
  assert.equal(result.livraison_possible, false);
});

test('a results page with usable listings is not blocked by DataDome text, even inside scripts', async () => {
  const { extract, messages } = await results(doc([article()], 'var dd = "datadome"; Device Check'));
  const result = await extract({ maxPages: 1 });
  assert.equal(result.bloque, undefined);
  assert.equal(result.annonces.length, 1);
  assert.equal(messages.some((message) => message.type === 'leboncoin-bloque'), false);
});

test('visible text decides: a script-only DataDome reference on an empty results page is not a block', async () => {
  const page = doc([], 'datadome');
  page.body.innerText = 'Aucune annonce';
  const { extract } = await results(page);
  assert.equal((await extract({ maxPages: 1 })).bloque, undefined);
});

test('a real challenge page without listings stays blocked', async () => {
  for (const challenge of [doc([], 'Please enable JS and disable any ad blocker'), doc([], 'Device Check'),
    { ...doc([]), querySelector: (selector) => selector.includes('captcha-delivery') ? {} : null }]) {
    const { extract } = await results(challenge);
    assert.equal((await extract({ maxPages: 1 })).bloque, true);
  }
});

test('an HTTP error page with a routine DataDome script is an error, not a block', async () => {
  const { extract } = await results(doc([article()]),
    [{ status: 500, html: '<script>var datadome = {}</script><h1>Erreur</h1>' }]);
  const result = await extract({ page: 2, maxPages: 3 });
  assert.equal(result.bloque, undefined);
  assert.equal(result.erreur.statut, 500);
});

test('a challenge served as a script from captcha-delivery is still a block', async () => {
  const { extract } = await results(doc([article()]),
    [{ status: 403, html: '<script src="https://ct.captcha-delivery.com/c.js"></script>' }]);
  assert.equal((await extract({ page: 2, maxPages: 3 })).bloque, true);
});
