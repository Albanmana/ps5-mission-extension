import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../extension/lib/settings.js';
import { suivreMode } from '../extension/panel/vue-reglages.js';
import { chromeTest, monter } from './helpers/panel-chrome.js';
import { all, settle, visible } from './helpers/panel-dom.js';

async function fixture(stored, options = {}) {
  const f = await monter({ settings: stored, ...options });
  await f.click('nav-reglages');
  const el = (id) => f.el(`reglages-${id}`);
  const confirmations = () => [el('confirmation-mode'), el('confirmation-portee')].filter((node) => !node.hidden);
  return {
    ...f, el, confirmations,
    saved: () => f.chrome.data[SETTINGS_KEY],
    isOn: () => el('simulation').getAttribute('aria-checked') === 'true',
    async toggleMode() { await el('simulation').fire('click'); },
    async scope(id) {
      el('portee-toutes').checked = id === 'portee-toutes';
      el('portee-contactees').checked = id === 'portee-contactees';
      await el(id).fire('change');
    },
    confirm: () => el(`${confirmations()[0].id.replace('reglages-', '')}-confirmer`).fire('click'),
    cancel: () => el(`${confirmations()[0].id.replace('reglages-', '')}-annuler`).fire('click'),
    async fill(values) {
      for (const [id, value] of Object.entries(values)) { el(id).value = value; await el(id).fire('input'); }
    },
    submit: () => el('formulaire').fire('submit'),
  };
}

test('les réglages par défaut envoient réellement et sont expliqués, sans champ de clé API', async () => {
  const f = await fixture();
  assert.equal(f.isOn(), false);
  assert.equal(f.el('simulation').getAttribute('role'), 'switch');
  assert.equal(f.el('portee-contactees').checked, true);
  assert.equal(f.el('portee-toutes').checked, false);
  assert.equal(f.el('bon-prix').value, '350');
  assert.equal(f.el('prix-max').value, '370');
  assert.equal(f.el('explication-prix').textContent, 'Première offre à 340 €. 370 € seulement en dernière offre.');
  assert.deepEqual(f.confirmations(), []);
  assert.equal(f.el('enregistrer').hidden, true);
  const texte = f.root.textContent;
  assert.match(texte, /Désactivé par défaut.*partent réellement/i);
  assert.match(texte, /tapés.*jamais envoyés/i);
  assert.match(texte, /RESEND_API_KEY.*\.env/);
  assert.match(texte, /affichées sur l’Accueil/);
  assert.match(texte, /Seulement les annonces contactées par l’outil/);
  assert.match(texte, /Toutes les conversations/);
  assert.equal(f.chrome.writes.length, 0);
  for (const id of ['api-key', 'resend', 'cle']) assert.equal(f.root.querySelector(`#reglages-${id}`), null);
});

test('Enregistrer n’apparaît que si quelque chose a changé', async () => {
  const f = await fixture();
  await f.fill({ nom: 'Camille' });
  assert.equal(f.el('enregistrer').hidden, false);
  await f.fill({ nom: '' });
  assert.equal(f.el('enregistrer').hidden, true);
  assert.equal(f.chrome.writes.length, 0);
});

test('un enregistrement valide sauvegarde les champs', async () => {
  const f = await fixture();
  await f.fill({ nom: '  Camille ', email: ' camille@example.com ', 'bon-prix': '300', 'prix-max': '320' });
  await f.submit();
  assert.deepEqual(f.saved(), {
    ...DEFAULT_SETTINGS, ownerName: 'Camille', handoffEmail: 'camille@example.com', goodPrice: 300, maxPrice: 320,
  });
  assert.match(f.el('statut').textContent, /enregistré/i);
  assert.equal(f.el('erreur').textContent, '');
  assert.equal(f.el('nom').value, 'Camille');
  assert.equal(f.el('enregistrer').hidden, true);
  assert.match(f.el('explication-prix').textContent, /290 €\. 320 €/);
});

