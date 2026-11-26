// Un tour de conversation : périmètre, réservation, génération, et restitution
// d'un point d'arrêt tant qu'il n'a pas été marqué traité.
import { readSettings } from './server-settings.js';

export function createConversationTurn({ db, generate }) {
  // Un rejeu arrivé pendant la génération doit attendre la décision, pas
  // recevoir « doublon » et la perdre.
  const files = new Map();

  async function traiter({ snapshot, fingerprint, settings: raw }) {
    const settings = readSettings(raw);
    const url = snapshot.url_conversation;
    if (settings.replyScope !== 'all'
      && !(snapshot.url_annonce && await db.isListingContacted(snapshot.url_annonce))) {
      return { ignored: true, reason: 'hors_perimetre' };
    }
    await db.upsertConversation(snapshot);
    let conversation = await db.loadConversationByUrl(url);
    const memeTour = conversation.dernier_message_fingerprint === fingerprint;
    if (memeTour && !conversation.traite_le && conversation.decision?.arret?.doit_arreter === true) {
      return {
        duplicate: false, conversation, draft: conversation.decision,
        ...(settings.dryRun ? { dryRun: true } : {}),
      };
    }

    if (settings.dryRun) {
      // Lecture seule : un tour déjà traité pour de vrai reste un doublon.
      const reprenable = !memeTour || conversation.automation_erreur_code === 'generation_echec'
        || (!conversation.traite_le && !conversation.decision && !conversation.brouillon
          && !conversation.automation_erreur_code);
      if (!reprenable) return { duplicate: true };
    } else {
      const reservation = await db.reserveConversationTurn(url, fingerprint);
      if (!reservation.reserved) return { duplicate: true };
      conversation = await db.loadConversationByUrl(url);
    }

    try {
      const messageVendeur = [...conversation.messages].reverse()
        .find((message) => message.expediteur === 'vendeur')?.contenu;
      if (!messageVendeur) throw new Error('Aucun message vendeur à traiter.');
      const draft = await generate({ conversation, messageVendeur, settings });
      if (settings.dryRun) return { duplicate: false, dryRun: true, conversation, draft };
      await db.storeConversationDraft(url, fingerprint, draft);
      return { duplicate: false, conversation, draft };
    } catch (error) {
      if (!settings.dryRun) await db.markConversationError(url, fingerprint, 'generation_echec').catch(() => {});
      throw error;
    }
  }

  return async function negotiateTurn(payload) {
    const cle = payload.snapshot.url_conversation;
    const result = (files.get(cle) ?? Promise.resolve()).catch(() => {}).then(() => traiter(payload));
    files.set(cle, result);
    try {
      return await result;
    } finally {
      if (files.get(cle) === result) files.delete(cle);
    }
  };
}
