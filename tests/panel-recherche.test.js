import assert from 'node:assert/strict';
import test from 'node:test';
import { HOLD, OPTIONS, deferred, monter } from './helpers/panel-chrome.js';
import { all, buttons, links, settle, visible } from './helpers/panel-dom.js';

const AD = 'https://www.leboncoin.fr/ad/consoles/1';
const AD2 = 'https://www.leboncoin.fr/ad/consoles/2';
const poison = '<img src=x onerror=alert(1)>';
const PERSISTEES = { ...OPTIONS, force: true, contactAuto: true };
const auto = (etat = {}) => ({ etat: { enabled: true, status: 'idle', nextRunAt: 1234, options: PERSISTEES, ...etat } });
const monterAvec = (etat, extra = {}) => monter({ replies: { 'recherche-auto-etat': auto(etat), ...extra } });

// Montre l'état d'un run, filtre « Toutes ».
async function monterRun(run) {
  const f = await monter({ replies: { 'run-etat': { etat: run } } });
  await f.click('filtre-toutes');
  return f;
}
const isOn = (f, id) => f.el(id).getAttribute('aria-checked') === 'true';

test('titres, classifications et erreurs sont rendus comme du texte, les liens dangereux sont omis', async () => {
  const f = await monterRun({ statut: 'bloque', erreur: poison, annonces: {
    a: { url_annonce: AD, titre: poison, classification: poison, erreur: poison, etat: 'erreur', prix_eur: 300 },
    b: { url_annonce: 'javascript:alert(1)', titre: poison },
  } });
  assert.ok(f.el('annonces-liste').textContent.includes(poison));
  assert.match(f.el('annonces-liste').textContent, /300 €/);
  assert.equal(buttons(f.el('annonces-liste')).length, 1, 'une URL dangereuse ne s’ouvre pas');
  assert.equal(links(f.el('annonces-liste')).length, 0);
  await f.row(AD).fire('click');
  const ouverts = links(f.el('fiche-annonce'));
  assert.equal(ouverts.length, 1);
  assert.equal(ouverts[0].href, AD);
  assert.equal(ouverts[0].rel, 'noopener noreferrer');
  assert.ok(f.el('fiche-annonce').textContent.includes(poison));
  assert.ok(links(f.root).every((a) => /^https:\/\/www\.leboncoin\.fr\//.test(a.href)));
  assert.match(f.el('statut-run').textContent, /BLOQUÉ/);
  assert.equal(f.el('pause').disabled, true);
  assert.equal(f.el('consigne-blocage').hidden, false);
  assert.equal(f.el('pilote-blocage').hidden, false);
});

test('le panneau restaure plusieurs URL et les soumet ligne par ligne', async () => {
  const a = 'https://www.leboncoin.fr/recherche?text=ps5';
  const b = 'https://www.leboncoin.fr/recherche?text=ps5+slim';
  const f = await monterAvec({ options: { ...PERSISTEES, urlsRecherche: [a, b] } });
  assert.match(f.el('ecran-criteres').textContent, /une par ligne/);
  assert.equal(f.el('url-recherche').value, `${a}\n${b}`);
  f.el('url-recherche').value = ` ${a} \n\n ${b} \n`;
  await f.click('lancer');
  assert.deepEqual(f.sent('run-demarrer')[0].options.urlsRecherche, [a, b]);
});

test('une ancienne option à URL unique est restaurée', async () => {
  const { urlsRecherche, ...ancienne } = PERSISTEES;
  const f = await monterAvec({ options: { ...ancienne, urlRecherche: urlsRecherche[0] } });
  assert.equal(f.el('url-recherche').value, urlsRecherche[0]);
  assert.equal(f.el('lancer').disabled, false);
});

test('utiliser l’onglet courant ajoute seulement une URL absente', async () => {
  const a = 'https://www.leboncoin.fr/recherche?text=ps5';
  const b = 'https://www.leboncoin.fr/recherche?text=ps5+slim';
  const f = await monter();
  f.el('url-recherche').value = a;
  f.chrome.tabs.query = async () => [{ url: `${a}&page=2` }];
  await f.click('onglet-courant');
  assert.equal(f.el('url-recherche').value, a);
  f.chrome.tabs.query = async () => [{ url: b }];
  await f.click('onglet-courant');
  assert.equal(f.el('url-recherche').value, `${a}\n${b}`);
  assert.deepEqual(f.sent('recherche-auto-configurer').at(-1).options.urlsRecherche, [a, b]);
  f.chrome.tabs.query = async () => [{ url: 'https://evil.example/recherche' }];
  await f.click('onglet-courant');
  assert.match(f.el('erreur-criteres').textContent, /invalides/);
  assert.equal(f.el('url-recherche').value, `${a}\n${b}`);
});

test('chaque recherche apparaît comme résumé textuel avec les compteurs', async () => {
  const f = await monterRun({ statut: 'en_cours', annonces: {}, recherches: [
    { urlRecherche: poison, index: 0, statut: 'en_cours', annonces_recues: ['a'], page_suivante: 2 },
  ] });
  const rows = f.el('resume-recherches').children;
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /1 annonce/);
  assert.match(rows[0].textContent, /en_cours/);
  assert.match(rows[0].textContent, /prochaine page/);
  assert.match(rows[0].textContent, /<img/);
});

test('les contrôles affichent Reprendre en pause et les compteurs sont issus des étapes réussies', async () => {
  const f = await monterRun({ statut: 'pause', annonces: {
    a: { url_annonce: AD, en_base: true, analysee: true, classification: 'saint_graal', erreur: 'detail', etat: 'erreur' },
  } });
  assert.equal(f.el('pause').textContent, 'Reprendre');
  assert.equal(f.el('pause').disabled, false);
  assert.equal(f.el('lancer').disabled, true);
  assert.equal(f.el('lancer').hidden, true);
  assert.match(f.el('compteurs').textContent, /1 reçues.*1 en base.*1 analysées.*1 retenues.*1 erreurs/);
  assert.match(f.el('avancement').textContent, /1 annonces analysées sur 1/);
});

test('Pause, Reprendre et Stop partent même quand une commande précédente attend encore', async () => {
  const f = await monter({ replies: { 'run-etat': { etat: { statut: 'en_cours', annonces: {} } }, 'run-pause': HOLD } });
  void f.click('pause');
  assert.equal(f.el('pause').disabled, false);
  void f.click('arreter');
  assert.equal(f.sent('run-pause').length, 1);
  assert.equal(f.sent('run-arreter').length, 1);
  f.chrome.live({ type: 'run-maj', etat: { statut: 'pause', annonces: {} } });
  await f.click('pause');
  assert.equal(f.sent('run-reprendre').length, 1);
});

test('sans run, un grand bouton Lancer et aucun Pause ni Stop', async () => {
  const f = await monter();
  assert.equal(f.el('lancer').textContent, 'Lancer une recherche');
  assert.equal(f.el('lancer').hidden, false);
  assert.equal(f.el('pause').hidden, true);
  assert.equal(f.el('arreter').hidden, true);
  assert.match(f.el('statut-run').textContent, /Prêt à lancer/);
});

test('le bilan compte les recherches achevées et leurs erreurs sans les confondre avec les annonces', async () => {
  const f = await monterRun({ statut: 'en_cours', annonces: {}, recherches: [
    { index: 0, statut: 'terminee', page_suivante: 4 },
    { index: 1, statut: 'erreur', page_suivante: 2, erreur: 'Page indisponible' },
    { index: 2, statut: 'en_cours', page_suivante: 1 },
  ] });
  assert.match(f.el('compteurs').textContent, /Recherches : 2\/3/);
  assert.match(f.el('compteurs').textContent, /1 erreur de recherche/);
  assert.match(f.el('compteurs').textContent, /0 reçues/);
});

test('une réussite partielle expose chaque erreur comme texte et aucune prochaine page pour les recherches finies', async () => {
  const f = await monterRun({ statut: 'termine', annonces: {}, recherches: [
    { index: 0, statut: 'terminee', page_suivante: 4 },
    { index: 1, statut: 'erreur', page_suivante: 2, erreur: poison },
    { index: 2, statut: 'erreur', page_suivante: 1, erreur: 'HTTP 503' },
  ] });
  assert.match(f.el('compteurs').textContent, /Recherches : 3\/3/);
  assert.match(f.el('compteurs').textContent, /2 erreurs de recherche/);
  const rows = f.el('resume-recherches').children;
  assert.ok(rows[1].textContent.includes(poison));
  assert.ok(rows[2].textContent.includes('HTTP 503'));
  assert.ok(rows.every((row) => row.children.length === 0), 'les erreurs ne créent aucun élément HTML');
  assert.match(rows[0].textContent, /3 pages traitées/);
  assert.match(rows[1].textContent, /1 page traitée/);
  assert.match(rows[2].textContent, /0 pages traitées/);
  assert.ok(rows.every((row) => !row.textContent.includes('prochaine page')));
});

test('la fin de pagination en attente de détails affiche les pages traitées', async () => {
  const f = await monterRun({ statut: 'en_cours', annonces: {}, recherches: [
    { index: 0, statut: 'en_cours', page_suivante: 3, extraction_terminee: true },
  ] });
  const texte = f.el('resume-recherches').children[0].textContent;
  assert.match(texte, /2 pages traitées/);
  assert.doesNotMatch(texte, /prochaine page/);
});

test('aucun identifiant du panneau n’est en double et Fiches max est proposé et transmis', async () => {
  const f = await monter();
  const ids = all(f.root).map((node) => node.id).filter(Boolean);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  f.el('max-fiches').value = '12';
  await f.click('lancer');
  assert.equal(f.sent('run-demarrer')[0].options.maxFiches, 12);
});

test('une annonce affiche le résultat de son contact sans le rendre en HTML', async () => {
  const f = await monterRun({ statut: 'en_cours', annonces: {
    a: { url_annonce: AD, titre: 'PS5', classification: 'saint_graal', contact_envoye: true },
    b: { url_annonce: AD2, titre: 'PS5', classification: 'saint_graal', contact_skip: 'reply_indisponible' },
    c: { url_annonce: 'https://www.leboncoin.fr/ad/consoles/3', contact_skip: 'prix_hors_limite', deja_analysee: true },
  } });
  const [a, b, c] = f.rows().map((li) => li.textContent);
  assert.match(a, /Message envoyé/);
  assert.match(b, /Contact ignoré.*reply_indisponible/);
  assert.match(c, /prix inconnu ou au-dessus du prix maximum/);
  assert.match(c, /Déjà analysée en base/);
});

test('les filtres comptent les vraies annonces et n’inventent aucun nombre', async () => {
  const f = await monter({ replies: {
    'contact-shortlist': { ok: false, error: 'Serveur local injoignable.' },
    'run-etat': { etat: null },
  } });
  assert.equal(f.el('filtre-contacter').textContent, 'À contacter');
  assert.equal(f.el('filtre-verifier').textContent, 'À vérifier');
  assert.equal(f.el('filtre-contacter').getAttribute('aria-pressed'), 'true');
  f.chrome.live({ type: 'run-maj', etat: { statut: 'termine', annonces: {
    a: { url_annonce: AD, titre: 'Sans manette', classification: 'a_verifier' },
    b: { url_annonce: AD2, titre: 'Manette seule', classification: 'disqualifiee' },
  } } });
  assert.equal(f.el('filtre-verifier').textContent, 'À vérifier 1');
  await f.click('filtre-verifier');
  assert.equal(f.rows().length, 1);
  assert.match(f.el('annonces-liste').textContent, /Sans manette/);
  await f.click('filtre-toutes');
  assert.equal(f.rows().length, 2);
  assert.match(f.el('annonces-liste').textContent, /Écartée/);
});

test('le panneau n’active par défaut ni la réanalyse ni le contact automatique', async () => {
  const f = await monter({ replies: { 'recherche-auto-etat': HOLD }, wait: false });
  assert.equal(f.el('force').checked, false);
  assert.equal(isOn(f, 'contact-auto'), false);
  assert.equal(isOn(f, 'recherche-auto'), false);
  const chargee = await monter();
  assert.match(chargee.el('contact-auto-texte').textContent, /Désactivé/);
  chargee.chrome.live({ type: 'recherche-auto-maj', etat: { enabled: false, status: 'paused', options: PERSISTEES } });
  assert.match(chargee.el('contact-auto-texte').textContent, /Saint Graal et Intéressantes/);
  assert.doesNotMatch(chargee.el('contact-auto-texte').textContent, /vérifier/i);
});

test('une simulation de contact est affichée clairement comme telle', async () => {
  const f = await monterRun({ statut: 'termine', annonces: {
    a: { url_annonce: AD, contact_skip: 'simulation', contact_simule: true },
    b: { url_annonce: AD2, contact_skip: 'simulation' },
  } });
  const [a, b] = f.rows().map((li) => li.textContent);
  assert.match(a, /Simulation.*saisi.*non envoyé.*onglet/i);
  assert.match(b, /Simulation.*non tenté/i);
  assert.match(f.el('statut-run').textContent, /Mode test.*aucun message envoyé/i);
});

test('le chargement différé restaure les options persistées avant d’autoriser une action', async () => {
  const saved = deferred();
  const f = await monter({ replies: { 'recherche-auto-etat': () => saved.promise }, wait: false });
  await settle();
  for (const id of ['lancer', 'force', 'contact-auto', 'recherche-auto', 'url-recherche', 'max-pages',
    'max-resultats', 'max-fiches', 'onglet-courant']) assert.equal(f.el(id).disabled, true, id);

  await f.click('lancer');
  await f.el('force').fire('change');
  await f.click('contact-auto');
  await f.click('recherche-auto');
  await f.click('onglet-courant');
  f.chrome.live({ type: 'run-maj', etat: null });
  assert.equal(f.el('lancer').disabled, true);
  assert.deepEqual(f.chrome.messages.filter((m) => /^(run-demarrer|recherche-auto-(configurer|activer))$/.test(m.type)), []);

  saved.resolve(auto({ options: { ...OPTIONS, force: false, contactAuto: false } }));
  await f.panneau.pret;
  assert.equal(f.el('force').checked, false);
  assert.equal(isOn(f, 'contact-auto'), false);
  assert.equal(f.el('force').disabled, false);
  assert.equal(f.el('lancer').disabled, false);
});

test('un échec de chargement garde les actions verrouillées et demande de recharger', async () => {
  for (const reply of [{ ok: false, error: 'Stockage indisponible' }, { etat: { enabled: true, options: { maxPages: 1 } } }]) {
    const f = await monter({ replies: { 'recherche-auto-etat': reply } });
    for (const id of ['force', 'contact-auto', 'recherche-auto', 'lancer']) assert.equal(f.el(id).disabled, true);
    for (const id of ['erreur-pilote', 'erreur-run', 'erreur-criteres']) assert.match(f.el(id).textContent, /recharg/i);
  }
});

test('couper le premier message transmet contactAuto false et le persiste dans l’autopilote', async () => {
  const f = await monterAvec();
  assert.equal(isOn(f, 'contact-auto'), true);
  await f.click('contact-auto');
  assert.equal(isOn(f, 'contact-auto'), false);
  assert.equal(f.sent('recherche-auto-configurer').at(-1).options.contactAuto, false);
  await f.click('lancer');
  assert.equal(f.sent('run-demarrer')[0].options.contactAuto, false);
});

test('même autopilote arrêté, l’interrupteur de contact est persisté : il ne ment pas à la réouverture', async () => {
  const f = await monter();
  await f.click('contact-auto');
  assert.equal(f.sent('recherche-auto-configurer').at(-1).options.contactAuto, true);
  assert.equal(isOn(f, 'contact-auto'), true);
});

test('un critère invalide n’empêche pas de couper le contact automatique', async () => {
  const f = await monterAvec();
  f.el('url-recherche').value = 'pas une url';
  await f.click('contact-auto');
  assert.deepEqual(f.sent('recherche-auto-configurer').at(-1).options, { ...PERSISTEES, contactAuto: false });
  assert.equal(f.el('url-recherche').value, 'pas une url');
});

test('un refus d’enregistrement rétablit l’interrupteur et le dit', async () => {
  const f = await monterAvec({}, { 'recherche-auto-configurer': { ok: false, error: 'Stockage plein' } });
  await f.click('contact-auto');
  assert.equal(isOn(f, 'contact-auto'), true);
  assert.match(f.el('erreur-pilote').textContent, /Non enregistré.*Stockage plein/);
});

test('une valeur de critère refusée est signalée comme non enregistrée', async () => {
  const f = await monter({ replies: { 'recherche-auto-configurer': { ok: false, error: 'URL de recherche leboncoin ou limites invalides.' } } });
  await f.type('max-pages', '99', 'change');
  assert.match(f.el('erreur-criteres').textContent, /Non enregistré.*invalides/);
  assert.equal(f.el('max-pages').value, '99');
});

test('couper l’interrupteur pendant une recherche qui contacte prévient qu’elle peut encore envoyer', async () => {
  const f = await monterAvec({}, { 'run-etat': { etat: { statut: 'en_cours', contactAuto: true, annonces: {} } } });
  await f.click('contact-auto');
  assert.match(f.el('contact-auto-texte').textContent, /peut encore envoyer.*Stop/);
});

test('l’autopilote de recherche est décoché par défaut et annonce sa cadence', async () => {
  const f = await monter();
  assert.equal(isOn(f, 'recherche-auto'), false);
  assert.equal(f.el('recherche-auto').getAttribute('role'), 'switch');
  assert.match(f.el('ecran-accueil').textContent, /30 min environ/i);
});

test('décocher l’autopilote désactive les futurs cycles avec les options visibles', async () => {
  const f = await monterAvec();
  await f.click('recherche-auto');
  const message = f.sent('recherche-auto-activer')[0];
  assert.equal(message.enabled, false);
  assert.equal(message.options.maxPages, 3);
  assert.equal(message.options.contactAuto, true);
  assert.equal(isOn(f, 'recherche-auto'), false);
});

test('un état d’autopilote sans activation explicite reste décoché', async () => {
  const f = await monter({ replies: { 'recherche-auto-etat': { etat: { status: 'idle', options: OPTIONS } } } });
  assert.equal(isOn(f, 'recherche-auto'), false);
});

test('modifier une option la persiste pour les prochains cycles', async () => {
  const f = await monterAvec();
  await f.type('max-pages', '6', 'change');
  assert.equal(f.sent('recherche-auto-configurer').at(-1).options.maxPages, 6);
});

test('le statut et la prochaine échéance de l’autopilote sont rendus séparément', async () => {
  const f = await monter();
  const nextRunAt = new Date(2026, 8, 26, 14, 35, 0, 0).getTime();
  f.chrome.live({ type: 'recherche-auto-maj', etat: { enabled: true, status: 'retrying', nextRunAt, failureCount: 2 } });
  assert.equal(isOn(f, 'recherche-auto'), true);
  assert.match(f.el('statut-auto-recherche').textContent, /nouvel essai/i);
  assert.match(f.el('prochain-auto-recherche').textContent, /14:35/);
});

test('une diffusion ne remplace pas les critères en cours de saisie', async () => {
  const f = await monter();
  f.el('url-recherche').value = 'brouillon';
  f.chrome.live({ type: 'recherche-auto-maj', etat: { enabled: false, status: 'paused', options: PERSISTEES } });
  assert.equal(f.el('url-recherche').value, 'brouillon');
});

test('le bandeau ne dit pas qu’aucun message n’est parti après un envoi réel', async () => {
  const f = await monterRun({ statut: 'termine', annonces: {
    a: { url_annonce: AD, contact_skip: 'simulation', contact_simule: true },
    b: { url_annonce: AD2, contact_envoye: true },
  } });
  assert.doesNotMatch(f.el('statut-run').textContent, /aucun message envoyé/i);
});

test('une pause de l’utilisateur annonce qu’aucune relance automatique n’aura lieu', async () => {
  const f = await monter();
  const run = (etat) => f.chrome.live({ type: 'run-maj', etat: { annonces: {}, ...etat } });
  run({ statut: 'pause', pauseUtilisateur: true });
  assert.match(f.el('statut-run').textContent, /aucune relance automatique.*Reprendre ou Stop/i);
  run({ statut: 'pause', pauseUtilisateur: false, erreur: 'Panne' });
  assert.doesNotMatch(f.el('statut-run').textContent, /aucune relance/i);
  run({ statut: 'bloque', pauseUtilisateur: true });
  assert.equal(f.el('arreter').disabled, false);
  await f.click('nav-annonces');
  assert.equal(visible(f.root, f.el('arreter')), true);
});

test('l’autopilote suspendu et la désactivation sont expliqués', async () => {
  const f = await monter();
  assert.match(f.el('ecran-accueil').textContent, /Désactiver[^.]*envois automatiques/);
  assert.match(f.el('ecran-accueil').textContent, /suspend jusqu’à Reprendre ou Stop/);
  f.chrome.live({ type: 'recherche-auto-maj', etat: { enabled: true, status: 'suspended', nextRunAt: null } });
  assert.match(f.el('statut-auto-recherche').textContent, /suspendu/i);
  assert.match(f.el('prochain-auto-recherche').textContent, /Reprendre ou Stop/);
});

const avertissement = (f) => (visible(f.root, f.el('avis-contact')) ? f.el('avis-contact').textContent : '');
const avisRun = (f) => (visible(f.root, f.el('avis-contact-run')) ? f.el('avis-contact-run').textContent : '');
async function annonces({ settings, failGet, contactAuto = true, run = null } = {}) {
  const f = await monter({ settings, failGet, replies: {
    'recherche-auto-etat': auto({ enabled: false, status: 'paused', options: { ...OPTIONS, contactAuto } }),
    'run-etat': { etat: run },
  } });
  await f.click('nav-annonces');
  return f;
}

test('près de Lancer, l’envoi automatique du premier message est annoncé et suit l’interrupteur et le mode', async () => {
  const f = await annonces();
  assert.equal(avertissement(f), 'Le premier message sera envoyé automatiquement aux meilleures annonces.');
  f.chrome.emit({ dryRun: true });
  assert.match(avertissement(f), /Mode test.*seulement tapé.*jamais envoyé/);
  assert.doesNotMatch(avertissement(f), /sera envoyé automatiquement/);
  await f.click('contact-auto');
  assert.equal(avertissement(f), '');
  await f.click('contact-auto');
  assert.match(avertissement(f), /seulement tapé/);
  const arret = await annonces({ contactAuto: false });
  assert.equal(avertissement(arret), '');
  const inconnu = await annonces({ failGet: true });
  assert.match(avertissement(inconnu), /Mode inconnu/);
});

for (const statut of ['en_cours', 'pause']) {
  test(`une recherche qui contacte le dit sur sa carte : ${statut}`, async () => {
    const run = { statut, contactAuto: true, annonces: {} };
    // L'interrupteur coupé ne retire rien à la recherche déjà partie.
    const f = await annonces({ run, contactAuto: false });
    assert.equal(avertissement(f), '', 'Lancer est masqué, son avis aussi');
    assert.match(avisRun(f), /premier message.*envoyé automatiquement aux meilleures annonces/i);
    if (statut === 'pause') {
      assert.equal(f.el('pause').textContent, 'Reprendre');
      assert.match(avisRun(f), /Reprendre/);
    }
    f.chrome.emit({ dryRun: true });
    assert.match(avisRun(f), /Mode test.*seulement tapé/);
    f.chrome.live({ type: 'run-maj', etat: { ...run, contactAuto: false } });
    assert.equal(avisRun(f), '');
    f.chrome.live({ type: 'run-maj', etat: { ...run, statut: 'termine' } });
    assert.equal(avisRun(f), '');
    const inconnu = await annonces({ run, failGet: true });
    assert.match(avisRun(inconnu), /Mode inconnu/);
  });
}