for (const [cas, values, message] of [
  ['email invalide', { email: 'camille@' }, /e-mail/i],
  ['prix vide', { 'bon-prix': '' }, /bon prix/i],
  ['prix décimal', { 'prix-max': '370.5' }, /prix maximum/i],
  ['prix trop bas', { 'bon-prix': '99' }, /100.*2000/],
  ['prix trop haut', { 'prix-max': '2001' }, /100.*2000/],
  ['bon prix au-dessus du maximum', { 'bon-prix': '400', 'prix-max': '370' }, /ne peut pas dépasser/i],
  ['nom trop long', { nom: 'a'.repeat(81) }, /80/],
]) {
  test(`saisie refusée sans rien sauvegarder : ${cas}`, async () => {
    const f = await fixture();
    await f.fill(values);
    await f.submit();
    assert.equal(f.chrome.writes.length, 0);
    assert.match(f.el('erreur').textContent, message);
    assert.equal(f.el('statut').textContent, '');
    for (const [id, value] of Object.entries(values)) assert.equal(f.el(id).value, value);
    assert.ok(['nom', 'email', 'bon-prix', 'prix-max'].some((id) => f.el(id).getAttribute('aria-invalid') === 'true'));
  });
}

for (const [nom, key, risky, warning] of [
  ['mode réel', 'dryRun', false, /vraiment envoyés depuis votre compte/i],
  ['portée totale', 'replyScope', 'all', /acheteur de PS5.*toutes les conversations.*sans rapport/i],
]) {
  const mode = key === 'dryRun';
  // La confirmation vers l'envoi réel ne se présente que depuis le mode test.
  const depart = mode ? { ...DEFAULT_SETTINGS, dryRun: true } : undefined;
  const demander = (f) => (mode ? f.toggleMode() : f.scope('portee-toutes'));
  const affiche = (f) => (mode ? !f.isOn() : f.el('portee-toutes').checked);

  test(`${nom} exige une confirmation, puis s’applique`, async () => {
    const f = await fixture(depart);
    await demander(f);
    assert.equal(f.confirmations().length, 1);
    assert.match(f.confirmations()[0].textContent, warning);
    assert.equal(f.chrome.writes.length, 0);
    await f.confirm();
    assert.equal(f.saved()[key], risky);
    assert.equal(affiche(f), true);
    assert.deepEqual(f.confirmations(), []);
  });

  test(`annuler ${nom} rétablit le choix sans écrire`, async () => {
    const f = await fixture(depart);
    await demander(f);
    const confirmer = `${f.confirmations()[0].id.replace('reglages-', '')}-confirmer`;
    await f.cancel();
    assert.equal(f.chrome.writes.length, 0);
    assert.equal(affiche(f), false);
    assert.equal(f.el('portee-contactees').checked, true);
    assert.deepEqual(f.confirmations(), []);
    await f.el(confirmer).fire('click');
    assert.equal(f.chrome.writes.length, 0, 'une confirmation annulée ne peut plus être rejouée');
  });
}

test('revenir au mode prudent s’applique immédiatement, même avec une saisie invalide', async () => {
  const f = await fixture({ ...DEFAULT_SETTINGS, dryRun: false, replyScope: 'all' });
  await f.fill({ email: 'invalide' });
  await f.toggleMode();
  await f.scope('portee-contactees');
  assert.deepEqual(f.saved(), { ...DEFAULT_SETTINGS, dryRun: true });
  assert.deepEqual(f.confirmations(), []);
  assert.equal(f.el('email').value, 'invalide');
});

test('un choix à confirmer ne se cumule pas et n’est pas sauvegardé par Enregistrer', async () => {
  const f = await fixture({ ...DEFAULT_SETTINGS, dryRun: true });
  await f.toggleMode();
  assert.equal(f.el('portee-toutes').disabled, true);
  assert.equal(f.el('simulation').disabled, true);
  await f.toggleMode();
  await f.fill({ nom: 'Camille' });
  await f.submit();
  assert.equal(f.saved().dryRun, true);
  assert.equal(f.saved().ownerName, 'Camille');
});

