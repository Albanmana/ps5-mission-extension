// Premier message : une seule cible, figée pendant l'envoi. Un brouillon retouché
// n'est jamais écrasé par un rechargement, et un résultat définitif ou
// incertain interdit tout nouvel envoi vers la même annonce ou le même vendeur.
import { resoudreTemplate, TEMPLATES_PAR_DEFAUT, VARIABLES } from '../lib/templates.js';
import { urlContactValide } from '../sw/run-contact.js';
import { urlAnnonceValide } from '../sw/run-state.js';
import { envoyer } from './dom.js';
import { cleUrl, creerMemoire } from './contact-memoire.js';
import { MODE_INCONNU } from './coquille.js';
import { CLASSIFICATIONS } from './vue-annonces.js';

const CLE_TEMPLATES = 'templates_contact';
const ACTIONS = {
  reel: ['Envoyer le message', 'Le message partira depuis votre compte.'],
  simulation: ['Essayer sans envoyer', 'Le message sera tapé dans leboncoin, sans être envoyé.'],
  lecture: ['Envoyer le message', 'Lecture du mode d’envoi…'],
  inconnu: ['Envoyer le message', MODE_INCONNU],
};

export function monterContact(ecran, {
  chrome, dom, surShortlist = () => {}, surOuverture = () => {}, surEnvoye = () => {}, toast = () => {},
}) {
  const { el, bouton, lien } = dom;
  const memoire = creerMemoire();

  const urlManuelle = el('input', {
    id: 'url-manuelle', type: 'url', placeholder: 'https://www.leboncoin.fr/ad/consoles/…', autocomplete: 'off',
  });
  const ongletCourant = bouton('Utiliser l’onglet courant', { id: 'contact-onglet-courant', classe: 'bouton-doux' },
    () => lireOnglet());
  const blocAutre = el('div', { id: 'bloc-autre', classe: 'pile' },
    el('label', { classe: 'champ fort' }, el('span', { texte: 'Adresse de l’annonce' }), urlManuelle),
    ongletCourant);
  const fiche = el('section', { id: 'fiche-annonce', classe: 'fiche', 'aria-label': 'Annonce' });
  const champMessage = el('textarea', { id: 'message', rows: 5 });
  const puces = el('div', { id: 'modeles', classe: 'puces', role: 'group', 'aria-label': 'Modèle de message' });
  const templatesEtat = el('p', { id: 'templates-etat', classe: 'discret', 'aria-live': 'polite' });
  const manquantesEl = el('p', { id: 'manquantes', classe: 'texte-alerte', 'aria-live': 'polite' });
  const preparer = bouton('', { id: 'preparer', classe: 'bouton-principal' }, () => envoyerMessage());
  const aide = el('p', { id: 'aide-envoi', classe: 'discret centre' });
  const retourEl = el('p', { id: 'retour-envoi', classe: 'encart', 'aria-live': 'polite' });
  ecran.replaceChildren(blocAutre, fiche,
    el('section', { classe: 'carte', 'aria-label': 'Message' },
      el('label', { classe: 'champ fort' }, el('span', { texte: 'Votre message (envoyé tel quel)' }), champMessage),
      puces, templatesEtat, manquantesEl,
      el('details', { classe: 'aide' },
        el('summary', { texte: 'Variables' }),
        el('p', {},
          ...VARIABLES.map((variable) => el('code', { texte: `{{${variable}}} ` })),
          el('span', { texte: 'Une valeur manquante est signalée sous le message.' })))),
    el('div', { classe: 'zone-envoi' }, retourEl, preparer, aide));

  let shortlist = [], rapprochables = [], templates = TEMPLATES_PAR_DEFAUT, modele = templates[0].id;
  // Cible : une annonce choisie dans une liste, ou une adresse saisie (« autre »).
  let choisie = null, autre = true, resultatsRun = [];
  let enCours = false, chargement = false, chargee = false, messageModifie = false;
  let etatShortlist = '', mode = 'lecture', visible = false;

  const connues = () => [...shortlist, ...resultatsRun];
  function annonceCourante() {
    if (autre) {
      const manuelle = urlManuelle.value.trim();
      if (!manuelle) return null;
      return connues().find((a) => cleUrl(a.url_annonce) === cleUrl(manuelle)) ?? { url_annonce: manuelle };
    }
    // La ligne la plus fraîche de la même annonce, sinon celle qui a été choisie.
    return rapprochables.find((a) => cleUrl(a.url_annonce) === cleUrl(choisie.url_annonce)) ?? choisie;
  }

  function dire(texte, ton = '') {
    retourEl.textContent = texte;
    retourEl.className = `encart ${ton && `encart-${ton}`}`.trim();
  }
  // Le résultat mémorisé de la cible, sinon rien.
  const rappeler = () => dire(memoire.preparation(annonceCourante())?.message ?? '', 'attention');

  function publier() {
    surShortlist({ annonces: shortlist, charge: chargee, etat: etatShortlist, occupe: enCours || chargement });
  }

  function rendreFiche() {
    const annonce = annonceCourante();
    const connue = annonce && (!autre || connues().includes(annonce));
    fiche.hidden = !connue;
    if (!connue) { fiche.replaceChildren(); return; }
    const libelle = CLASSIFICATIONS[annonce.classification]?.[0] ?? annonce.classification;
    fiche.replaceChildren(
      el('div', { classe: 'fiche-tete' },
        el('strong', { texte: annonce.titre || 'Annonce' }),
        el('span', { classe: 'prix prix-grand', texte: annonce.prix_eur != null ? `${annonce.prix_eur} €` : '' })),
      el('div', { classe: 'discret', texte: [annonce.vendeur || 'Vendeur inconnu', annonce.ville, libelle].filter(Boolean).join(' · ') }),
      lien(annonce.url_annonce, urlAnnonceValide(annonce.url_annonce) || urlContactValide(annonce.url_annonce)
        ? 'Voir sur leboncoin' : annonce.url_annonce,
      urlAnnonceValide(annonce.url_annonce) || urlContactValide(annonce.url_annonce), { classe: 'lien-fiche' }));
  }

  function controles() {
    const annonce = annonceCourante();
    const modeConnu = mode === 'reel' || mode === 'simulation';
    preparer.disabled = enCours || chargement || !modeConnu || !urlContactValide(annonce?.url_annonce)
      || !champMessage.value.trim() || Boolean(memoire.preparation(annonce));
    const [libelle, texte] = ACTIONS[mode];
    preparer.textContent = enCours ? 'Envoi en cours…' : libelle;
    preparer.className = `bouton-principal${mode === 'simulation' ? ' bouton-essai' : ''}`;
    aide.textContent = texte;
    for (const node of [urlManuelle, ongletCourant, champMessage, ...puces.children]) node.disabled = enCours;
  }

  function rafraichirMessage(force = false) {
    if (force) messageModifie = false;
    if (!messageModifie) {
      const template = templates.find((t) => t.id === modele);
      const { texte, manquantes } = resoudreTemplate(template?.texte ?? '', annonceCourante() ?? {});
      champMessage.value = texte;
      manquantesEl.textContent = manquantes.length
        ? `Variables sans valeur en base : ${manquantes.join(', ')} — relisez le message avant de l’envoyer.` : '';
    }
    rendreFiche();
    controles();
  }

  function rendreModeles() {
    puces.replaceChildren(...templates.map((template) => bouton(template.nom, {
      classe: 'puce', 'aria-pressed': template.id === modele ? 'true' : 'false',
    }, () => {
      if (enCours || template.id === modele) return;
      modele = template.id;
      rendreModeles();
      rafraichirMessage(true);
    })));
  }

  // Un changement de cible repart du modèle ; revenir sur la même garde tout.
  function viser(nouvelle) {
    if (enCours) {
      surOuverture();
      toast('Envoi en cours : attendez son résultat avant de changer d’annonce.');
      return;
    }
    const avant = annonceCourante()?.url_annonce ?? '';
    const memeCible = nouvelle ? cleUrl(nouvelle.url_annonce) === cleUrl(avant) && !autre : autre;
    if (memeCible) {
      choisie = nouvelle ?? choisie;
      rafraichirMessage();
    } else {
      autre = !nouvelle;
      choisie = nouvelle;
      urlManuelle.value = '';
      blocAutre.hidden = !autre;
      rafraichirMessage(true);
      rappeler();
    }
    surOuverture();
  }

  function changerCible() {
    if (enCours) return;
    rafraichirMessage(true);
    rappeler();
  }

  async function chargerShortlist() {
    if (chargement) return;
    chargement = true; etatShortlist = 'Chargement…'; controles(); publier();
    try {
      const reponse = await envoyer(chrome, { type: 'contact-shortlist' });
      if (!reponse.ok || !Array.isArray(reponse.annonces)) throw new Error(reponse.error || 'Shortlist invalide.');
      rapprochables = reponse.annonces.filter((a) => urlContactValide(a?.url_annonce));
      shortlist = rapprochables.filter((a) => !memoire.preparation(a)?.masquer);
      chargee = true;
      etatShortlist = `${shortlist.length} vendeurs à contacter.`;
    } catch (error) {
      etatShortlist = error.message;
    } finally {
      chargement = false;
      rafraichirMessage();
      publier();
    }
  }

  async function lireOnglet() {
    if (enCours) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (enCours || !autre) return;
      if (!urlContactValide(tab?.url)) throw new Error('L’onglet courant n’est pas une annonce leboncoin HTTPS.');
      urlManuelle.value = tab.url;
      changerCible();
    } catch (error) { dire(error.message, 'erreur'); }
  }

  async function envoyerMessage() {
    if (enCours || chargement || !(mode === 'reel' || mode === 'simulation')) return;
    const annonce = annonceCourante();
    const existante = memoire.preparation(annonce);
    if (existante) { dire(existante.message, 'attention'); return; }
    if (!urlContactValide(annonce?.url_annonce)) { dire('Choisissez une URL d’annonce leboncoin HTTPS valide.', 'erreur'); return; }
    if (!champMessage.value.trim()) { dire('Écrivez un message avant de l’envoyer.', 'erreur'); return; }
    enCours = true; controles(); publier();
    dire('Ouverture de la page de réponse et envoi en cours…');
    const nom = [annonce.vendeur, annonce.titre].find((v) => typeof v === 'string' && v.trim()) ?? annonce.url_annonce;
    // Un échec arrivé après avoir quitté la fiche ne doit pas rester muet.
    const signalerEchec = (texte, ton) => {
      dire(texte, ton);
      if (!visible) toast(`${nom} : ${texte}`);
    };
    const memoriser = (texte, masquer = false) => {
      memoire.memoriser(annonce, texte, masquer);
      if (masquer) shortlist = shortlist.filter((a) => !memoire.preparation(a)?.masquer);
    };
    const retenirEchec = (texte, ton, masquer) => {
      signalerEchec(texte, ton);
      memoriser(texte, masquer);
    };
    try {
      const reponse = await envoyer(chrome, {
        type: 'contact-envoyer', urlAnnonce: annonce.url_annonce, texte: champMessage.value,
        // Seulement pour le journal des envois récents.
        ...(typeof annonce.vendeur === 'string' && annonce.vendeur.trim() ? { vendeur: annonce.vendeur } : {}),
      });
      if (reponse.dryRun === true) {
        // Rien n'est mémorisé : un envoi réel reste possible ensuite.
        if (reponse.ok) {
          dire('Simulation (mode test) : le message est saisi dans l’onglet ouvert, rien n’a été envoyé ni enregistré. '
            + 'Si vous cliquez vous-même sur Envoyer dans cet onglet, le suivi ne sera pas enregistré.', 'succes');
          toast('Simulation : message tapé, rien envoyé');
        } else signalerEchec(`Simulation (mode test), rien n’a été envoyé. ${reponse.error ?? ''}`, 'attention');
      } else if (reponse.ok && reponse.envoye === true && reponse.suivi === true) {
        const texte = 'Message envoyé. Le suivi de ce vendeur est enregistré.';
        dire(texte, 'succes');
        memoriser(texte, true);
        enCours = false;
        surEnvoye(visible);
        await chargerShortlist();
      } else if (reponse.envoye === true) {
        retenirEchec(`Message envoyé, mais le suivi a échoué. ${reponse.error ?? ''} Vérifiez l’onglet ouvert et ne renvoyez pas ce message.`, 'attention');
      } else if (reponse.skip === true) {
        retenirEchec(reponse.error || 'Cette annonce ne permet pas l’envoi d’un message.', 'attention', true);
        enCours = false;
        await chargerShortlist();
      } else if (reponse.terminal === true) {
        retenirEchec(reponse.error || 'État terminal du contact ; vérifiez le suivi avant toute nouvelle tentative.', 'attention');
      } else if (reponse.ok === false) {
        signalerEchec(reponse.error || 'Envoi impossible.', 'erreur');
      } else {
        throw new Error('Réponse d’envoi invalide.');
      }
    } catch (error) {
      retenirEchec(`État de l’envoi inconnu : ${error.message} Vérifiez l’onglet ouvert avant toute nouvelle tentative.`, 'attention');
    } finally { enCours = false; controles(); publier(); }
  }

  urlManuelle.addEventListener('input', changerCible);
  champMessage.addEventListener('input', () => { messageModifie = true; controles(); });

  blocAutre.hidden = false;
  rendreModeles();
  dire('');
  rafraichirMessage();

  async function charger() {
    try {
      const stocke = (await chrome.storage.local.get(CLE_TEMPLATES))[CLE_TEMPLATES];
      const valides = Array.isArray(stocke) ? stocke.filter((t) => t && typeof t.id === 'string'
        && typeof t.nom === 'string' && typeof t.texte === 'string') : [];
      if (valides.length) templates = valides;
    } catch (error) { templatesEtat.textContent = `Modèles par défaut utilisés : ${error.message}`; }
    if (!templates.some((t) => t.id === modele)) modele = templates[0].id;
    rendreModeles();
    rafraichirMessage();
    await chargerShortlist();
  }

  return {
    pret: charger(),
    chargerShortlist: () => (enCours ? Promise.resolve() : chargerShortlist()),
    ouvrir: (annonce) => viser(annonce),
    ouvrirAutre: () => viser(null),
    oublier(reservation) {
      memoire.oublier(reservation);
      if (!enCours) rappeler();
      controles();
    },
    majMode(nouveau) { mode = nouveau; controles(); },
    majVisible(oui) { visible = oui; },
    majRun(etat, annoncesDuRun) {
      memoire.majRun(etat);
      resultatsRun = annoncesDuRun;
      // Un blocage venu de la recherche s'explique aussitôt.
      if (!enCours && memoire.preparation(annonceCourante())) rappeler();
      controles();
    },
  };
}
