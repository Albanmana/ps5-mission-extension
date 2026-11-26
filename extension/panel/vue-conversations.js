// Réponses aux vendeurs : interrupteur et état sur l'Accueil, cartes à
// reprendre, et l'écran des conversations suivies et ignorées.
import { allume, cocher, commander, conversationValide, formaterDate, formaterEcheance } from './dom.js';
import { carteReprise, reprisesEnAttente } from './vue-reprises.js';

const STATUTS = {
  idle: 'Autopilote actif — prêt.',
  running: 'Vérification des conversations en cours…',
  retrying: 'Autopilote actif — nouvelle tentative planifiée.',
  paused: 'Autopilote en pause — aucune réponse ne part. Activez-le pour surveiller les messages.',
  blocked: 'Autopilote actif — accès bloqué, nouvelle tentative différée.',
};

const RESULTATS = {
  waiting_for_tab: 'En attente : gardez un onglet Messages leboncoin ouvert.',
  no_unread: 'Aucun message non lu ni nouveau à traiter.',
  no_seller_message: 'La conversation ne contient pas de nouveau message vendeur.',
  duplicate: 'Ce message vendeur avait déjà été traité.',
  handoff: 'Conversation transmise pour reprise manuelle.',
  sent: 'Réponse envoyée et enregistrée.',
  outside_hours: 'En dehors de la plage 08:00–22:59 ; prochain passage demain matin.',
  acknowledged: 'Résultat vérifié manuellement ; ce tour ne sera pas rejoué.',
  requires_review: 'Envoi à vérifier manuellement ; ce tour ne sera pas rejoué.',
  batch_complete: 'Plus rien à traiter parmi les messages non lus ou nouveaux de la liste affichée. Réponses ou reprises :',
  dry_run: 'Simulation : la réponse est tapée dans la conversation, rien n’a été envoyé.',
  hors_perimetre: 'Conversation ignorée, hors périmètre : annonce non contactée par cet outil.',
  interrompu: 'Vérification interrompue par la pause : rien n’a été envoyé.',
};

function decrireResultat(etat) {
  if (!etat.lastResult) return '';
  return etat.lastResult === 'batch_complete'
    ? `${RESULTATS.batch_complete} ${Number(etat.lastBatchProcessed) || 0}.`
    : (RESULTATS[etat.lastResult] ?? `Dernier résultat : ${etat.lastResult}`);
}

