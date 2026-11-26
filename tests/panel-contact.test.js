import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, monter } from './helpers/panel-chrome.js';
import { buttonNamed, buttons, links, settle } from './helpers/panel-dom.js';

const A = 'https://www.leboncoin.fr/ad/consoles/123';
const B = 'https://www.leboncoin.fr/ad/consoles/456';
const poison = '<img src=x onerror=alert(1)>';

// `ouvrir` choisit la première ligne (ou « autre annonce » si la liste est vide).
async function fixture({ annonces = [{ url_annonce: A, vendeur: 'Alice', titre: 'PS5', prix_eur: 300,
  ville: 'Paris', classification: 'saint_graal' }], templates, storageError, queryError, currentUrl = B,
  shortlistError, reservations = [], reservationsReponse, resolutionReponse = { ok: true, resolue: true },
  runtimeError, prepareResponse = { ok: true, envoye: true, suivi: true, tabId: 7 }, holdPrepare = false,
  settings, failGet, ouvrir = true } = {}) {
  const held = deferred();
  let rows = annonces;
  const f = await monter({ templates, storageError, settings, failGet, replies: {
    'contact-shortlist': () => (shortlistError ? { ok: false, error: shortlistError } : { ok: true, annonces: rows }),
    'contact-reservations': () => reservationsReponse ?? { ok: true, reservations },
    'contact-reservation-resoudre': () => {
      if (resolutionReponse.resolue) reservations = [];
      return resolutionReponse;
    },
    'contact-envoyer': () => {
      if (holdPrepare) return held.promise;
      return runtimeError ? { lastError: runtimeError } : prepareResponse;
    },
  } });
  f.chrome.tabs.query = async () => { if (queryError) throw new Error(queryError); return [{ url: currentUrl }]; };
  if (ouvrir) {
    const premiere = buttons(f.el('annonces-liste'))[0];
    if (premiere) await premiere.fire('click');
    else await f.click('autre-annonce');
  }
  return Object.assign(f, {
    respond(response = prepareResponse) { held.resolve(response ?? { lastError: 'Aucune réponse' }); },
    set shortlist(next) { rows = next; },
    envois: () => f.sent('contact-envoyer'),
    retour: () => f.el('retour-envoi').textContent,
    async autre(url) { await f.click('autre-annonce'); await f.type('url-manuelle', url); },
  });
}

test('seller shortlist and stored template names render as text; variables populate an editable message', async () => {
  const f = await fixture({ annonces: [{ url_annonce: A, vendeur: poison, titre: poison, prix_eur: 300, ville: 'Paris', classification: poison }],
    templates: [{ id: poison, nom: poison, texte: '{{vendeur}} / {{titre}} / {{prix}} / {{ville}}' }] });
  assert.equal(f.rows().length, 1);
  assert.match(f.rows()[0].textContent, /300 €/);
  assert.ok(f.rows()[0].textContent.includes(poison));
  assert.equal(f.el('modeles').children[0].textContent, poison);
  assert.equal(f.el('message').value, `${poison} / ${poison} / 300 / Paris`);
  assert.notEqual(f.el('message').readOnly, true);
  assert.match(f.el('shortlist-etat').textContent, /1.*vendeur/i);
  assert.match(f.el('origine-liste').textContent, /une annonce par vendeur connu/i);
  assert.equal(f.el('filtre-contacter').textContent, 'À contacter 1');
  assert.equal(f.el('preparer').textContent, 'Envoyer le message');
  assert.match(f.el('aide-envoi').textContent, /partira depuis votre compte/);
  assert.equal(f.el('preparer').disabled, false);
  assert.equal(links(f.el('fiche-annonce'))[0].href, A);
});

test('default templates load when no stored templates exist; missing variables are warned', async () => {
  const f = await fixture({ annonces: [{ url_annonce: A, vendeur: null }] });
  assert.equal(f.el('modeles').children.length, 2);
  await f.el('modeles').children[1].fire('click');
  assert.equal(f.el('modeles').children[1].getAttribute('aria-pressed'), 'true');
  assert.match(f.el('message').value, /^Bonjour ,/);
  assert.match(f.el('manquantes').textContent, /vendeur/);
  assert.match(f.el('ecran-fiche').textContent, /\{\{vendeur\}\}.*\{\{ville\}\}/);
});