test('confirmer ou changer de mode ne sauvegarde pas les champs non enregistrés', async () => {
  const f = await fixture({ ...DEFAULT_SETTINGS, dryRun: true });
  await f.fill({ nom: 'Brouillon', 'bon-prix': '200' });
  await f.toggleMode();
  await f.confirm();
  assert.deepEqual(f.saved(), DEFAULT_SETTINGS);
  assert.equal(f.el('nom').value, 'Brouillon');
  assert.equal(f.el('enregistrer').hidden, false);
});

test('un changement externe met à jour le mode, préserve les brouillons et annule la confirmation', async () => {
  const f = await fixture();
  await f.fill({ nom: 'Brouillon' });
  await f.scope('portee-toutes');
  f.chrome.data[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, dryRun: false, goodPrice: 300 };
  f.chrome.emit(f.chrome.data[SETTINGS_KEY]);
  assert.equal(f.isOn(), false);
  assert.equal(f.el('portee-toutes').checked, false);
  assert.deepEqual(f.confirmations(), []);
  assert.equal(f.el('nom').value, 'Brouillon');
  assert.equal(f.el('bon-prix').value, '300');
  await f.submit();
  assert.equal(f.saved().dryRun, false);
});

test('un échec d’écriture est affiché et le choix revient à la valeur enregistrée', async () => {
  const f = await fixture({ ...DEFAULT_SETTINGS, dryRun: true });
  f.chrome.flags.failSet = true;
  await f.toggleMode();
  await f.confirm();
  assert.equal(f.isOn(), true);
  assert.match(f.el('erreur').textContent, /écriture impossible/);
  assert.equal(f.el('enregistrer').disabled, false);
});

test('si la lecture échoue, aucun réglage ne peut écraser ceux enregistrés', async () => {
  const f = await fixture(undefined, { failGet: true });
  assert.match(f.el('erreur').textContent, /lecture impossible/);
  for (const id of ['simulation', 'portee-toutes', 'portee-contactees', 'enregistrer']) {
    assert.equal(f.el(id).disabled, true);
  }
  assert.match(f.el('mode-texte').textContent, /Mode inconnu/);
  await f.toggleMode();
  await f.submit();
  assert.equal(f.chrome.writes.length, 0);
  assert.equal(f.root.querySelector('#alerte-mode').hidden, false);
});

test('l’en-tête signale le mode test et suit les changements locaux', async () => {
  const f = await monter();
  const badge = f.el('badge-mode');
  assert.equal(badge.hidden, true);
  f.chrome.emit({ ...DEFAULT_SETTINGS, dryRun: true });
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, 'Mode test : rien ne part');
  f.chrome.emit(DEFAULT_SETTINGS, 'sync');
  assert.equal(badge.hidden, false);
  // Réglages effacés : plus rien d'enregistré.
  f.chrome.emit(undefined);
  assert.equal(badge.hidden, true);
  f.chrome.emit({ dryRun: 'false' });
  assert.equal(badge.hidden, false);
  await badge.fire('click');
  assert.equal(f.el('ecran-reglages').hidden, false);
});

test('une lecture plus ancienne n’écrase pas un changement, et un mode illisible est signalé', async () => {
  const modes = [];
  const chrome = chromeTest();
  const montage = suivreMode(chrome, (mode) => modes.push(mode));
  chrome.emit({ ...DEFAULT_SETTINGS, dryRun: true });
  await montage;
  assert.deepEqual(modes, ['simulation']);
  const inconnus = [];
  await suivreMode(chromeTest({ failGet: true }), (mode) => inconnus.push(mode));
  assert.deepEqual(inconnus, ['inconnu']);
  const f = await monter({ failGet: true });
  assert.match(f.el('alerte-mode').textContent, /mode inconnu.*rien ne doit être envoyé/i);
  assert.equal(f.el('alerte-mode').hidden, false);
});

