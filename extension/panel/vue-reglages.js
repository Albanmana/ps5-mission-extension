import { SETTINGS_KEY, loadSettings, normalizeSettings, saveSettings } from '../lib/settings.js';
import { allume, cocher } from './dom.js';

// settings.js remplace en silence une valeur douteuse par le défaut : l'écran
// doit donc la refuser avant, avec les mêmes limites.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRIX_MIN = 100;
const PRIX_MAX = 2000;
const NOM_MAX = 80;

const AVERTISSEMENTS = {
  dryRun: ['Les messages seront vraiment envoyés depuis votre compte leboncoin.', 'Activer'],
  replyScope: ['Le robot répondra en tant qu’acheteur de PS5 à toutes les conversations de votre compte, même sans rapport avec la PS5 (ventes, autres achats, échanges personnels).', 'Confirmer'],
};

function suivreReglages(chrome, rappel) {
  chrome.storage.onChanged.addListener((changements, zone) => {
    if (zone !== 'local' || !changements[SETTINGS_KEY]) return;
    rappel(normalizeSettings(changements[SETTINGS_KEY].newValue));
  });
}

// Rappelle avec « simulation », « reel » ou « inconnu » (réglages illisibles).
export async function suivreMode(chrome, rappel) {
  let modifie = false;
  const mode = (reglages) => (reglages.dryRun ? 'simulation' : 'reel');
  suivreReglages(chrome, (reglages) => { modifie = true; rappel(mode(reglages)); });
  try {
    const reglages = await loadSettings(chrome);
    // Un changement reçu pendant la lecture est plus récent qu'elle.
    if (!modifie) rappel(mode(reglages));
  } catch {
    if (!modifie) rappel('inconnu');
  }
}

class Refus extends Error {
  constructor(message, champ) { super(message); this.champ = champ; }
}

function validerChamps({ nom, email, bonPrix, prixMax }) {
  const ownerName = nom.trim();
  const handoffEmail = email.trim();
  if (ownerName.length > NOM_MAX) throw new Refus(`Votre nom dépasse ${NOM_MAX} caractères.`, 'ownerName');
  if (handoffEmail && !EMAIL.test(handoffEmail)) {
    throw new Refus('Adresse e-mail invalide (laissez le champ vide pour ne pas recevoir d’e-mail).', 'handoffEmail');
  }
  const lirePrix = (texte, libelle, champ) => {
    const valeur = /^\d+$/.test(texte.trim()) ? Number(texte) : NaN;
    if (!(valeur >= PRIX_MIN && valeur <= PRIX_MAX)) {
      throw new Refus(`${libelle} : saisissez un nombre entier entre ${PRIX_MIN} et ${PRIX_MAX} €.`, champ);
    }
    return valeur;
  };
  const goodPrice = lirePrix(bonPrix, 'Bon prix', 'goodPrice');
  const maxPrice = lirePrix(prixMax, 'Prix maximum', 'maxPrice');
  if (goodPrice > maxPrice) throw new Refus('Le bon prix ne peut pas dépasser le prix maximum.', 'goodPrice');
  return { ownerName, handoffEmail, goodPrice, maxPrice };
}

