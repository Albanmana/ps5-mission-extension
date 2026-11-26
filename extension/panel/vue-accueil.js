// Accueil : état du pilote, derniers envois, puis seulement ce qui attend une
// décision. Les modules métier remplissent les emplacements préparés ici.

export function monterAccueil(ecran, dom, { surConversations }) {
  const { el, bouton } = dom;
  const point = el('span', { classe: 'point point-gris', 'aria-hidden': 'true' });
  const etatTexte = el('strong', { id: 'pilote-etat' });
  const blocage = el('p', {
    id: 'pilote-blocage', classe: 'encart encart-erreur', role: 'alert', hidden: true,
    texte: 'Recherche interrompue : leboncoin a restreint l’accès. Vérifiez la page dans Chrome (détails dans Annonces).',
  });
  const emplacements = {
    recherche: el('div'), contact: el('div'), reponse: el('div'), suivi: el('div', { classe: 'pilote-suivi' }),
    envois: el('div'), cartes: el('div'), reservations: el('div'), reservationsPied: el('div'),
    verifier: el('div'),
  };
  const pilote = el('section', { classe: 'carte pilote', 'aria-label': 'Pilote automatique' },
    el('div', { classe: 'pilote-etat', role: 'status' }, point, etatTexte),
    emplacements.recherche, emplacements.contact, emplacements.reponse,
    emplacements.suivi, blocage,
    el('details', { classe: 'aide' },
      el('summary', { texte: 'Comment marche le pilote ?' }),
      el('p', { texte: 'La recherche automatique recommence toutes les 30 min environ, entre 8 h et 23 h, jusqu’à désactivation. Mettre une recherche en pause la suspend jusqu’à Reprendre ou Stop. Désactiver arrête aussi les envois automatiques de la recherche qu’il a lancée.' }),
      el('p', { texte: '« Vérifier maintenant » traite jusqu’à 50 conversations, même hors horaires : en envoi réel, plusieurs réponses peuvent partir.' }),
      el('p', { texte: 'Le premier message est envoyé automatiquement après confirmation de la page de réponse. Chaque fiche coûte 10 à 20 s ; les mieux classées passent d’abord.' })));

  const resume = el('h2', { id: 'a-vous', hidden: true });
  const toutFait = el('div', { id: 'tout-a-jour', classe: 'tout-a-jour', hidden: true },
    el('span', { classe: 'coche', 'aria-hidden': 'true', texte: '✓' }),
    el('strong', { texte: 'Tout est à jour' }),
    el('span', { classe: 'discret', texte: 'Ce qui demande votre décision apparaîtra ici.' }));
  const liens = el('div', { classe: 'liens-accueil' },
    bouton('Toutes les conversations', { id: 'voir-conversations', classe: 'bouton-lien' }, surConversations),
    emplacements.verifier);

  ecran.replaceChildren(pilote, emplacements.envois, resume, emplacements.cartes, emplacements.reservations,
    toutFait, emplacements.reservationsPied, liens);

  const connu = { mode: 'lecture', auto: null, run: null, conversations: null };

  function decrirePilote() {
    const { mode, auto, run, conversations } = connu;
    if (mode === 'inconnu') return ['Mode inconnu : vérifiez les réglages', 'rouge'];
    const runActif = run?.statut === 'en_cours';
    const actif = auto?.enabled === true || conversations?.enabled === true || runActif;
    if (!actif) {
      if (!auto || !conversations || mode === 'lecture') return ['Lecture de l’état du pilote…', 'gris'];
      return ['À l’arrêt', 'gris'];
    }
    if (mode === 'lecture') return ['Lecture du mode d’envoi…', 'gris'];
    if (mode === 'simulation') return ['En marche, en mode test', 'ambre'];
    // N'annoncer des envois que si quelque chose peut vraiment partir.
    const envoie = conversations?.enabled === true
      || (runActif && run.contactAuto === true)
      || (auto?.enabled === true && auto.status !== 'suspended' && auto.options?.contactAuto === true);
    if (envoie) return ['En marche, les messages partent', 'vert'];
    // Un état manquant ne permet pas d'affirmer qu'aucun envoi ne partira.
    if (!auto || !conversations) return ['En marche (état incomplet)', 'ambre'];
    return ['En marche, aucun envoi automatique', 'vert'];
  }

  let compte = { reprises: null, verifications: null };

  return {
    emplacements,
    maj(changements) {
      Object.assign(connu, changements);
      const [texte, couleur] = decrirePilote();
      etatTexte.textContent = texte;
      point.className = `point point-${couleur}`;
      blocage.hidden = connu.run?.statut !== 'bloque';
    },
    // `null` : liste inconnue ou illisible. « Tout est à jour » exige les deux.
    majCompte(changements) {
      compte = { ...compte, ...changements };
      const total = (compte.reprises ?? 0) + (compte.verifications ?? 0);
      resume.textContent = `À vous (${total})`;
      resume.hidden = total === 0;
      toutFait.hidden = !(compte.reprises === 0 && compte.verifications === 0);
      return total;
    },
  };
}