test('la navigation du bas a trois sections, dont Réglages', async () => {
  const f = await monter();
  for (const [id, libelle] of [['nav-accueil', 'Accueil'], ['nav-annonces', 'Annonces'], ['nav-reglages', 'Réglages']]) {
    assert.equal(f.el(id).textContent, libelle);
  }
  assert.equal(f.el('nav-accueil').getAttribute('aria-current'), 'page');
  assert.equal(f.el('ecran-reglages').hidden, true);
  assert.equal(f.el('retour').hidden, true);
  await f.click('nav-annonces');
  assert.equal(f.sent('contact-shortlist').length, 2);
  await f.click('voir-criteres');
  assert.equal(f.el('titre').textContent, 'Ma recherche');
  assert.equal(f.el('nav-annonces').getAttribute('aria-current'), 'page');
  await f.click('retour');
  await f.click('autre-annonce');
  assert.equal(f.el('titre').textContent, 'Premier message');
});

test('serveur injoignable : la bonne commande est affichée, sans commande obsolète', async () => {
  for (const reply of [{ ok: false }, { lastError: 'x' }]) {
    const f = await monter({ replies: { 'ping-serveur': reply } });
    const alerte = f.el('alerte-serveur');
    assert.equal(alerte.hidden, false);
    assert.match(alerte.textContent, /Serveur local injoignable.*npm run dev/);
    assert.match(f.el('etat-serveur').textContent, /injoignable.*`npm run dev`/);
    assert.doesNotMatch(f.root.textContent, /supabase start|npm run serve/);
  }
  const ok = await monter();
  assert.equal(ok.el('alerte-serveur').hidden, true);
  assert.equal(ok.el('etat-serveur').textContent, 'Serveur local connecté.');
});

