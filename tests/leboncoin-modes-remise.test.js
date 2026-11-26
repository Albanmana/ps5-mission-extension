import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { extraireFiche } from '../scripts/lib/leboncoin.js';

// Fixtures fictives imitant la structure d’une annonce : un bloc livraison et le JSON.
const fiche = (nom) => extraireFiche(
  readFileSync(new URL(`./fixtures/annonce-${nom}.html`, import.meta.url), 'utf8'),
  'https://www.leboncoin.fr/ad/consoles/1',
);

test('une annonce en main propre seule n’offre aucune expédition', () => {
  const { modes_remise: modes, livraison_possible } = fiche('main-propre');

  assert.equal(modes.type_expedition, 'face_to_face');
  assert.equal(modes.main_propre.disponible, true);
  assert.equal(modes.point_retrait.disponible, false);
  assert.equal(modes.domicile.disponible, false);
  assert.equal(livraison_possible, false);
});

test('le lieu de remise est lu sur la page, pas déduit de la ville', () => {
  assert.equal(fiche('main-propre').modes_remise.main_propre.lieu, 'Villeneuve-Exemple');
});

test('une annonce Mondial Relay propose le point de retrait', () => {
  const { modes_remise: modes, livraison_possible } = fiche('point-relais');

  assert.equal(modes.type_expedition, 'mondial_relay');
  assert.equal(modes.point_retrait.disponible, true);
  assert.equal(modes.main_propre.disponible, true);
  assert.equal(livraison_possible, true);
});

test('les entités HTML du lieu sont décodées', () => {
  // Le HTML porte « Bourg d&#x27;Exemple ».
  assert.equal(fiche('point-relais').modes_remise.main_propre.lieu, "Bourg d'Exemple");
});

test('prix et délai d’expédition restent nuls : le serveur ne les rend pas', () => {
  const { point_retrait } = fiche('point-relais').modes_remise;

  // Ils sont calculés par le navigateur ; mieux vaut null qu'une invention.
  assert.equal(point_retrait.prix_min_eur, null);
  assert.equal(point_retrait.delai, null);
});

test('les call to action reflètent les boutons réellement proposés', () => {
  assert.deepEqual(fiche('main-propre').call_to_actions,
    ['Contacter', 'Faire une offre', 'Acheter']);
});

test('le nombre de mises en favori est repris', () => {
  assert.equal(fiche('main-propre').likes, 3);
  assert.equal(fiche('point-relais').likes, 49);
});