test('clicking the template already selected keeps the edited draft', async () => {
  const f = await fixture();
  await f.type('message', 'Mon texte');
  await f.el('modeles').children[0].fire('click');
  assert.equal(f.el('message').value, 'Mon texte');
});

test('an edited message is sent verbatim and duplicate send clicks cannot enqueue work', async () => {
  const f = await fixture({ holdPrepare: true });
  await f.type('message', `Ma réponse exacte\n${poison}`);
  const first = f.click('preparer');
  await settle();
  await f.click('preparer');
  assert.equal(f.el('preparer').disabled, true);
  for (const id of ['message', 'url-manuelle', 'recharger', 'contact-onglet-courant']) assert.equal(f.el(id).disabled, true, id);
  assert.ok(f.el('modeles').children.every((node) => node.disabled));
  assert.deepEqual(f.envois(), [{
    type: 'contact-envoyer', urlAnnonce: A, texte: `Ma réponse exacte\n${poison}`, vendeur: 'Alice',
  }]);
  f.shortlist = []; f.respond(); await first;
  await settle();
  assert.match(f.retour(), /envoyé/i);
  assert.equal(buttons(f.el('annonces-liste')).length, 0);
  assert.equal(f.el('recharger').disabled, false);
  assert.equal(f.el('ecran-annonces').hidden, false, 'retour à la liste après un envoi confirmé');
  assert.match(f.el('toast-texte').textContent, /Message envoyé/);
});

test('the target is frozen while a send is in progress', async () => {
  const f = await fixture({ holdPrepare: true, annonces: [{ url_annonce: A, vendeur: 'Alice' }, { url_annonce: B, vendeur: 'Bob' }] });
  const envoi = f.click('preparer');
  await settle();
  await f.click('nav-annonces');
  await f.row(B).fire('click');
  assert.equal(f.el('ecran-fiche').hidden, false);
  assert.match(f.el('fiche-annonce').textContent, /Alice/);
  assert.match(f.el('toast-texte').textContent, /Envoi en cours/);
  await f.click('autre-annonce');
  await f.type('url-manuelle', B);
  assert.match(f.el('fiche-annonce').textContent, /Alice/);
  assert.match(f.retour(), /en cours/i);
  f.respond(); await envoi;
  assert.deepEqual(f.envois().map((m) => m.urlAnnonce), [A]);
});

test('a success that arrives after leaving the screen does not move the user', async () => {
  const f = await fixture({ holdPrepare: true });
  const envoi = f.click('preparer');
  await settle();
  await f.click('nav-reglages');
  f.respond(); await envoi;
  assert.equal(f.el('ecran-reglages').hidden, false);
  assert.match(f.el('toast-texte').textContent, /Message envoyé/);
});

test('refresh preserves a manually edited draft and the selected seller', async () => {
  const f = await fixture({ annonces: [{ url_annonce: A, vendeur: 'Alice' }, { url_annonce: B, vendeur: 'Bob' }] });
  await f.row(B).fire('click');
  await f.type('message', 'Je garde ce brouillon');
  await f.click('recharger');
  await settle();
  assert.match(f.el('fiche-annonce').textContent, /Bob/);
  assert.equal(f.el('message').value, 'Je garde ce brouillon');
  await f.click('retour');
  await settle();
  await f.row(B).fire('click');
  assert.equal(f.el('message').value, 'Je garde ce brouillon', 'rouvrir la même annonce garde le brouillon');
  await f.row(A).fire('click');
  assert.notEqual(f.el('message').value, 'Je garde ce brouillon', 'une autre annonce repart du modèle');
});

test('a refresh that drops the chosen ad never switches the target', async () => {
  const f = await fixture({ annonces: [{ url_annonce: A, vendeur: 'Alice' }, { url_annonce: B, vendeur: 'Bob' }] });
  f.shortlist = [{ url_annonce: B, vendeur: 'Bob' }];
  await f.click('recharger');
  await settle();
  await f.click('preparer');
  assert.equal(f.envois()[0].urlAnnonce, A);
});

