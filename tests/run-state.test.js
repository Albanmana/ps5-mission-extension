import assert from 'node:assert/strict';
import test from 'node:test';
import { creerEtatRun, appliquerEvenement, compteurs, recoverRunState } from '../extension/sw/run-state.js';

const A = 'https://www.leboncoin.fr/ad/consoles/1';
const options = { urlRecherche: 'https://www.leboncoin.fr/recherche?text=ps5', maxPages: 3, maxResultats: 100, force: false };
const neuf = () => creerEtatRun(options);
const recevoir = (etat, extra = {}) => appliquerEvenement(etat, { type: 'recue', annonce: { url_annonce: A, titre: 'PS5', ...extra } });

test('un run neuf possède des compteurs nuls et un état sérialisable', () => {
  const etat = neuf();
  assert.deepEqual(compteurs(etat), { recues: 0, en_base: 0, analysees: 0, retenues: 0, erreurs: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(etat)), etat);
});

test('un run initialise les recherches ordonnées et une carte globale des annonces', () => {
  const seconde = 'https://www.leboncoin.fr/recherche?text=ps5+slim';
  const etat = creerEtatRun({ ...options, urlsRecherche: [`${options.urlRecherche}&page=3`, seconde], urlRecherche: undefined });
  assert.deepEqual(etat.urlsRecherche, [options.urlRecherche, seconde]);
  assert.equal(etat.recherche_index, 0);
  assert.deepEqual(etat.recherches, [
    { urlRecherche: options.urlRecherche, index: 0, page_suivante: 1, extraction_terminee: false,
      annonces_recues: [], details_utilises: 0, statut: 'en_cours', erreur: null },
    { urlRecherche: seconde, index: 1, page_suivante: 1, extraction_terminee: false,
      annonces_recues: [], details_utilises: 0, statut: 'en_attente', erreur: null },
  ]);
  assert.deepEqual(etat.annonces, {});
});

test('un run historique chargé retrouve une seule recherche sans perdre les annonces', () => {
  const ancien = neuf();
  delete ancien.urlsRecherche;
  delete ancien.recherches;
  delete ancien.recherche_index;
  ancien.page_suivante = 3;
  ancien.annonces[A] = { url_annonce: A };
  const etat = recoverRunState(ancien);
  assert.deepEqual(etat.urlsRecherche, [options.urlRecherche]);
  assert.equal(etat.recherche_index, 0);
  assert.deepEqual(etat.recherches[0].annonces_recues, [A]);
  assert.equal(etat.recherches[0].page_suivante, 3);
  assert.deepEqual(etat.annonces, ancien.annonces);
});

test('les limites et les URL hors recherche leboncoin sont refusées', () => {
  for (const changement of [{ maxPages: 0 }, { maxPages: 51 }, { maxResultats: 1.5 }, { urlRecherche: 'javascript:alert(1)' }, { urlRecherche: 'https://evil.test/recherche' }]) {
    assert.throws(() => creerEtatRun({ ...options, ...changement }));
  }
});

test('une annonce reçue conserve ses données métier sans confondre son état et celui du traitement', () => {
  const etat = recevoir(neuf(), { etat: 'Très bon état' });
  assert.equal(etat.annonces[A].etat, 'recue');
  assert.equal(etat.annonces[A].titre, 'PS5');
  assert.equal(etat.annonces[A].donnees.etat, 'Très bon état');
  assert.equal(compteurs(etat).recues, 1);
});

test('un doublon enrichit les données sans recompter ni perdre une classification', () => {
  let etat = recevoir(neuf());
  etat = appliquerEvenement(etat, { type: 'classifiee', url_annonce: A, classification: 'saint_graal', disqualifiee: false });
  etat = recevoir(etat, { prix_eur: 300 });
  assert.equal(etat.annonces[A].etat, 'classifiee');
  assert.equal(etat.annonces[A].prix_eur, 300);
  assert.equal(etat.annonces[A].revision, 2);
  etat = recevoir(etat, { titre: null, prix_eur: 300 });
  assert.equal(etat.annonces[A].titre, 'PS5');
  assert.equal(etat.annonces[A].revision, 2);
  assert.equal(compteurs(etat).recues, 1);
});

test('les résultats de contact distinguent envoi confirmé et skip terminal', () => {
  let etat = recevoir(neuf());
  etat = appliquerEvenement(etat, { type: 'contact_envoye', url_annonce: A });
  assert.equal(etat.annonces[A].contact_envoye, true);
  etat = appliquerEvenement(etat, { type: 'contact_skip', url_annonce: A, erreurCode: 'reply_indisponible' });
  assert.equal(etat.annonces[A].contact_skip, 'reply_indisponible');
});

