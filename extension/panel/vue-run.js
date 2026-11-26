// Rendu de la recherche : bandeau d'avancement (onglet Annonces) et état de la
// recherche automatique (Accueil). Aucune décision ici.
import { compteurs, pauseParUtilisateur } from '../sw/run-state.js';
import { cocher, formaterEcheance } from './dom.js';

const STATUTS = { en_cours: 'Recherche en cours', pause: 'En pause', termine: 'Recherche terminée', bloque: 'BLOQUÉ par leboncoin — recherche interrompue' };
const RECHERCHES_FINIES = new Set(['terminee', 'termine', 'erreur']);
const STATUTS_AUTO = {
  idle: 'Autopilote actif',
  running: 'Recherche automatique en cours',
  retrying: 'Autopilote actif — nouvel essai planifié',
  blocked: 'Autopilote actif — leboncoin a temporairement bloqué la recherche',
  paused: 'Autopilote désactivé',
  suspended: 'Autopilote suspendu : vous avez mis la recherche en pause',
};

// Ce que le premier message automatique fera, avant de lancer ou pendant un run.
const AVIS_LANCER = {
  reel: 'Le premier message sera envoyé automatiquement aux meilleures annonces.',
  simulation: 'Mode test : le premier message sera seulement tapé aux meilleures annonces, jamais envoyé.',
  lecture: 'Premier message automatique activé. Lecture du mode d’envoi…',
  inconnu: 'Mode inconnu (réglages illisibles) : le premier message automatique est activé. Vérifiez les réglages avant de lancer.',
};
const AVIS_RUN = {
  en_cours: {
    reel: 'Le premier message est envoyé automatiquement aux meilleures annonces.',
    simulation: 'Mode test : le premier message est seulement tapé, jamais envoyé.',
    lecture: 'Premier message automatique activé. Lecture du mode d’envoi…',
    inconnu: 'Mode inconnu (réglages illisibles) : le premier message automatique est activé. Vérifiez les réglages.',
  },
  pause: {
    reel: 'Après Reprendre, le premier message sera envoyé automatiquement aux meilleures annonces.',
    simulation: 'Mode test : après Reprendre, le premier message sera seulement tapé, jamais envoyé.',
    lecture: 'Premier message automatique activé. Lecture du mode d’envoi…',
    inconnu: 'Mode inconnu (réglages illisibles) : le premier message automatique est activé. Vérifiez les réglages avant de reprendre.',
  },
};

export function creerVueRun({ el, bouton }, { surLancer, surPause, surStop }) {
  const statut = el('div', { id: 'statut-run', classe: 'fort', role: 'status' });
  const avancement = el('div', { id: 'avancement', classe: 'discret' });
  const pause = bouton('Pause', { id: 'pause', classe: 'bouton-doux' }, surPause);
  const arreter = bouton('Stop', { id: 'arreter', classe: 'bouton-lien-discret' }, surStop);
  const jauge = el('div', { id: 'jauge', classe: 'jauge-remplie' });
  const barre = el('div', { id: 'barre', classe: 'jauge', role: 'img' }, jauge);
  const consigne = el('p', {
    id: 'consigne-blocage', role: 'alert', hidden: true,
    texte: 'leboncoin a restreint l’accès. Vérifiez la page dans Chrome avant de relancer.',
  });
  const compte = el('p', { id: 'compteurs', 'aria-live': 'polite' });
  const resume = el('ul', { id: 'resume-recherches', classe: 'liste-nue', 'aria-label': 'Progression des recherches' });
  const details = el('details', { id: 'details-run', classe: 'aide' },
    el('summary', { texte: 'Détails' }), compte, resume);
  const avisRun = el('p', { id: 'avis-contact-run', classe: 'texte-alerte', hidden: true, 'aria-live': 'polite' });
  const section = el('section', { id: 'bandeau-run', classe: 'carte', 'aria-label': 'Recherche' },
    el('div', { classe: 'run-tete' }, el('div', { classe: 'run-titre' }, statut, avancement),
      el('div', { classe: 'run-actions' }, pause, arreter)),
    avisRun, barre, consigne, details);
  const lancer = bouton('Lancer une recherche', { id: 'lancer', classe: 'bouton-principal' }, surLancer);
  const avisLancer = el('p', {
    id: 'avis-contact', classe: 'texte-alerte centre', hidden: true, 'aria-live': 'polite',
  });
  return {
    noeuds: [section, lancer, avisLancer], avisLancer, avisRun,
    section, statut, avancement, pause, arreter, barre, jauge, consigne, compteurs: compte, resume, details, lancer,
  };
}