test('manual URL and current tab override the selection, with validation before preparation', async () => {
  const f = await fixture();
  await f.autre('https://evil.example/ad/consoles/123');
  assert.equal(f.el('preparer').disabled, true);
  assert.equal(links(f.el('fiche-annonce')).length, 0);
  await f.click('preparer');
  assert.equal(f.envois().length, 0);
  await f.click('contact-onglet-courant');
  assert.equal(f.el('url-manuelle').value, B);
  assert.equal(f.el('preparer').disabled, false);
  await f.click('preparer');
  assert.equal(f.envois()[0].urlAnnonce, B);
  assert.equal('vendeur' in f.envois()[0], false);
});

test('« autre annonce » never falls back to a previously selected ad', async () => {
  const f = await fixture();
  await f.click('autre-annonce');
  assert.equal(f.el('bloc-autre').hidden, false);
  assert.equal(f.el('preparer').disabled, true);
  await f.click('preparer');
  assert.equal(f.envois().length, 0);
});

test('a manual URL matching a known ad reuses its data and its memory', async () => {
  const f = await fixture({ prepareResponse: { ok: false, envoye: false, terminal: true, error: 'État terminal' } });
  await f.click('preparer');
  await f.autre(`${A}?ref=x`);
  assert.match(f.el('fiche-annonce').textContent, /Alice/);
  assert.equal(f.el('preparer').disabled, true);
  assert.equal(f.retour(), 'État terminal');
});

test('empty shortlist or message disables preparation; a manual URL still works with an editable draft', async () => {
  const f = await fixture({ annonces: [] });
  assert.match(f.el('annonces-liste').textContent, /Aucun vendeur à contacter/);
  assert.equal(f.el('preparer').disabled, true);
  await f.type('url-manuelle', A);
  assert.equal(f.el('preparer').disabled, false);
  await f.type('message', ' \n');
  assert.equal(f.el('preparer').disabled, true);
});

test('partial tracking failure warns about the sent message and blocks blind retry even after reload', async () => {
  const f = await fixture({ prepareResponse: { ok: false, envoye: true, suivi: false, error: poison, tabId: 7 } });
  await f.click('preparer');
  assert.match(f.retour(), /envoyé.*suivi/i);
  assert.ok(f.retour().includes(poison));
  assert.match(f.retour(), /ne renvoyez pas|vérifiez/i);
  assert.equal(f.el('preparer').disabled, true);
  await f.click('recharger');
  await settle();
  await f.click('preparer');
  assert.equal(f.envois().length, 1);
  assert.match(f.retour(), /envoyé.*suivi/i);
});

test('successful seller-wide tracking removes matching seller rows and confirms sending', async () => {
  const f = await fixture({ annonces: [{ url_annonce: A, vendeur: 'Alice' }, { url_annonce: B, vendeur: ' alice ' }] });
  await f.click('preparer');
  await settle();
  assert.equal(buttons(f.el('annonces-liste')).length, 0);
  assert.match(f.retour(), /envoyé/i);
});

test('a persisted non-contactable ad is skipped, removed and never retried blindly', async () => {
  const f = await fixture({ prepareResponse: {
    ok: false, envoye: false, skip: true, suivi: true, erreurCode: 'formulaire_absent',
    error: 'Cette annonce ne permet pas l’envoi d’un message.', tabId: 7,
  } });
  await f.click('preparer');
  await settle();
  assert.match(f.retour(), /ne permet pas.*envoi/i);
  assert.equal(f.el('preparer').disabled, true);
  assert.equal(buttons(f.el('annonces-liste')).length, 0);
  await f.click('recharger');
  await f.click('preparer');
  assert.equal(f.envois().length, 1);
});

test('runtime lastError makes outcome uncertainty explicit and blocks blind retry', async () => {
  const f = await fixture({ runtimeError: `Le port du message est fermé ${poison}` });
  await f.click('preparer');
  assert.match(f.retour(), /inconnu|incertain/i);
  assert.ok(f.retour().includes(poison));
  assert.equal(f.el('preparer').disabled, true);
  await f.autre(A);
  assert.equal(f.el('preparer').disabled, true);
});