export function monterReglages(ecran, { chrome, dom }) {
  const { el, bouton, interrupteur } = dom;
  const champ = (id, libelle, type, props = {}, classe = 'champ') => {
    const saisie = el('input', { id: `reglages-${id}`, type, ...props });
    return { saisie, label: el('label', { classe }, el('span', { texte: libelle }), saisie) };
  };
  const radio = (id, libelle, complement) => {
    const saisie = el('input', { id: `reglages-${id}`, type: 'radio', name: 'reglages-portee' });
    return { saisie, label: el('label', { classe: 'choix' }, saisie,
      el('span', {}, el('span', { texte: libelle }), complement && el('span', { classe: 'discret', texte: complement }))) };
  };
  const boiteConfirmation = (id) => {
    const texte = el('strong');
    const confirmer = bouton('Confirmer', { id: `reglages-${id}-confirmer`, classe: 'bouton-danger' }, () => accepter());
    const annuler = bouton('Annuler', { id: `reglages-${id}-annuler`, classe: 'bouton-blanc' }, () => { enAttente = null; rendre(); });
    const boite = el('div', { id: `reglages-${id}`, classe: 'confirmation', role: 'alert', hidden: true },
      texte, el('div', { classe: 'rangee' }, confirmer, annuler));
    return { boite, texte, confirmer };
  };

  const simulation = interrupteur('reglages-simulation', 'Mode test', () => {
    if (simulation.disabled) return undefined;
    const dryRun = !allume(simulation);
    return demander({ dryRun }, !dryRun);
  });
  const modeTexte = el('div', { id: 'reglages-mode-texte', classe: 'discret' });
  const confirmationMode = boiteConfirmation('confirmation-mode');
  const contactees = radio('portee-contactees', 'Seulement les annonces contactées par l’outil', ' (recommandé)');
  const toutes = radio('portee-toutes', 'Toutes les conversations');
  const confirmationPortee = boiteConfirmation('confirmation-portee');

  const bonPrix = champ('bon-prix', 'Bon prix (€)', 'number', { inputMode: 'numeric' }, 'champ fort champ-prix');
  const prixMax = champ('prix-max', 'Maximum (€)', 'number', { inputMode: 'numeric' }, 'champ fort champ-prix');
  const nom = champ('nom', 'Votre nom', 'text', { placeholder: 'Prénom', autocomplete: 'off' });
  const email = champ('email', 'E-mail de reprise (facultatif)', 'email', { placeholder: 'vous@exemple.fr', autocomplete: 'off' });
  const explication = el('p', { id: 'reglages-explication-prix', classe: 'discret' });
  const identite = el('details', { classe: 'carte' },
    el('summary', { texte: 'Nom et e-mail d’alerte' }),
    nom.label, email.label,
    el('p', { classe: 'discret', texte: 'Votre nom sert aux notes de négociation et aux e-mails. L’e-mail demande RESEND_API_KEY dans le fichier .env du serveur. Les reprises sont toujours affichées sur l’Accueil.' }));
  const enregistrer = bouton('Enregistrer', { id: 'reglages-enregistrer', type: 'submit', classe: 'bouton-principal', hidden: true });
  const erreur = el('p', { id: 'reglages-erreur', classe: 'texte-erreur', role: 'alert' });
  const statut = el('p', { id: 'reglages-statut', classe: 'discret', role: 'status' });
  const formulaire = el('form', { id: 'reglages-formulaire', classe: 'pile', noValidate: true },
    el('section', { classe: 'carte', 'aria-label': 'Prix' },
      el('div', { classe: 'grille-2' }, bonPrix.label, prixMax.label),
      explication,
      el('details', { classe: 'aide' },
        el('summary', { texte: 'À quoi servent ces prix ?' }),
        el('p', { texte: 'Une annonce au bon prix ou moins est un « Saint Graal ». C’est le plafond normal de négociation ; la première offre est 10 € en dessous.' }),
        el('p', { texte: 'Jusqu’au prix maximum, une annonce est « intéressante ». En négociation, il n’est proposé qu’en dernière offre, après une offre au bon prix, si le vendeur demande 10 à 50 € de plus que ce maximum.' }))),
    identite, erreur, enregistrer);

  ecran.replaceChildren(
    el('section', { classe: 'carte', 'aria-label': 'Mode test' },
      el('div', { classe: 'ligne-reglage' },
        el('div', { classe: 'ligne-reglage-texte' }, el('div', { classe: 'fort', texte: 'Mode test' }), modeTexte),
        simulation),
      confirmationMode.boite,
      el('details', { classe: 'aide' },
        el('summary', { texte: 'Que fait le mode test ?' }),
        el('p', { texte: 'Désactivé par défaut : les messages partent réellement depuis votre compte leboncoin. Activé, ils sont tapés dans leboncoin mais jamais envoyés, et aucun e-mail de reprise n’est envoyé non plus.' }))),
    formulaire,
    el('details', { classe: 'carte' },
      el('summary', { texte: 'Avancé : qui reçoit des réponses' }),
      el('fieldset', {}, el('legend', { classe: 'masque', texte: 'Qui reçoit des réponses automatiques' }),
        contactees.label, toutes.label, confirmationPortee.boite)),
    statut,
    el('p', { classe: 'discret centre', texte: 'Le mode et la portée s’appliquent tout de suite. Les autres champs avec « Enregistrer ».' }),
    el('p', { id: 'etat-serveur', classe: 'discret centre' }));

  const champs = [
    [nom.saisie, 'ownerName'], [email.saisie, 'handoffEmail'],
    [bonPrix.saisie, 'goodPrice'], [prixMax.saisie, 'maxPrice'],
  ];
  const brouillons = new Set();
  let enregistres = null;
  let enAttente = null;
  let enCours = false;
  let illisible = false;

  const confirmationDe = () => (enAttente && 'dryRun' in enAttente ? confirmationMode : confirmationPortee);

  function marquerInvalide(cle) {
    for (const [saisie, nomChamp] of champs) saisie.setAttribute('aria-invalid', nomChamp === cle ? 'true' : 'false');
  }

  function rendreModifie() {
    enregistrer.hidden = !champs.some(([saisie, cle]) => brouillons.has(saisie)
      && saisie.value !== String(enregistres?.[cle] ?? ''));
  }

  function rendre() {
    const affiches = { ...enregistres, ...enAttente };
    // Le mode montre l'enregistré, jamais un choix à confirmer ; tant qu'il
    // est inconnu, pas d'interrupteur qui paraîtrait désactivé.
    simulation.hidden = !enregistres;
    cocher(simulation, enregistres?.dryRun === true);
    modeTexte.textContent = !enregistres
      ? (illisible ? 'Mode inconnu (réglages illisibles)' : 'Lecture des réglages…')
      : enregistres.dryRun ? 'Les messages sont tapés, jamais envoyés' : 'Désactivé : les messages partent';
    toutes.saisie.checked = affiches.replyScope === 'all';
    contactees.saisie.checked = !toutes.saisie.checked;
    for (const confirmation of [confirmationMode, confirmationPortee]) {
      const visible = Boolean(enAttente) && confirmation === confirmationDe();
      confirmation.boite.hidden = !visible;
      const [texte, libelle] = visible ? AVERTISSEMENTS[Object.keys(enAttente)[0]] : ['', 'Confirmer'];
      confirmation.texte.textContent = texte;
      confirmation.confirmer.textContent = libelle;
      confirmation.confirmer.disabled = !enregistres || enCours;
    }
    const bloque = !enregistres || enCours;
    for (const node of [simulation, contactees.saisie, toutes.saisie]) node.disabled = bloque || Boolean(enAttente);
    enregistrer.disabled = bloque;
    explication.textContent = enregistres
      ? `Première offre à ${enregistres.goodPrice - 10} €. ${enregistres.maxPrice} € seulement en dernière offre.` : '';
    rendreModifie();
  }

  function remplirChamps() {
    for (const [saisie, cle] of champs) {
      if (!brouillons.has(saisie)) saisie.value = String(enregistres[cle]);
    }
  }

  // Relit avant d'écrire : seules les clés demandées changent.
  async function appliquer(modifications, apres) {
    if (enCours || !enregistres) return;
    enCours = true;
    erreur.textContent = '';
    statut.textContent = '';
    rendre();
    try {
      enregistres = await saveSettings(chrome, { ...await loadSettings(chrome), ...modifications });
      apres?.();
      remplirChamps();
      statut.textContent = 'Réglages enregistrés.';
    } catch (error) {
      erreur.textContent = `Réglages non enregistrés : ${error.message}`;
    } finally {
      enCours = false;
      rendre();
    }
  }

  // Un choix risqué (dont le retour à l'envoi réel) attend une confirmation ;
  // activer le mode test ou restreindre la portée est direct.
  function demander(modification, risque) {
    erreur.textContent = '';
    statut.textContent = '';
    if (!risque) return appliquer(modification);
    enAttente = modification;
    rendre();
    return undefined;
  }

  function accepter() {
    if (!enAttente) return undefined;
    const modification = enAttente;
    enAttente = null;
    return appliquer(modification);
  }

  for (const { saisie } of [contactees, toutes]) {
    saisie.addEventListener('change', () => {
      const replyScope = saisie === toutes.saisie && toutes.saisie.checked ? 'all' : 'contacted';
      return demander({ replyScope }, replyScope === 'all');
    });
  }

  for (const [saisie] of champs) {
    saisie.addEventListener('input', () => {
      brouillons.add(saisie);
      statut.textContent = '';
      rendreModifie();
    });
  }
  formulaire.addEventListener('submit', (event) => {
    event.preventDefault();
    erreur.textContent = '';
    statut.textContent = '';
    let valeurs;
    try {
      valeurs = validerChamps({
        nom: nom.saisie.value, email: email.saisie.value,
        bonPrix: bonPrix.saisie.value, prixMax: prixMax.saisie.value,
      });
    } catch (error) {
      erreur.textContent = error.message;
      marquerInvalide(error.champ);
      if (error.champ === 'ownerName' || error.champ === 'handoffEmail') identite.open = true;
      return undefined;
    }
    marquerInvalide(null);
    return appliquer(valeurs, () => brouillons.clear());
  });

  suivreReglages(chrome, (reglages) => {
    if (!enregistres) return;
    enregistres = reglages;
    // Nos propres écritures passent aussi par ici.
    if (!enCours) {
      enAttente = null;
      remplirChamps();
    }
    rendre();
  });

  rendre();
  const charger = async () => {
    try {
      enregistres = await loadSettings(chrome);
      remplirChamps();
    } catch (error) {
      illisible = true;
      erreur.textContent = `Réglages illisibles : ${error.message}. Rouvrez le panneau.`;
    }
    rendre();
  };
  return {
    pret: charger(),
    abandonnerConfirmation() {
      if (!enAttente) return;
      enAttente = null;
      rendre();
    },
  };
}
