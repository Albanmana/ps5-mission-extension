import { normalizeSearchOptions, normaliserUrlRecherche } from './search-autopilot-state.js';

export function urlAnnonceValide(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.leboncoin.fr' && /^\/ad\/[^/]+\/\d+\/?$/.test(url.pathname)
      && !url.username && !url.password;
  } catch { return false; }
}

export const FICHES_PAR_DEFAUT = 50;
const LONGUEUR_ERREUR_RECHERCHE_MAX = 500;

// Les runs antérieurs avaient contact auto et réanalyse cochés par défaut.
const VERSION_RUN = 2;

export function creerEtatRun(options = {}) {
  const { urlsRecherche, maxPages, maxResultats, maxFiches, force, contactAuto } = normalizeSearchOptions({
    ...options, maxFiches: options.maxFiches ?? FICHES_PAR_DEFAUT,
  });
  return {
    activationVersion: VERSION_RUN, id: crypto.randomUUID(), urlRecherche: urlsRecherche[0], urlsRecherche, maxPages, maxResultats, maxFiches,
    force, contactAuto, statut: 'en_cours', demarre_le: new Date().toISOString(),
    recherches: urlsRecherche.map((urlRecherche, index) => ({
      urlRecherche, index, page_suivante: 1, extraction_terminee: false,
      annonces_recues: [], details_utilises: 0,
      statut: index === 0 ? 'en_cours' : 'en_attente', erreur: null,
    })),
    recherche_index: 0,
    annonces: {}, page_suivante: 1, extraction_terminee: false, details_utilises: 0,
    onglets: [], erreur: null,
  };
}

export function recoverRunState(source) {
  if (!source) return source;
  const etat = source.activationVersion === VERSION_RUN ? source
    : { ...source, activationVersion: VERSION_RUN, force: false, contactAuto: false };
  if (Array.isArray(etat.recherches)) return etat;
  const urlRecherche = normaliserUrlRecherche(etat.urlRecherche);
  return {
    ...etat,
    urlsRecherche: [urlRecherche],
    recherche_index: 0,
    recherches: [{
      urlRecherche, index: 0, page_suivante: etat.page_suivante ?? 1,
      extraction_terminee: etat.extraction_terminee === true,
      annonces_recues: Object.keys(etat.annonces ?? {}),
      details_utilises: etat.details_utilises ?? 0,
      statut: etat.statut ?? 'en_cours', erreur: etat.erreur ?? null,
    }],
  };
}

// Pause voulue par l’utilisateur : rien ne la relance ni ne la remplace avant
// Reprendre ou Stop, même si un blocage survient ensuite. Un ancien état sans la
// marque est reconnu à l’absence de message (les pauses sur erreur en ont un).
export function pauseParUtilisateur(etat) {
  if (etat?.statut === 'pause') return etat.pauseUtilisateur ?? !etat.erreur;
  return etat?.statut === 'bloque' && etat.pauseUtilisateur === true;
}

export function recherchesReussies(etat) {
  return Array.isArray(etat?.recherches)
    ? etat.recherches.filter((recherche) => recherche.statut === 'terminee').length
    : etat?.statut === 'termine' ? 1 : 0;
}

function modifierRecherche(etat, changements) {
  if (!etat.recherches?.[etat.recherche_index]) return etat;
  return { ...etat, recherches: etat.recherches.map((recherche, index) => index === etat.recherche_index
    ? { ...recherche, ...changements } : recherche) };
}