test('a deduplicated reservation refusal is skipped without retry or persistence bypass', async () => {
  const f = await fixture({ prepareResponse: {
    ok: false, envoye: false, skip: true, dedoublonne: true, raison: 'reservation_existante',
  } });
  await f.type('message', 'Bonjour personnalisé');
  await f.click('preparer');
  await settle();
  assert.doesNotMatch(f.retour(), /inconnu|envoyé|échoué/i);
  assert.equal(f.el('preparer').disabled, true);
  await f.click('recharger');
  await f.click('preparer');
  assert.deepEqual(f.envois(), [{ type: 'contact-envoyer', urlAnnonce: A, texte: 'Bonjour personnalisé', vendeur: 'Alice' }]);
});

test('preparation errors render safely and release controls for a corrected attempt', async () => {
  const f = await fixture({ prepareResponse: { ok: false, error: poison } });
  await f.click('preparer');
  assert.equal(f.retour(), poison);
  assert.equal(f.el('preparer').disabled, false);
  assert.equal(f.el('recharger').disabled, false);
});

test('storage, shortlist and current-tab errors remain visible text without breaking manual contact', async () => {
  const f = await fixture({ storageError: poison, shortlistError: poison, queryError: poison });
  assert.equal(f.el('modeles').children.length, 2);
  assert.ok(f.el('templates-etat').textContent.includes(poison));
  assert.equal(f.el('shortlist-etat').textContent, poison);
  assert.equal(f.el('filtre-contacter').textContent, 'À contacter');
  await f.click('contact-onglet-courant');
  assert.ok(f.retour().includes(poison));
  await f.type('url-manuelle', A);
  assert.equal(f.el('preparer').disabled, false);
});

test('malformed templates and invalid shortlist URLs do not become executable markup or destinations', async () => {
  const f = await fixture({ templates: [{ id: 'x', nom: poison, texte: null }, null],
    annonces: [null, { url_annonce: 'javascript:alert(1)', titre: poison }, { url_annonce: A, vendeur: 'Alice' }] });
  assert.equal(f.el('modeles').children.length, 2);
  assert.equal(f.rows().length, 1);
  assert.equal(buttons(f.el('annonces-liste'))[0].getAttribute('data-url'), A);
});

test('a delayed shortlist response cannot overwrite a manual draft edited while loading', async () => {
  const f = await fixture();
  const lente = deferred();
  f.chrome.replies['contact-shortlist'] = () => lente.promise;
  void f.click('recharger');
  assert.equal(f.el('preparer').disabled, true);
  await f.autre(B);
  await f.type('message', 'Texte saisi pendant le chargement');
  lente.resolve({ ok: true, annonces: [{ url_annonce: A, vendeur: 'Alice' }] });
  await settle();
  assert.equal(f.el('message').value, 'Texte saisi pendant le chargement');
  assert.equal(f.el('url-manuelle').value, B);
});

test('a current-tab lookup begun before preparation cannot switch targets after typing starts', async () => {
  const f = await fixture({ holdPrepare: true });
  await f.autre(A);
  const lookup = deferred();
  f.chrome.tabs.query = () => lookup.promise;
  const query = f.click('contact-onglet-courant');
  const preparation = f.click('preparer');
  lookup.resolve([{ url: B }]); await query;
  assert.equal(f.el('url-manuelle').value, A);
  f.respond(); await preparation;
});

test('a missing response is uncertain and cannot release the same target for another preparation', async () => {
  const f = await fixture({ holdPrepare: true });
  const pending = f.click('preparer');
  await settle();
  f.respond(null); await pending;
  assert.match(f.retour(), /inconnu/i);
  assert.equal(f.el('preparer').disabled, true);
});

test('shortlist runtime errors are consumed and leave an actionable error in the panel', async () => {
  const f = await fixture();
  f.chrome.replies['contact-shortlist'] = { lastError: poison };
  await f.click('recharger');
  await settle();
  assert.equal(f.el('shortlist-etat').textContent, poison);
  assert.equal(f.el('recharger').disabled, false);
});