export function rendreRun(vue, etat) {
  const actif = etat?.statut === 'en_cours';
  const pause = etat?.statut === 'pause';
  const retenu = pauseParUtilisateur(etat);
  vue.lancer.disabled = actif || pause;
  vue.lancer.hidden = actif || pause;
  vue.pause.disabled = !actif && !pause;
  vue.pause.hidden = vue.pause.disabled;
  vue.pause.textContent = pause ? 'Reprendre' : 'Pause';
  vue.arreter.disabled = !actif && !pause && !retenu;
  vue.arreter.hidden = vue.arreter.disabled;

  let titre = etat
    ? `${STATUTS[etat.statut] ?? etat.statut}${etat.erreur ? ` — ${etat.erreur}` : ''}` : 'Prêt à lancer une recherche.';
  if (retenu) {
    titre += pause
      ? ' · À votre demande : aucune relance automatique avant Reprendre ou Stop'
      : ' · Après votre pause : aucune relance automatique avant Stop';
  }
  const contacts = Object.values(etat?.annonces ?? {});
  if (contacts.some((annonce) => annonce.contact_skip === 'simulation')) {
    const envoi = contacts.some((annonce) => annonce.contact_envoye || annonce.contact_skip === 'envoi_incertain');
    titre += envoi
      ? ' · Certains contacts ont été simulés (mode test)'
      : ' · Mode test : aucun message envoyé (contact simulé)';
  }
  vue.statut.textContent = titre;
  const bloque = etat?.statut === 'bloque';
  vue.consigne.hidden = !bloque;
  vue.section.className = bloque ? 'carte carte-erreur' : 'carte';

  const valeurs = compteurs({ annonces: etat?.annonces ?? {} });
  const progres = (actif || pause) && valeurs.recues > 0;
  vue.avancement.hidden = !(actif || pause);
  vue.avancement.textContent = `${valeurs.analysees} annonces analysées sur ${valeurs.recues}`;
  vue.barre.hidden = !progres;
  const pourcent = progres ? Math.round((valeurs.analysees / valeurs.recues) * 100) : 0;
  vue.jauge.style.width = `${pourcent}%`;
  vue.barre.setAttribute('aria-label', `${pourcent} pour cent analysé`);

  vue.details.hidden = !etat;
  let bilan = `${valeurs.recues} reçues · ${valeurs.en_base} en base · `
    + `${valeurs.analysees} analysées · ${valeurs.retenues} retenues · ${valeurs.erreurs} erreurs`;
  const recherches = etat?.recherches ?? [];
  if (recherches.length) {
    const finies = recherches.filter((recherche) => RECHERCHES_FINIES.has(recherche.statut)).length;
    const erreurs = recherches.filter((recherche) => recherche.statut === 'erreur').length;
    bilan += ` · Recherches : ${finies}/${recherches.length}`
      + ` · ${erreurs} erreur${erreurs === 1 ? '' : 's'} de recherche`;
  }
  vue.compteurs.textContent = bilan;
  const document = vue.resume.ownerDocument;
  vue.resume.replaceChildren(...recherches.map((recherche) => {
    const ligne = document.createElement('li');
    const nombre = recherche.annonces_recues?.length ?? 0;
    const pagesTraitees = Math.max(0, (recherche.page_suivante ?? 1) - 1);
    const paginationFinie = recherche.extraction_terminee || RECHERCHES_FINIES.has(recherche.statut)
      || ['termine', 'bloque'].includes(etat.statut);
    const progression = paginationFinie
      ? `${pagesTraitees} page${pagesTraitees === 1 ? '' : 's'} traitée${pagesTraitees === 1 ? '' : 's'}`
      : `prochaine page ${recherche.page_suivante ?? 1}`;
    ligne.textContent = `${recherche.index + 1}. ${recherche.urlRecherche} · ${recherche.statut}`
      + ` · ${nombre} annonce${nombre === 1 ? '' : 's'} · ${progression}`
      + (recherche.erreur ? ` · Erreur : ${recherche.erreur}` : '');
    return ligne;
  }));
}

// `voulu` : l'interrupteur, pour la prochaine recherche. Un run déjà parti
// garde sa propre option. À appeler après `rendreRun`, qui masque Lancer.
export function rendreAvisContact(vue, { voulu, run, mode }) {
  const afficher = (node, texte) => {
    node.hidden = !texte;
    node.textContent = texte;
  };
  afficher(vue.avisLancer, voulu && !vue.lancer.hidden ? AVIS_LANCER[mode] : '');
  afficher(vue.avisRun, run?.contactAuto === true ? (AVIS_RUN[run.statut]?.[mode] ?? '') : '');
}

// `vue` : { interrupteur, statut, prochain }.
export function rendreAutopiloteRecherche(vue, etat) {
  const enabled = etat?.enabled === true;
  cocher(vue.interrupteur, enabled);
  vue.statut.textContent = etat
    ? (STATUTS_AUTO[etat.status] ?? etat.status)
    : 'Autopilote — chargement…';
  const nextRunAt = Number(etat?.nextRunAt);
  vue.prochain.textContent = Number.isFinite(nextRunAt) && nextRunAt > 0
    ? `Prochaine recherche vers ${formaterEcheance(nextRunAt)}`
    : etat?.status === 'suspended' ? 'Aucune recherche automatique : choisissez Reprendre ou Stop'
      : enabled ? 'Prochaine recherche : planification en cours' : 'Aucune recherche automatique planifiée';
}