export function appliquerEvenement(etat, evenement) {
  // Les ressources peuvent finir d’être créées après Stop ; leur suivi et
  // leur retrait restent atomiques et permettent toujours leur nettoyage.
  if (evenement.type === 'onglet_ouvert') return { ...etat, onglets: [...new Set([...etat.onglets, evenement.id])] };
  // `onglet_relache` cesse le suivi sans fermer : l'onglet passe à
  // l'utilisateur, le nettoyage de fin de run ne doit plus y toucher.
  if (evenement.type === 'onglet_ferme' || evenement.type === 'onglet_relache') {
    return { ...etat, onglets: etat.onglets.filter((id) => id !== evenement.id) };
  }
  // Ce test s’exécute dans la file des écritures, après les transitions qui
  // précèdent : une erreur tardive ne peut plus rouvrir Stop ou un blocage.
  // Stop reste possible après un blocage survenu pendant une pause voulue.
  const leveePause = evenement.type === 'termine' && evenement.utilisateur === true && pauseParUtilisateur(etat);
  if (['termine', 'bloque'].includes(etat.statut) && !leveePause) return etat;
  const statuts = { pause: 'pause', reprise: 'en_cours', bloque: 'bloque', termine: 'termine' };
  if (statuts[evenement.type]) {
    const suivant = { ...etat, statut: statuts[evenement.type], erreur: evenement.message ?? null };
    // Une erreur tardive ne retire pas la marque posée par l’utilisateur.
    if (evenement.type === 'pause') {
      suivant.pauseUtilisateur = evenement.utilisateur === true || etat.pauseUtilisateur === true;
    }
    if (evenement.type === 'reprise') suivant.pauseUtilisateur = false;
    if (evenement.type === 'termine') suivant.arretUtilisateur = evenement.utilisateur === true;
    return suivant;
  }
  if (evenement.type === 'sans_contact') return { ...etat, contactAuto: false };
  if (evenement.type === 'recherche_selectionnee') {
    const recherche = etat.recherches[evenement.index];
    return modifierRecherche({ ...etat, recherche_index: evenement.index,
      urlRecherche: recherche.urlRecherche, page_suivante: recherche.page_suivante,
      extraction_terminee: recherche.extraction_terminee, details_utilises: recherche.details_utilises,
    }, { statut: 'en_cours' });
  }
  if (evenement.type === 'recherche_fin') {
    const message = evenement.erreur ? String(evenement.erreur) : null;
    const erreur = message && message.length > LONGUEUR_ERREUR_RECHERCHE_MAX
      ? `${message.slice(0, LONGUEUR_ERREUR_RECHERCHE_MAX - 1)}…` : message;
    return modifierRecherche(etat, { statut: erreur ? 'erreur' : 'terminee', erreur });
  }
  if (evenement.type === 'avance') {
    const curseur = {};
    for (const cle of ['page_suivante', 'extraction_terminee', 'details_utilises']) {
      if (cle in evenement.changements) curseur[cle] = evenement.changements[cle];
    }
    return modifierRecherche({ ...etat, ...evenement.changements }, curseur);
  }

  const annonce = evenement.annonce ?? evenement;
  const url = evenement.type === 'recue' ? annonce.url_annonce : evenement.url_annonce;
  const courante = etat.annonces[url];
  let suivante;
  if (evenement.type === 'recue') {
    const recherche = etat.recherches?.[etat.recherche_index];
    const recues = recherche?.annonces_recues ?? Object.keys(etat.annonces);
    if (!urlAnnonceValide(url) || (!recues.includes(url) && recues.length >= etat.maxResultats)) return etat;
    if (recherche && !recues.includes(url)) etat = modifierRecherche(etat, { annonces_recues: [...recues, url] });
    const donnees = { ...courante?.donnees };
    for (const [cle, valeur] of Object.entries(annonce)) {
      if (valeur != null && valeur !== '' && !(cle === 'type' && !evenement.annonce)) donnees[cle] = valeur;
    }
    if (courante && JSON.stringify(donnees) === JSON.stringify(courante.donnees)) return etat;
    suivante = {
      etat: 'recue', en_base: false, analysee: false, classification: null,
      erreur: null, revision_traitee: 0, detail: null, ...courante,
      url_annonce: url, donnees, titre: donnees.titre ?? null, prix_eur: donnees.prix_eur ?? null,
      image_url: donnees.image_url ?? null, revision: (courante?.revision ?? 0) + 1,
    };
  } else {
    if (!courante) return etat;
    suivante = { ...courante };
    switch (evenement.type) {
      case 'upsertee':
        suivante.en_base = true;
        suivante.deja_analysee = evenement.deja_analysee === true;
        if (!suivante.analysee) suivante.etat = 'en_base';
        suivante.erreur = null;
        break;
      case 'classifiee':
        Object.assign(suivante, { etat: 'classifiee', analysee: true,
          classification: evenement.classification ?? null, disqualifiee: evenement.disqualifiee === true, erreur: null });
        break;
      case 'contact_envoye':
        suivante.contact_envoye = true;
        break;
      case 'contact_skip':
        suivante.contact_skip = String(evenement.erreurCode || 'inconnue');
        if (evenement.simule) suivante.contact_simule = true;
        break;
      case 'analyse_demandee':
        suivante.analyse_demandee = true;
        suivante.analyse_force = evenement.force === true;
        break;
      case 'traitee': suivante.revision_traitee = evenement.revision; break;
      case 'detail':
        suivante.detail = evenement.statut;
        if (evenement.donnees) suivante.detail_donnees = evenement.donnees;
        break;
      case 'detail_enrichi': Object.assign(suivante, { etat: 'enrichie', detail: 'fait' }); break;
      case 'erreur': Object.assign(suivante, { etat: 'erreur', erreur: String(evenement.message) }); break;
      default: return etat;
    }
  }
  return { ...etat, annonces: { ...etat.annonces, [url]: suivante } };
}

export function compteurs(etat) {
  const valeurs = Object.values(etat.annonces);
  return {
    recues: valeurs.length,
    en_base: valeurs.filter((a) => a.en_base).length,
    analysees: valeurs.filter((a) => a.analysee).length,
    retenues: valeurs.filter((a) => a.analysee && a.classification && a.classification !== 'disqualifiee' && !a.disqualifiee).length,
    erreurs: valeurs.filter((a) => a.erreur).length,
  };
}
