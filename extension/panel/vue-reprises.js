// Cartes « à vous » : points d'arrêt et conversations abandonnées après échecs.
import { conversationValide, formaterDate } from './dom.js';

const RAISONS = {
  paiement_leboncoin_accepte: ['Envoi accepté : le paiement est à vous', 'vert'],
  paiement_leboncoin_refuse: ['À vous de répondre : envoi avec paiement leboncoin refusé'],
  rdv_confirme: ['À vous de répondre : rendez-vous à vérifier'],
  refus_categorique_prix: ['À vous de répondre : refus catégorique sur le prix'],
  defaut_majeur: ['À vous de répondre : défaut majeur signalé'],
  question_importante: ['Réponse à rédiger vous-même'],
  envoi_incertain: ['Envoi non confirmé : vérifiez la conversation avant de répondre', 'ambre'],
};

function suiviHandoff(handoff) {
  if (handoff.raison === 'envoi_incertain') return 'Ce message ne sera pas renvoyé automatiquement.';
  if (handoff.dryRun) return 'Simulation : rien n’est enregistré et aucun e-mail n’est envoyé.';
  if (!handoff.enregistre) return 'Enregistrement sur le serveur en attente : nouvel essai à chaque passage.';
  return handoff.notified ? 'Enregistrée, e-mail envoyé.' : 'Enregistrée, sans e-mail.';
}

// Les plus récentes d'abord. `traitement` est la commande de « C'est fait ».
export function reprisesEnAttente(etat) {
  const arrets = Object.values(etat?.handoffs ?? {}).map((handoff) => {
    const details = [];
    if (handoff.offre_recue_eur != null) details.push(`offre reçue : ${handoff.offre_recue_eur} €`);
    if (handoff.lieu_propose) details.push(`lieu : ${handoff.lieu_propose}`);
    details.push(formaterDate(handoff.cree_le), suiviHandoff(handoff));
    const [raison, ton = 'orange'] = RAISONS[handoff.raison] ?? ['Reprise nécessaire'];
    return {
      cle: `handoff:${handoff.fingerprint}`,
      vendeur: handoff.vendeur,
      url: handoff.url_conversation,
      titre: handoff.annonce_titre,
      raison,
      ton,
      messageVendeur: handoff.message_vendeur,
      notes: handoff.notes,
      details,
      cree_le: handoff.cree_le,
      traitement: { type: 'conversations-handoff-traite', fingerprint: handoff.fingerprint },
    };
  });
  const echecs = Object.entries(etat?.echecs ?? {})
    .filter(([, echec]) => echec.abandonne && !echec.traite)
    .map(([url, echec]) => ({
      cle: `echec:${url}`,
      vendeur: echec.vendeur,
      url,
      titre: echec.annonce_titre,
      raison: 'Réponse automatique impossible : répondez vous-même',
      ton: 'orange',
      messageVendeur: echec.message_vendeur,
      // Fil jamais lu : l’aperçu de la liste aide à le reconnaître.
      notes: echec.message_vendeur ? null : echec.preview,
      details: [formaterDate(echec.cree_le),
        echec.code === 'interrompu' ? 'interrompue avant tout envoi' : `${echec.essais} essai(s) en échec`],
      cree_le: echec.cree_le,
      traitement: { type: 'conversations-echec-traite', url_conversation: url },
    }));
  return [...arrets, ...echecs].sort((left, right) => Number(right.cree_le) - Number(left.cree_le));
}

export function carteReprise({ el, bouton, lien }, reprise, surFait) {
  const { vendeur, url, titre, raison, ton, messageVendeur, notes, details } = reprise;
  const fait = bouton('C’est fait', { classe: 'bouton-lien-discret' }, () => surFait(reprise, fait));
  return el('li', { classe: ton === 'ambre' ? 'carte carte-verification' : 'carte' },
    el('div', { classe: `carte-raison ton-${ton}` },
      el('span', { classe: `point point-${ton}`, 'aria-hidden': 'true' }), el('span', { texte: raison })),
    el('div', { classe: 'carte-qui' },
      el('strong', { texte: vendeur || 'Vendeur inconnu' }),
      titre && el('span', { classe: 'discret', texte: ` · ${titre}` })),
    messageVendeur && el('p', { classe: 'citation', texte: `« ${messageVendeur} »` }),
    notes && el('p', { texte: notes }),
    el('p', { classe: 'discret', texte: details.filter(Boolean).join(' · ') }),
    el('div', { classe: 'carte-actions' },
      conversationValide(url)
        ? lien(url, 'Ouvrir la conversation', true, { classe: 'bouton-sombre' })
        : el('span', { classe: 'discret carte-sans-lien', texte: 'Lien de conversation indisponible' }),
      fait));
}
