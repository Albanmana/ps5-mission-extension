import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArticleFields, normalizeImageUrl } from '../extension/lib/parse-annonce.js';

const TEXTE = 'Annonce à la une. Prix: 340 €. Très bon état. Type: "Console". Marque: "Sony". '
  + 'Plateforme: "PS5". Livraison possible. Située à Villeneuve 00000 Quartier Exemple.';

test('extrait le prix en entier', () => {
  assert.equal(parseArticleFields(TEXTE).prix_eur, 340);
});

test('extrait un prix avec séparateur de milliers', () => {
  assert.equal(parseArticleFields('Prix: 1 200 €').prix_eur, 1200);
});

test('rend null quand le prix est absent', () => {
  assert.equal(parseArticleFields('Pas de prix ici').prix_eur, null);
});

test('extrait l\'état', () => {
  assert.equal(parseArticleFields(TEXTE).etat, 'Très bon état');
  assert.equal(parseArticleFields('État neuf.').etat, 'État neuf');
  assert.equal(parseArticleFields('rien').etat, null);
});

test('extrait les attributs structurés', () => {
  const fields = parseArticleFields(TEXTE);
  assert.equal(fields.type, 'Console');
  assert.equal(fields.marque, 'Sony');
  assert.equal(fields.plateforme, 'PS5');
});

test('extrait ville, code postal et quartier', () => {
  const fields = parseArticleFields(TEXTE);
  assert.equal(fields.ville, 'Villeneuve');
  assert.equal(fields.code_postal, '00000');
  assert.equal(fields.quartier, 'Quartier Exemple');
});

test('le quartier est facultatif', () => {
  const fields = parseArticleFields('Située à Lyon 69003.');
  assert.equal(fields.ville, 'Lyon');
  assert.equal(fields.code_postal, '69003');
  assert.equal(fields.quartier, null);
});

test('détecte livraison et sponsorisation', () => {
  const fields = parseArticleFields(TEXTE);
  assert.equal(fields.livraison_possible, true);
  assert.equal(fields.sponsorise, true);
  const autre = parseArticleFields('Prix: 300 €');
  assert.equal(autre.livraison_possible, false);
  assert.equal(autre.sponsorise, false);
});

test('normalizeImageUrl force une règle JPEG', () => {
  assert.equal(
    normalizeImageUrl('https://img.leboncoin.fr/api/v1/lbcpb1/images/ab.jpg?rule=ad-large-avif'),
    'https://img.leboncoin.fr/api/v1/lbcpb1/images/ab.jpg?rule=ad-image',
  );
});

test('normalizeImageUrl laisse intacte une url sans règle', () => {
  assert.equal(normalizeImageUrl('https://img.leboncoin.fr/a.jpg'), 'https://img.leboncoin.fr/a.jpg');
});
