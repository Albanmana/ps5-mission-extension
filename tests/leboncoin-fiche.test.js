import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extraireFiche, recupererFiche, EN_TETES_NAVIGATEUR,
  delaiProchaineRequete, DELAI_MIN_MS, DELAI_MAX_MS, PAUSE_TOUS_LES,
} from '../scripts/lib/leboncoin.js';

const page = (ad) => `<!doctype html><html><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { ad } } })}</script>
</body></html>`;

const AD = {
  url: 'https://www.leboncoin.fr/ad/consoles/123',
  list_id: 123,
  subject: 'PlayStation 5',
  body: 'Console PS5 Édition Digitale, très bon état.',
  price: [380],
  location: { city: 'Lille', zipcode: '59000' },
  images: { urls_large: ['https://img.leboncoin.fr/a.jpg?rule=ad-thumb-avif'] },
  attributes: [
    { key: 'item_condition', value_label: 'Très bon état' },
    { key: 'video_game_type', value_label: 'Console' },
    { key: 'brand', value_label: 'Sony' },
    { key: 'video_game_platform', value_label: 'PlayStation 5' },
  ],
  first_publication_date: '2026-09-25 16:15:47',
};

test('extraireFiche rend les colonnes attendues par la base', () => {
  const fiche = extraireFiche(page(AD), AD.url);

  assert.equal(fiche.url_annonce, AD.url);
  assert.equal(fiche.list_id, '123');
  assert.equal(fiche.titre, 'PlayStation 5');
  assert.match(fiche.description, /Édition Digitale/);
  assert.equal(fiche.prix_eur, 380);
  assert.equal(fiche.etat, 'Très bon état');
  assert.equal(fiche.marque, 'Sony');
  assert.equal(fiche.plateforme, 'PlayStation 5');
  assert.equal(fiche.ville, 'Lille');
  assert.equal(fiche.code_postal, '59000');
});

test('extraireFiche normalise les images en variante JPEG', () => {
  const fiche = extraireFiche(page(AD), AD.url);

  // Les variantes AVIF ne sont pas lisibles par les API de vision.
  assert.deepEqual(fiche.images, ['https://img.leboncoin.fr/a.jpg?rule=ad-image']);
});

test('extraireFiche convertit la date de publication de Paris vers UTC', () => {
  const fiche = extraireFiche(page(AD), AD.url);

  // 16:15:47 à Paris en septembre (UTC+2) => 14:15:47 UTC.
  assert.equal(fiche.date_publication, '2026-09-25T14:15:47.000Z');
});

test('extraireFiche signale une page anti-bot plutôt que de rendre du vide', () => {
  assert.throws(() => extraireFiche('<html><body>Please enable JS</body></html>', 'u'), /__NEXT_DATA__/);
});

test('extraireFiche signale un accès restreint par leboncoin', () => {
  assert.throws(
    () => extraireFiche('<html><body>Accès temporairement restreint</body></html>', 'u'),
    /restreint/i,
  );
});

test('recupererFiche envoie les en-têtes sans lesquels leboncoin refuse', async () => {
  let recu;
  await recupererFiche(AD.url, {
    fetch: async (url, options) => {
      recu = options.headers;
      return { ok: true, status: 200, text: async () => page(AD) };
    },
  });

  // Sans Referer ni Sec-Fetch-*, la même requête renvoie 403.
  assert.ok(recu['user-agent'].includes('Mozilla'));
  assert.equal(recu.referer, EN_TETES_NAVIGATEUR.referer);
  assert.equal(recu['sec-fetch-mode'], 'navigate');
});

test('recupererFiche remonte une erreur lisible sur refus HTTP', async () => {
  await assert.rejects(
    () => recupererFiche(AD.url, { fetch: async () => ({ ok: false, status: 403, text: async () => '' }) }),
    /403/,
  );
});

// --- Rythme de consultation -------------------------------------------------
// Un intervalle régulier est la signature la plus évidente d'un script.

test('delaiProchaineRequete reste dans la fourchette annoncée', () => {
  for (const alea of [() => 0, () => 0.5, () => 0.999]) {
    const ms = delaiProchaineRequete(1, { alea });
    assert.ok(ms >= DELAI_MIN_MS && ms <= DELAI_MAX_MS, `${ms} hors bornes`);
  }
});

test('delaiProchaineRequete varie d’un appel à l’autre', () => {
  let n = 0;
  const alea = () => [0.1, 0.9, 0.4, 0.7][n++ % 4];
  const delais = [1, 2, 3, 4].map((rang) => delaiProchaineRequete(rang, { alea }));

  assert.equal(new Set(delais).size, delais.length, 'des délais identiques trahiraient un script');
});

test('delaiProchaineRequete marque une pause longue périodiquement', () => {
  const alea = () => 0.5;
  const courant = delaiProchaineRequete(1, { alea });
  const pause = delaiProchaineRequete(PAUSE_TOUS_LES, { alea });

  assert.ok(pause > courant * 3, 'la pause doit être nettement plus longue');
});

test('le tout premier appel n’attend pas une pause longue', () => {
  const ms = delaiProchaineRequete(0, { alea: () => 0.5 });
  assert.ok(ms <= DELAI_MAX_MS);
});