test('test mode labels the send as a trial; an unknown mode forbids sending', async () => {
  const essai = await fixture({ settings: { dryRun: true } });
  assert.equal(essai.el('preparer').textContent, 'Essayer sans envoyer');
  assert.match(essai.el('aide-envoi').textContent, /sans être envoyé/);
  essai.chrome.emit({ dryRun: false });
  assert.equal(essai.el('preparer').textContent, 'Envoyer le message');
  const inconnu = await fixture({ failGet: true });
  assert.equal(inconnu.el('preparer').disabled, true);
  assert.match(inconnu.el('aide-envoi').textContent, /Mode inconnu/);
  await inconnu.click('preparer');
  assert.equal(inconnu.envois().length, 0);
});

test('a simulation is shown as such, hides nothing and allows a later real send', async () => {
  const f = await fixture({ prepareResponse: { ok: true, envoye: false, dryRun: true, tabId: 7 } });
  await f.click('preparer');
  assert.match(f.retour(), /Simulation.*rien n’a été envoyé/i);
  assert.equal(f.el('preparer').disabled, false);
  assert.equal(f.row(A) !== undefined, true);
});

test('a simulation problem is still labelled as a simulation', async () => {
  const f = await fixture({ prepareResponse: { ok: false, envoye: false, dryRun: true, skip: true, error: 'Formulaire absent.' } });
  await f.click('preparer');
  assert.match(f.retour(), /Simulation.*Formulaire absent/i);
  assert.equal(f.rows().length, 1);
});

for (const sort of [{ contact_envoye: true }, { contact_skip: 'envoi_incertain' }]) {
  test(`an ad the search already sent to (${Object.keys(sort)[0]}) cannot be sent again from the panel`, async () => {
    const f = await fixture({ ouvrir: false });
    f.chrome.live({ type: 'run-maj', etat: { id: 'r1', statut: 'termine', annonces: {
      a: { url_annonce: A, donnees: { vendeur: 'Alice' }, ...sort },
    } } });
    await f.click('filtre-toutes');
    await f.row(A).fire('click');
    assert.equal(f.el('preparer').disabled, true);
    await f.click('preparer');
    assert.equal(f.envois().length, 0);
  });
}

const RESERVATION = { url_annonce: A, titre: poison, vendeur: 'Alice', reservation_le: '2026-11-25T10:00:00.000Z' };
const cliquer = (f, titre) => buttonNamed(f.el('reservations'), titre).fire('click');
const deplier = (f) => buttons(f.el('reservations'))[0].fire('click');
const resolutions = (f) => f.sent('contact-reservation-resoudre');

for (const [titre, resultat] of [['Oui, il est parti', 'envoye'], ['Non', 'non_envoye']]) {
  test(`a stuck reservation is resolved as ${resultat} only after confirmation`, async () => {
    const f = await fixture({ reservations: [RESERVATION], ouvrir: false });
    const tete = buttons(f.el('reservations'))[0];
    assert.equal(tete.getAttribute('aria-expanded'), 'false');
    assert.match(tete.textContent, /Alice : message parti \?/);
    await deplier(f);
    assert.equal(tete.getAttribute('aria-expanded'), 'true');
    assert.ok(f.el('reservations').textContent.includes(poison));
    assert.match(f.el('reservations').textContent, /plus de 10 minutes/);
    assert.deepEqual(links(f.el('reservations')).map((a) => a.href), ['https://www.leboncoin.fr/messages', A]);
    await cliquer(f, titre);
    assert.deepEqual(resolutions(f), []);
    await cliquer(f, 'Annuler');
    assert.deepEqual(resolutions(f), []);
    await cliquer(f, titre);
    await cliquer(f, 'Confirmer');
    await settle();
    assert.deepEqual(resolutions(f), [{ type: 'contact-reservation-resoudre', urlAnnonce: A, resultat }]);
    assert.equal(buttons(f.el('reservations')).length, 0);
    assert.match(f.el('reservations-etat').textContent, /résolue/i);
  });
}

