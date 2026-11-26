import assert from 'node:assert/strict';
import test from 'node:test';

import { creerEtatRun } from '../extension/sw/run-state.js';
import { meilleureCandidateDetail } from '../extension/sw/run-recherche.js';

const URL_RECHERCHE = 'https://www.leboncoin.fr/recherche?text=ps5';
const ad = (id) => `https://www.leboncoin.fr/ad/consoles/${id}`;

const candidate = (id, classification, prix_eur, extra = {}) => [ad(id), {
  url_annonce: ad(id), analysee: true, classification, prix_eur,
  disqualifiee: false, detail: null, ...extra,
}];

const etatAvec = (...paires) => ({ annonces: Object.fromEntries(paires) });

test('creerEtatRun accepte une limite de fiches et retient sa valeur', () => {
  const etat = creerEtatRun({ urlRecherche: URL_RECHERCHE, maxPages: 3, maxResultats: 200, maxFiches: 120 });

  assert.equal(etat.maxFiches, 120);
});

test('creerEtatRun retombe sur 50 fiches quand rien n’est demandé', () => {
  const etat = creerEtatRun({ urlRecherche: URL_RECHERCHE, maxPages: 3, maxResultats: 200 });

  assert.equal(etat.maxFiches, 50);
});

test('creerEtatRun refuse une limite de fiches absurde', () => {
  const creer = (maxFiches) => () => creerEtatRun({ urlRecherche: URL_RECHERCHE, maxPages: 3, maxResultats: 200, maxFiches });

  assert.throws(creer(0), /limites/);
  assert.throws(creer(-1), /limites/);
  assert.throws(creer(1.5), /limites/);
});

test('la meilleure candidate est le saint_graal avant l’intéressante', () => {
  const etat = etatAvec(
    candidate(1, 'a_verifier', 250),
    candidate(2, 'interessant', 300),
    candidate(3, 'saint_graal', 340),
  );

  assert.equal(meilleureCandidateDetail(etat), ad(3));
});

test('à classification égale, la moins chère passe en premier', () => {
  const etat = etatAvec(
    candidate(1, 'saint_graal', 340),
    candidate(2, 'saint_graal', 250),
  );

  assert.equal(meilleureCandidateDetail(etat), ad(2));
});

test('une annonce disqualifiée ou déjà visitée n’est pas candidate', () => {
  const etat = etatAvec(
    candidate(1, 'disqualifiee', 200, { disqualifiee: true }),
    candidate(2, 'saint_graal', 300, { detail: 'en_cours' }),
    candidate(3, 'a_verifier', 400),
  );

  assert.equal(meilleureCandidateDetail(etat), ad(3));
});

test('une annonce pas encore analysée n’est pas candidate', () => {
  const etat = etatAvec(candidate(1, null, 300, { analysee: false }));

  assert.equal(meilleureCandidateDetail(etat), null);
});

test('un prix inconnu passe après un prix connu', () => {
  const etat = etatAvec(
    candidate(1, 'saint_graal', null),
    candidate(2, 'saint_graal', 400),
  );

  assert.equal(meilleureCandidateDetail(etat), ad(2));
});