const ENVOIS = (maintenant) => [
  { kind: 'reponse', simulated: false, vendeur: '<img>', debut: 'je peux faire 340', url: 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101', date: maintenant - 1000 },
  { kind: 'premier_contact', simulated: false, vendeur: 'Alice', debut: 'Bonjour', url: 'javascript:alert(1)', date: maintenant - 2000 },
  { kind: 'premier_contact', simulated: true, vendeur: null, debut: 'Bonjour', url: null, date: maintenant - 3000 },
  { kind: 'premier_contact', simulated: false, vendeur: 'Hier', debut: 'Bonjour', url: null, date: maintenant - 3 * 86_400_000 },
];
const MAINTENANT = new Date(2026, 10, 26, 12, 0).getTime();

test('aucun envoi enregistré : la liste n’est pas affichée', async () => {
  const f = await monter();
  assert.equal(f.el('envois').hidden, true);
  const panne = await monter({ replies: { 'envois-liste': { ok: false, error: 'x' } } });
  assert.equal(panne.el('envois').hidden, true);
});

test('les derniers envois réels sont montrés comme du texte, les essais marqués, avec le compte du jour', async () => {
  const f = await monter({ now: () => MAINTENANT, replies: { 'envois-liste': { ok: true, envois: ENVOIS(MAINTENANT) } } });
  assert.equal(f.el('envois').hidden, false);
  assert.equal(f.el('envois-titre').textContent, 'Derniers messages envoyés');
  assert.equal(f.el('envois-compte').textContent, '2 aujourd’hui');
  const lignes = f.el('envois-liste').children;
  assert.equal(lignes.length, 3);
  assert.match(lignes[0].textContent, /<img> « je peux faire 340 »/);
  assert.match(lignes[1].textContent, /Alice Premier message/);
  assert.match(lignes[2].textContent, /Vendeur inconnu.*Essai, non envoyé/);
  assert.equal(all(f.el('envois-liste')).filter((n) => n.tagName === 'a').length, 1);
});

test('une diffusion met la liste à jour ; des essais seuls ne sont pas présentés comme envoyés', async () => {
  const f = await monter({ now: () => MAINTENANT });
  f.chrome.live({ type: 'envois-maj', envois: [ENVOIS(MAINTENANT)[2]] });
  assert.equal(f.el('envois-titre').textContent, 'Derniers essais (non envoyés)');
  assert.equal(f.el('envois-compte').textContent, '1 aujourd’hui');
  const pleine = Array.from({ length: 50 }, () => ENVOIS(MAINTENANT)[0]);
  f.chrome.live({ type: 'envois-maj', envois: pleine });
  assert.equal(f.el('envois-compte').textContent, '50+ aujourd’hui');
});

test('le panneau n’interprète aucun HTML et ne charge rien du réseau', () => {
  const dossier = new URL('../extension/panel/', import.meta.url);
  for (const nom of readdirSync(dossier)) {
    const source = readFileSync(new URL(nom, dossier), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, nom);
    assert.doesNotMatch(source, /@import|fonts\.googleapis|<link[^>]+https?:|<script[^>]+https?:/, nom);
    assert.ok(source.split('\n').length <= 600, `${nom} dépasse 600 lignes`);
  }
  const html = readFileSync(new URL('panel.html', dossier), 'utf8');
  assert.match(html, /name="viewport"/);
});

test('les écrans masqués ne sont pas comptés comme visibles', async () => {
  const f = await monter();
  await settle();
  assert.equal(visible(f.root, f.el('url-recherche')), false);
});

test('tant que la confirmation attend, l’interrupteur montre le mode enregistré', async () => {
  const f = await fixture({ ...DEFAULT_SETTINGS, dryRun: true });
  await f.toggleMode();
  assert.equal(f.confirmations().length, 1);
  assert.equal(f.isOn(), true);
  assert.equal(f.el('mode-texte').textContent, 'Les messages sont tapés, jamais envoyés');
  assert.equal(f.chrome.writes.length, 0);
});

test('quitter Réglages abandonne la confirmation en attente', async () => {
  for (const choisir of [(f) => f.toggleMode(), (f) => f.scope('portee-toutes')]) {
    const f = await fixture({ ...DEFAULT_SETTINGS, dryRun: true });
    await choisir(f);
    const confirmer = f.el(`${f.confirmations()[0].id.replace('reglages-', '')}-confirmer`);
    await f.click('nav-accueil');
    await f.click('nav-reglages');
    assert.deepEqual(f.confirmations(), []);
    assert.equal(f.el('simulation').disabled, false);
    assert.equal(f.el('portee-toutes').checked, false);
    await confirmer.fire('click');
    assert.equal(f.chrome.writes.length, 0);
  }
});

test('mode illisible ou en cours de lecture : aucun interrupteur ne prétend être désactivé', async () => {
  const illisible = await fixture(undefined, { failGet: true });
  assert.equal(visible(illisible.root, illisible.el('simulation')), false);
  assert.match(illisible.el('mode-texte').textContent, /Mode inconnu/);
  const lecture = await monter({ wait: false });
  // Avant tout await : la lecture n'est pas encore revenue.
  assert.equal(lecture.el('reglages-simulation').hidden, true);
  assert.match(lecture.el('reglages-mode-texte').textContent, /Lecture des réglages/);
  await lecture.click('nav-reglages');
  await lecture.panneau.pret;
  assert.equal(visible(lecture.root, lecture.el('reglages-simulation')), true);
});

test('un extrait de réponse ne finit par « … » que s’il a été coupé', async () => {
  const [reponse] = ENVOIS(MAINTENANT);
  const f = await monter({ now: () => MAINTENANT, replies: { 'envois-liste': { ok: true, envois: [
    { ...reponse, debut: 'Message entier', tronque: false }, { ...reponse, debut: 'Message coupé', tronque: true },
  ] } } });
  const [entier, coupe] = f.el('envois-liste').children.map((ligne) => ligne.textContent);
  assert.match(entier, /« Message entier »/);
  assert.match(coupe, /« Message coupé… »/);
});