test('confirming that nothing left releases the panel memory for that seller', async () => {
  const f = await fixture({ reservations: [RESERVATION], runtimeError: 'port fermé' });
  await f.click('preparer');
  assert.equal(f.el('preparer').disabled, true);
  await deplier(f);
  await cliquer(f, 'Non');
  await cliquer(f, 'Confirmer');
  await settle();
  assert.equal(f.el('preparer').disabled, false);
});

test('reservation errors and refusals stay visible', async () => {
  const echec = await fixture({ reservationsReponse: { ok: false, error: poison }, ouvrir: false });
  assert.ok(echec.el('reservations-etat').textContent.includes(poison));
  assert.equal(echec.el('tout-a-jour').hidden, true);
  const refus = await fixture({ reservations: [RESERVATION], resolutionReponse: { ok: true, resolue: false }, ouvrir: false });
  await deplier(refus);
  await cliquer(refus, 'Non');
  await cliquer(refus, 'Confirmer');
  await settle();
  assert.match(refus.el('reservations-etat').textContent, /pas été résolue/i);
});

test('the reservation list can be refreshed by hand', async () => {
  const f = await fixture({ ouvrir: false });
  assert.match(f.el('reservations-etat').textContent, /Aucun envoi à vérifier/);
  await f.click('reservations-recharger');
  assert.equal(f.sent('contact-reservations').length, 2);
});

test('a block coming from a running search explains itself on the open message screen', async () => {
  const f = await fixture();
  assert.equal(f.retour(), '');
  f.chrome.live({ type: 'run-maj', etat: { id: 'r1', statut: 'en_cours', annonces: {
    a: { url_annonce: B, donnees: { vendeur: 'alice' }, contact_envoye: true },
  } } });
  assert.match(f.retour(), /déjà envoyé/);
  assert.equal(f.el('preparer').disabled, true);
});

for (const [cas, reponse, attendu] of [
  ['incertain', { ok: false, envoye: false, terminal: true, error: 'Envoi incertain.' }, /Envoi incertain/],
  ['envoyé sans suivi', { ok: false, envoye: true, suivi: false, error: 'Base arrêtée.' }, /suivi a échoué.*Base arrêtée/],
  ['annonce ignorée', { ok: false, envoye: false, skip: true, error: 'Formulaire absent.' }, /Formulaire absent/],
  ['doublon', { ok: false, envoye: false, skip: true, dedoublonne: true, raison: 'reservation_existante' }, /ne permet pas/],
  ['erreur simple', { ok: false, error: 'Onglet fermé.' }, /Onglet fermé/],
  ['réponse inattendue', { ok: true }, /inconnu/],
  ['aucune réponse', null, /inconnu/],
  ['essai en échec', { ok: false, envoye: false, dryRun: true, error: 'Champ absent.' }, /Simulation.*Champ absent/],
]) {
  test(`écran quitté pendant l’envoi, un message bref nomme le vendeur : ${cas}`, async () => {
    const f = await fixture({ holdPrepare: true });
    const envoi = f.click('preparer');
    await settle();
    await f.click('nav-accueil');
    f.respond(reponse); await envoi; await settle();
    assert.equal(f.el('ecran-accueil').hidden, false);
    assert.equal(f.el('toast').hidden, false);
    assert.match(f.el('toast-texte').textContent, /^Alice : /);
    assert.match(f.el('toast-texte').textContent, attendu);
  });
}

test('sans nom de vendeur, le message bref désigne l’annonce ; sur la fiche il n’y en a pas', async () => {
  for (const [annonce, nom] of [[{ url_annonce: A, titre: 'PS5 Slim' }, 'PS5 Slim'], [{ url_annonce: A }, A]]) {
    const f = await fixture({ holdPrepare: true, annonces: [annonce] });
    const envoi = f.click('preparer');
    await settle();
    await f.click('nav-accueil');
    f.respond({ ok: false, error: 'Panne.' }); await envoi;
    assert.equal(f.el('toast-texte').textContent, `${nom} : Panne.`);
  }
  const reste = await fixture({ prepareResponse: { ok: false, error: 'Panne.' } });
  await reste.click('preparer');
  assert.equal(reste.el('toast').hidden, true);
});