export function monterConversations({ reponse, suivi, cartes, verifier: emplacementVerifier, ecran }, {
  chrome, dom, surEtat = () => {}, surCartes = () => {}, toast = () => {},
}) {
  const { el, bouton, lien, interrupteur, ligneReglage } = dom;
  const actif = interrupteur('conversations-active', 'Répondre automatiquement aux vendeurs', () => {
    if (allume(actif)) return pauser();
    return commande({ type: 'conversations-activer', enabled: true });
  });
  const prochain = el('div', { id: 'conversations-prochain', classe: 'discret' });
  reponse.replaceChildren(ligneReglage('Répondre aux vendeurs', actif, prochain));
  const statut = el('p', { id: 'conversations-statut', classe: 'discret', role: 'status' });
  const resultat = el('p', { id: 'conversations-resultat', classe: 'discret', 'aria-live': 'polite' });
  const erreur = el('p', { id: 'conversations-erreur', classe: 'texte-erreur', role: 'alert' });
  // Secours : état illisible, on doit tout de même pouvoir couper les réponses.
  const pause = bouton('Mettre les réponses en pause', { id: 'conversations-pause', classe: 'bouton-doux', hidden: true },
    () => pauser());
  suivi.replaceChildren(statut, resultat, erreur, pause);
  const listeHandoffs = el('ul', { id: 'conversations-handoffs', classe: 'liste-nue pile' });
  cartes.replaceChildren(listeHandoffs);
  const verifier = bouton('Vérifier maintenant', { id: 'conversations-verifier', classe: 'bouton-lien' },
    () => verifierMaintenant());
  const avisVerifier = el('p', {
    id: 'avis-verifier', classe: 'texte-alerte', hidden: true,
    texte: 'Un seul appui peut envoyer plusieurs réponses (jusqu’à 50 conversations, même hors horaires).',
  });
  emplacementVerifier.replaceChildren(verifier, avisVerifier);

  const liste = el('ul', { id: 'conversations-liste', classe: 'liste-nue carte liste-conversations' });
  const erreurListe = el('p', { id: 'conversations-liste-erreur', classe: 'texte-erreur', role: 'alert' });
  const titreIgnorees = el('summary', { id: 'conversations-ignorees-titre' });
  const listeIgnorees = el('ul', { id: 'conversations-ignorees', classe: 'liste-nue pile' });
  ecran.replaceChildren(
    el('h2', { classe: 'masque', texte: 'Conversations suivies' }), liste, erreurListe,
    el('details', { classe: 'carte' }, titreIgnorees,
      el('p', {
        id: 'conversations-ignorees-aide', classe: 'discret',
        texte: 'Hors périmètre : annonces que l’outil n’a pas contactées, jamais de réponse automatique. '
          + 'Si une négociation est en cours, répondez vous-même ou changez la portée dans Réglages.',
      }),
      listeIgnorees),
    el('details', { classe: 'aide' },
      el('summary', { texte: 'Comment marchent les réponses ?' }),
      el('p', { texte: 'L’autopilote traite une conversation par passage : les messages non lus, puis ceux arrivés depuis son premier passage. À chaque activation, les conversations déjà lues sont laissées telles quelles.' }),
      el('p', { texte: '« Vérifier maintenant » suit la même règle, même hors horaires, et enchaîne jusqu’à 50 conversations (il s’arrête à la première réponse simulée, ou en cas d’erreur). En envoi réel, il peut donc envoyer plusieurs réponses. Gardez un onglet Messages leboncoin ouvert.' })));

  let etat = { enabled: false, status: 'paused' };
  let connu = false, illisible = false, enCours = false;
  const traitements = new Set();

  function rendreHandoffs() {
    const reprises = reprisesEnAttente(etat);
    listeHandoffs.replaceChildren(...reprises.map((reprise) => {
      const carte = carteReprise(dom, reprise, traiter);
      if (traitements.has(reprise.cle)) carte.className += ' en-attente';
      return carte;
    }));
    surCartes(connu ? reprises.length : null);
  }

  // Aucune annulation proposée : le service worker ne sait pas restaurer une carte.
  async function traiter(reprise) {
    if (traitements.has(reprise.cle)) return;
    traitements.add(reprise.cle);
    const fait = await envoyerImmediat(reprise.traitement);
    traitements.delete(reprise.cle);
    if (fait) toast(`Conversation avec ${reprise.vendeur || 'ce vendeur'} classée`);
    else rendreHandoffs();
  }

  function rendreIgnorees() {
    const lignes = Object.entries(etat.ignorees ?? {})
      .sort(([, left], [, right]) => Number(right.ignore_le) - Number(left.ignore_le))
      .map(([url, ignoree]) => el('li', {},
        el('strong', { texte: ignoree.vendeur || 'Vendeur inconnu' }),
        lien(url, ignoree.annonce_titre || 'Ouvrir la conversation', conversationValide(url), { classe: 'lien-fiche' }),
        ignoree.message_vendeur && el('span', { texte: `Vendeur : ${ignoree.message_vendeur}` }),
        el('span', { classe: 'discret', texte: formaterDate(ignoree.ignore_le) })));
    titreIgnorees.textContent = `Conversations ignorées (${lignes.length})`;
    if (!lignes.length) lignes.push(el('li', { texte: 'Aucune conversation ignorée.' }));
    listeIgnorees.replaceChildren(...lignes);
  }

  function rendreEtat(nouvelEtat) {
    if (nouvelEtat && typeof nouvelEtat === 'object') {
      etat = { ...etat, ...nouvelEtat };
      connu = true;
      illisible = false;
    }
    cocher(actif, etat.enabled === true);
    statut.textContent = !connu ? (illisible ? 'État des réponses automatiques illisible.' : 'Lecture de l’état des réponses…')
      : (STATUTS[etat.status] ?? `État : ${etat.status || 'inconnu'}`);
    prochain.textContent = !connu ? '' : etat.nextRunAt
      ? `Prochain passage vers ${formaterEcheance(etat.nextRunAt)}`
      : etat.enabled === true ? 'Aucun passage planifié.' : 'En pause : aucun passage planifié';
    resultat.textContent = decrireResultat(etat);
    erreur.textContent = etat.lastError ? `Erreur : ${etat.lastError}` : '';
    verifier.disabled = enCours || etat.status === 'running' || etat.enabled !== true;
    verifier.textContent = etat.status === 'running' ? 'Vérification en cours…' : 'Vérifier maintenant';
    actif.disabled = !connu || (enCours && etat.enabled !== true);
    pause.hidden = !illisible;
    rendreHandoffs();
    rendreIgnorees();
    if (connu) surEtat(etat);
  }

  function rendreConversations(conversations) {
    const lignes = (Array.isArray(conversations) ? conversations : []).map((conversation) => {
      const destination = conversation?.url_conversation;
      const reprise = conversation?.dernier_message_de === 'vendeur' && conversation?.traite_le;
      const marque = Number(conversation?.non_lus) > 0 ? 'Non lu'
        : conversation?.dernier_message_de === 'moi' ? 'En attente' : '';
      const details = [];
      if (conversation?.dernier_message_de) details.push(`dernier : ${conversation.dernier_message_de}`);
      if (reprise) details.push('traitée · reprise humaine');
      if (Number(conversation?.non_lus) > 0) details.push(`${conversation.non_lus} non lu(s)`);
      if (conversation?.automation_erreur_code) details.push(`erreur : ${conversation.automation_erreur_code}`);
      const nom = [conversation?.vendeur || 'Vendeur inconnu',
        conversation?.annonce_titre || destination || 'Conversation'].join(' · ');
      return el('li', {},
        el('div', { classe: 'conversation-tete' },
          lien(destination, nom, conversationValide(destination), { classe: 'fort lien-fiche' }),
          el('span', { classe: marque === 'Non lu' ? 'marque ton-orange' : 'marque discret', texte: marque })),
        conversation?.dernier_message && el('div', { classe: 'discret',
          texte: `${conversation.dernier_message_de === 'moi' ? 'Vous : ' : ''}${conversation.dernier_message}` }),
        details.length > 0 && el('div', { classe: 'discret petit', texte: details.join(' · ') }));
    });
    if (!lignes.length) lignes.push(el('li', { texte: 'Aucune conversation enregistrée.' }));
    liste.replaceChildren(...lignes);
  }

  async function chargerListe() {
    try {
      rendreConversations((await commander(chrome, { type: 'conversations-liste' })).conversations);
      erreurListe.textContent = '';
    } catch (error) {
      erreurListe.textContent = error.message;
      liste.replaceChildren();
    }
  }

  // Pause et reprises ne doivent pas attendre la fin d’une vérification en cours.
  async function envoyerImmediat(message) {
    try {
      const reponseCommande = await commander(chrome, message);
      if (reponseCommande.etat) rendreEtat(reponseCommande.etat);
      return true;
    } catch (error) {
      erreur.textContent = error.message;
      return false;
    }
  }
  const pauser = () => envoyerImmediat({ type: 'conversations-pause' });

  async function commande(message) {
    if (enCours) return false;
    enCours = true;
    let erreurCommande = null;
    erreur.textContent = '';
    rendreEtat();
    try {
      const reponseCommande = await commander(chrome, message);
      if (reponseCommande.etat) rendreEtat(reponseCommande.etat);
      if (message.type === 'conversations-verifier') await chargerListe();
    } catch (error) {
      erreurCommande = error.message;
    } finally {
      enCours = false;
      rendreEtat();
      if (erreurCommande) erreur.textContent = erreurCommande;
    }
    return !erreurCommande;
  }

  async function verifierMaintenant() {
    if (verifier.disabled) return;
    if (await commande({ type: 'conversations-verifier' })) {
      toast(decrireResultat(etat) || 'Vérification terminée.');
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'conversations-maj') rendreEtat(message.etat);
  });

  rendreEtat();
  const charger = async () => {
    try {
      rendreEtat((await commander(chrome, { type: 'conversations-etat' })).etat);
    } catch (error) {
      illisible = !connu;
      rendreEtat();
      erreur.textContent = error.message;
    }
    await chargerListe();
  };

  return {
    pret: charger(),
    chargerListe,
    majMode(mode) { avisVerifier.hidden = mode !== 'reel'; },
  };
}