test('un échec avant upsert ne compte pas en base ; un échec après analyse conserve les compteurs acquis', () => {
  let etat = recevoir(neuf());
  etat = appliquerEvenement(etat, { type: 'erreur', url_annonce: A, message: '503' });
  assert.deepEqual(compteurs(etat), { recues: 1, en_base: 0, analysees: 0, retenues: 0, erreurs: 1 });
  etat = appliquerEvenement(etat, { type: 'upsertee', url_annonce: A, deja_analysee: false });
  etat = appliquerEvenement(etat, { type: 'classifiee', url_annonce: A, classification: 'saint_graal', disqualifiee: false });
  etat = appliquerEvenement(etat, { type: 'erreur', url_annonce: A, message: 'detail absent' });
  assert.deepEqual(compteurs(etat), { recues: 1, en_base: 1, analysees: 1, retenues: 1, erreurs: 1 });
  assert.equal(etat.annonces[A].titre, 'PS5');
});

test('une annonce disqualifiée ou de classification inconnue ne compte pas retenue', () => {
  for (const analyse of [{ classification: 'disqualifiee', disqualifiee: true }, { classification: null }]) {
    const etat = appliquerEvenement(recevoir(neuf()), { type: 'classifiee', url_annonce: A, ...analyse });
    assert.equal(compteurs(etat).analysees, 1);
    assert.equal(compteurs(etat).retenues, 0);
  }
});

test('pause, reprise, blocage et arrêt sont persistables sans mutation de l’état précédent', () => {
  const avant = neuf();
  recevoir(avant);
  assert.deepEqual(avant.annonces, {});
  for (const [type, statut] of [['pause', 'pause'], ['reprise', 'en_cours'], ['bloque', 'bloque'], ['termine', 'termine']]) {
    assert.equal(appliquerEvenement(avant, { type }).statut, statut);
  }
});

test('le réducteur accepte aussi les événements plats du contrat et ignore les liens non annonce', () => {
  let etat = appliquerEvenement(neuf(), { type: 'recue', url_annonce: A, titre: 'PS5' });
  etat = appliquerEvenement(etat, { type: 'recue', url_annonce: 'javascript:alert(1)' });
  assert.equal(compteurs(etat).recues, 1);
  assert.equal(etat.annonces[A].titre, 'PS5');
});

test('un état terminal ne peut pas être rouvert par une erreur ou une reprise tardive', () => {
  for (const type of ['termine', 'bloque']) {
    const terminal = appliquerEvenement(recevoir(neuf()), { type });
    for (const evenement of [{ type: 'pause', message: 'Serveur indisponible' }, { type: 'reprise' }, { type: 'erreur', url_annonce: A, message: '503' }]) {
      assert.deepEqual(appliquerEvenement(terminal, evenement), terminal);
    }
  }
});

test('les écritures de ressources ajoutent et retirent un seul onglet même après Stop', () => {
  let etat = appliquerEvenement(neuf(), { type: 'onglet_ouvert', id: 1 });
  etat = appliquerEvenement(etat, { type: 'termine' });
  etat = appliquerEvenement(etat, { type: 'onglet_ouvert', id: 2 });
  etat = appliquerEvenement(etat, { type: 'onglet_ferme', id: 1 });
  assert.deepEqual(etat.onglets, [2]);
  assert.equal(etat.statut, 'termine');
});

test('la fin de recherche borne les erreurs persistées tout en gardant leur début utile', () => {
  const avant = neuf();
  const message = `HTTP 503 : ${'x'.repeat(2000)}`;
  const apres = appliquerEvenement(avant, { type: 'recherche_fin', erreur: message });
  const recherche = JSON.parse(JSON.stringify(apres)).recherches[0];
  assert.equal(recherche.statut, 'erreur');
  assert.equal(recherche.erreur.length, 500);
  assert.ok(recherche.erreur.startsWith('HTTP 503 : '));
  assert.ok(recherche.erreur.endsWith('…'));
  assert.equal(avant.recherches[0].erreur, null);
});

test('une erreur courte reste exacte et une réussite efface l’ancienne erreur', () => {
  let etat = appliquerEvenement(neuf(), { type: 'recherche_fin', erreur: 'HTTP 404' });
  assert.equal(etat.recherches[0].erreur, 'HTTP 404');
  etat = appliquerEvenement(etat, { type: 'recherche_fin' });
  assert.equal(etat.recherches[0].statut, 'terminee');
  assert.equal(etat.recherches[0].erreur, null);
});
