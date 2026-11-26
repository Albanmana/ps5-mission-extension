import assert from 'node:assert/strict';
import test from 'node:test';

import { resoudreTemplate, VARIABLES, TEMPLATES_PAR_DEFAUT } from '../extension/lib/templates.js';

const annonce = {
  vendeur: 'Camille',
  titre: 'PS5 Slim avec lecteur',
  prix_eur: 340,
  ville: 'Tours',
};

test('substitue les variables connues', () => {
  const { texte } = resoudreTemplate('Bonjour {{vendeur}}, la {{titre}} à {{prix}} € à {{ville}} ?', annonce);
  assert.equal(texte, 'Bonjour Camille, la PS5 Slim avec lecteur à 340 € à Tours ?');
});

test('substitue une variable répétée', () => {
  const { texte } = resoudreTemplate('{{vendeur}} ? {{vendeur}} !', annonce);
  assert.equal(texte, 'Camille ? Camille !');
});

test('tolère les espaces dans les accolades', () => {
  const { texte } = resoudreTemplate('Bonjour {{ vendeur }}', annonce);
  assert.equal(texte, 'Bonjour Camille');
});

test('remplace une variable sans valeur par une chaîne vide et la signale', () => {
  const { texte, manquantes } = resoudreTemplate('Bonjour {{vendeur}} de {{ville}}', { vendeur: null, ville: 'Lyon' });
  assert.equal(texte, 'Bonjour  de Lyon');
  assert.deepEqual(manquantes, ['vendeur']);
});

test('signale une variable inconnue sans la substituer', () => {
  const { texte, manquantes } = resoudreTemplate('Bonjour {{inconnue}}', annonce);
  assert.equal(texte, 'Bonjour {{inconnue}}');
  assert.deepEqual(manquantes, ['inconnue']);
});

test('déduplique les variables manquantes répétées', () => {
  const { texte, manquantes } = resoudreTemplate('{{inconnue}} {{inconnue}} {{vendeur}} {{vendeur}}', { vendeur: null });
  assert.equal(texte, '{{inconnue}} {{inconnue}}  ');
  assert.deepEqual(manquantes, ['inconnue', 'vendeur']);
});

test('un texte sans variable est rendu tel quel', () => {
  const { texte, manquantes } = resoudreTemplate('Bonjour, toujours dispo ?', annonce);
  assert.equal(texte, 'Bonjour, toujours dispo ?');
  assert.deepEqual(manquantes, []);
});

test('les variables exposées sont celles documentées', () => {
  assert.deepEqual(VARIABLES, ['vendeur', 'titre', 'prix', 'ville']);
});

test('les templates par défaut sont résolvables', () => {
  assert.ok(TEMPLATES_PAR_DEFAUT.length >= 1);
  for (const template of TEMPLATES_PAR_DEFAUT) {
    const { manquantes } = resoudreTemplate(template.texte, annonce);
    assert.deepEqual(manquantes, [], `template ${template.id}`);
  }
});

test('le template Disponibilité utilise le message de contact demandé', () => {
  assert.equal(
    TEMPLATES_PAR_DEFAUT.find((template) => template.id === 'dispo')?.texte,
    'Bonjour vous allez bien ? Est-ce que la PS5 est toujours disponible svp?',
  );
});
