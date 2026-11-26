// Recherche : un seul propriétaire des options (interrupteurs de l'Accueil,
// écran Ma recherche, bouton Lancer). Rien ne part avant que les options
// enregistrées aient été relues.
import { normaliserUrlRecherche, DEFAULT_SEARCH_OPTIONS } from '../sw/search-autopilot-state.js';
import { allume, cocher, commander } from './dom.js';
import { creerVueRun, rendreRun, rendreAvisContact, rendreAutopiloteRecherche } from './vue-run.js';

const CHAMPS = [
  ['max-pages', 'maxPages', 'Pages max', 50],
  ['max-resultats', 'maxResultats', 'Résultats max'],
  ['max-fiches', 'maxFiches', 'Fiches max'],
];

export function monterRecherche({ pilote, contact, run: emplacementRun, criteres }, {
  chrome, dom, surRun = () => {}, surAuto = () => {},
}) {
  const { el, bouton, interrupteur, ligneReglage } = dom;
  let courant = null;
  let hydratees = false;
  // Dernières options confirmées par le service worker.
  let confirmees = null;
  let contactEnEcriture = false;
  let mode = 'lecture';

  const alerte = (id) => el('p', { id, classe: 'texte-erreur', role: 'alert' });
  const erreurs = [alerte('erreur-pilote'), alerte('erreur-run'), alerte('erreur-criteres')];
  const signaler = (texte) => { for (const node of erreurs) node.textContent = texte; };
  const action = async (operation, prefixe = '') => {
    signaler('');
    try { await operation(); } catch (error) { signaler(`${prefixe}${error.message}`); }
  };
  const envoyer = (message) => commander(chrome, message);

  const auto = {
    interrupteur: interrupteur('recherche-auto', 'Chercher des annonces automatiquement', () => basculerAuto()),
    statut: el('div', { id: 'statut-auto-recherche', classe: 'discret', role: 'status' }),
    prochain: el('div', { id: 'prochain-auto-recherche', classe: 'discret', 'aria-live': 'polite' }),
  };
  pilote.replaceChildren(ligneReglage('Chercher des annonces', auto.interrupteur, auto.statut, auto.prochain),
    erreurs[0]);

  const contactAuto = interrupteur('contact-auto', 'Envoyer automatiquement le premier message', () => basculerContact());
  const contactTexte = el('div', { id: 'contact-auto-texte', classe: 'discret', 'aria-live': 'polite' });
  contact.replaceChildren(ligneReglage('Envoyer le premier message', contactAuto, contactTexte));

  const vueRun = creerVueRun(dom, {
    surLancer: () => lancer(),
    surPause: () => action(() => envoyer({ type: courant?.statut === 'pause' ? 'run-reprendre' : 'run-pause' })),
    surStop: () => action(() => envoyer({ type: 'run-arreter' })),
  });
  emplacementRun.replaceChildren(...vueRun.noeuds, erreurs[1]);

  const urls = el('textarea', { id: 'url-recherche', rows: 4, spellcheck: false });
  urls.value = DEFAULT_SEARCH_OPTIONS.urlsRecherche.join('\n');
  const ongletCourant = bouton('Ajouter la page ouverte', { id: 'onglet-courant', classe: 'bouton-doux' },
    () => ajouterOnglet());
  const limites = CHAMPS.map(([id, cle, libelle, max]) => {
    const saisie = el('input', { id, type: 'number', min: '1', step: '1', max: max && String(max), inputMode: 'numeric' });
    saisie.value = String(DEFAULT_SEARCH_OPTIONS[cle]);
    return { saisie, label: el('label', { classe: 'champ' }, el('span', { texte: libelle }), saisie) };
  });
  const force = el('input', { id: 'force', type: 'checkbox' });
  force.checked = false;
  criteres.replaceChildren(
    el('section', { classe: 'carte', 'aria-label': 'Adresses' },
      el('label', { classe: 'champ fort' }, el('span', { texte: 'Recherches leboncoin, une par ligne' }), urls),
      ongletCourant),
    el('details', { classe: 'carte' },
      el('summary', { texte: 'Réglages avancés' }),
      el('div', { classe: 'grille-3' }, ...limites.map(({ label }) => label)),
      el('p', { classe: 'discret', texte: 'Chaque fiche coûte 10 à 20 s ; les mieux classées passent d’abord.' }),
      el('label', { classe: 'choix' }, force, el('span', { texte: 'Réanalyser les annonces déjà en base' }))),
    erreurs[2],
    el('p', { classe: 'discret centre', texte: 'Chaque modification valide est enregistrée tout de suite.' }));

  const champ = (id) => limites.find(({ saisie }) => saisie.id === id).saisie;
  const optionsVisibles = () => ({
    urlsRecherche: urls.value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean),
    ...Object.fromEntries(CHAMPS.map(([id, cle]) => [cle, Number(champ(id).value)])),
    force: force.checked,
    contactAuto: allume(contactAuto),
  });

  function appliquerOptions(options) {
    const limitesValides = CHAMPS.every(([, cle]) => Number.isInteger(options?.[cle]) && options[cle] > 0);
    const urlsRecherche = options?.urlsRecherche ?? (options?.urlRecherche ? [options.urlRecherche] : null);
    if (!Array.isArray(urlsRecherche) || urlsRecherche.length < 1
      || urlsRecherche.some((url) => typeof url !== 'string' || !url.trim())
      || !limitesValides || typeof options.force !== 'boolean'
      || typeof options.contactAuto !== 'boolean') {
      throw new Error('Options de recherche persistées invalides.');
    }
    urls.value = urlsRecherche.join('\n');
    for (const [id, cle] of CHAMPS) champ(id).value = String(options[cle]);
    force.checked = options.force === true;
    cocher(contactAuto, options.contactAuto === true);
    confirmees = { ...options, urlsRecherche };
  }

  function decrireContact() {
    const voulu = allume(contactAuto);
    let texte = voulu ? 'Aux Saint Graal et Intéressantes' : 'Désactivé';
    // Couper l'interrupteur ne touche pas une recherche déjà partie.
    if (!voulu && courant?.contactAuto === true && ['en_cours', 'pause'].includes(courant.statut)) {
      texte = 'Désactivé pour la suite. La recherche en cours peut encore envoyer : arrêtez-la avec Stop (onglet Annonces).';
    }
    contactTexte.textContent = texte;
    rendreAvisContact(vueRun, { voulu, run: courant, mode });
  }

  function verrouiller() {
    for (const node of [vueRun.lancer, ongletCourant, urls, force, contactAuto, auto.interrupteur,
      ...limites.map(({ saisie }) => saisie)]) {
      node.disabled = !hydratees;
    }
    if (hydratees) {
      vueRun.lancer.disabled = vueRun.lancer.hidden;
      contactAuto.disabled = contactEnEcriture;
    }
  }

  function majRun(etat) {
    courant = etat;
    rendreRun(vueRun, etat);
    if (!hydratees) vueRun.lancer.disabled = true;
    else vueRun.lancer.disabled = vueRun.lancer.hidden;
    decrireContact();
    surRun(etat);
  }

  function majAuto(etat) {
    rendreAutopiloteRecherche(auto, etat);
    // Les brouillons du formulaire restent ; seul l'interrupteur de contact suit
    // l'option enregistrée, pour ne jamais annoncer le contraire de la réalité.
    if (hydratees && etat?.options) {
      confirmees = { ...confirmees, ...etat.options };
      if (!contactEnEcriture) cocher(contactAuto, etat.options.contactAuto === true);
      decrireContact();
    }
    surAuto(etat && { ...etat, options: etat.options ?? confirmees });
  }

  function retenir(reponse) {
    majAuto(reponse.etat);
  }

  const configurer = (options) => action(async () => {
    retenir(await envoyer({ type: 'recherche-auto-configurer', options }));
  }, 'Non enregistré : ');

  async function basculerContact() {
    if (!hydratees || contactEnEcriture) return;
    const voulu = !allume(contactAuto);
    contactEnEcriture = true;
    cocher(contactAuto, voulu);
    decrireContact();
    verrouiller();
    // Sur la base des options confirmées : un critère invalide en cours de
    // saisie ne doit pas empêcher de couper l'envoi automatique.
    signaler('');
    try {
      const reponse = await envoyer({
        type: 'recherche-auto-configurer', options: { ...confirmees, contactAuto: voulu },
      });
      confirmees = { ...confirmees, contactAuto: voulu };
      contactEnEcriture = false;
      retenir(reponse);
    } catch (error) {
      cocher(contactAuto, confirmees.contactAuto === true);
      signaler(`Non enregistré : ${error.message}`);
    } finally {
      contactEnEcriture = false;
      decrireContact();
      verrouiller();
    }
  }

  const basculerAuto = () => action(async () => {
    if (!hydratees) return;
    retenir(await envoyer({
      type: 'recherche-auto-activer', enabled: !allume(auto.interrupteur), options: optionsVisibles(),
    }));
  });

  const lancer = () => {
    if (!hydratees || vueRun.lancer.hidden) return undefined;
    return action(async () => {
      const reponse = await envoyer({ type: 'run-demarrer', options: optionsVisibles() });
      majRun(reponse.etat);
    });
  };

  const ajouterOnglet = () => action(async () => {
    if (!hydratees) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const nouvelle = normaliserUrlRecherche(tab.url);
    const courantes = optionsVisibles().urlsRecherche;
    if (!courantes.some((url) => normaliserUrlRecherche(url) === nouvelle)) {
      urls.value = [...courantes, nouvelle].join('\n');
    }
    await configurer(optionsVisibles());
  });

  for (const node of [urls, force, ...limites.map(({ saisie }) => saisie)]) {
    node.addEventListener('change', () => (hydratees ? configurer(optionsVisibles()) : undefined));
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'run-maj') majRun(message.etat);
    if (message?.type === 'recherche-auto-maj') majAuto(message.etat);
  });

  cocher(contactAuto, false);
  majRun(null);
  rendreAutopiloteRecherche(auto, null);
  verrouiller();
  const pret = Promise.all([
    action(async () => majRun((await envoyer({ type: 'run-etat' })).etat)),
    action(async () => {
      let etat;
      try {
        etat = (await envoyer({ type: 'recherche-auto-etat' })).etat;
        appliquerOptions(etat?.options);
      } catch (error) {
        throw new Error(`Impossible de charger les options persistées. Rechargez le panneau. ${error.message}`);
      }
      hydratees = true;
      majAuto(etat);
      verrouiller();
      majRun(courant);
    }),
  ]);
  return {
    pret,
    majMode(nouveau) { mode = nouveau; decrireContact(); },
  };
}
