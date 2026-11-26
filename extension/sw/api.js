// Seul point de contact avec le serveur local. Toute la logique métier
// (base, OpenRouter) vit côté serveur : l'extension ne porte aucune clé.

import { createNullLogger } from '../lib/log.js';

const BASE_URL = 'http://127.0.0.1:8835';

class ServerUnreachableError extends Error {
  constructor() {
    super('Serveur local injoignable. Lance `npm run dev`.');
    this.name = 'ServerUnreachableError';
  }
}

export function createApi({
  fetch: request = (...args) => fetch(...args),
  baseUrl = BASE_URL,
  logger = createNullLogger(),
} = {}) {
  async function lire(path, options) {
    const method = options?.method ?? 'GET';
    const debut = Date.now();
    logger.log('api:requete', { path, method });
    let response;
    try {
      response = await request(`${baseUrl}${path}`, options);
    } catch (error) {
      // Cas le plus fréquent en pratique : `npm run dev` n'est pas lancé.
      logger.logErreur('api:injoignable', error, { path, method });
      throw new ServerUnreachableError();
    }
    const payload = await response.json().catch(() => ({}));
    const duree_ms = Date.now() - debut;
    if (!response.ok) {
      // Un 403 ici signale presque toujours un EXTENSION_ORIGIN désaccordé.
      logger.log('api:refus', { path, method, status: response.status, duree_ms, erreur: payload?.error });
      const refus = new Error(payload?.error || `Serveur local: HTTP ${response.status}`);
      if (typeof payload?.code === 'string') refus.code = payload.code;
      throw refus;
    }
    logger.log('api:reponse', { path, method, status: response.status, duree_ms });
    return payload;
  }

  const get = (path) => lire(path);
  const post = (path, body) => lire(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    ServerUnreachableError,
    upsertAnnonce: (annonce) => post('/api/annonces/upsert', { annonce }),
    classifyAnnonce: (urlAnnonce, { force = false, settings } = {}) =>
      post('/api/annonces/classify', { url_annonce: urlAnnonce, force, settings }),
    reservationsBloquees: () => post('/api/annonces/reservations', {}),
    resoudreReservation: (urlAnnonce, resultat) =>
      post('/api/annonces/reservation-resoudre', { url_annonce: urlAnnonce, resultat }),
    shortlist: ({ limite = 50, prixMax } = {}) => get(`/api/annonces/shortlist?limite=${encodeURIComponent(limite)}`
      + (prixMax === undefined ? '' : `&prix_max=${encodeURIComponent(prixMax)}`)),
    marquerIntrouvable: (urlAnnonce) => post('/api/annonces/introuvable', { url_annonce: urlAnnonce }),
    marquerContactee: (urlAnnonce) => post('/api/annonces/contactee', { url_annonce: urlAnnonce }),
    reserverContact: (urlAnnonce) => post('/api/annonces/contact-reserver', { url_annonce: urlAnnonce }),
    finaliserContact: (urlAnnonce, reservationToken, resultat) =>
      post('/api/annonces/contact-finaliser', {
        url_annonce: urlAnnonce, reservation_token: reservationToken, resultat,
      }),
    libererContact: (urlAnnonce, reservationToken) =>
      post('/api/annonces/contact-liberer', { url_annonce: urlAnnonce, reservation_token: reservationToken }),
    marquerErreurContact: (urlAnnonce, code, reservationToken) =>
      post('/api/annonces/contact-erreur', {
        url_annonce: urlAnnonce, code,
        ...(reservationToken === undefined ? {} : { reservation_token: reservationToken }),
      }),
    // Chrome peut omettre Origin sur un GET privilégié du service worker.
    // Le POST JSON déclenche un prévol CORS et rend donc l'origine vérifiable.
    conversations: () => post('/api/conversations', {}),
    conversationNegotiate: (snapshot, fingerprint, settings) =>
      post('/api/conversations/negotiate', { snapshot, fingerprint, settings }),
    conversationSent: (payload) => post('/api/conversations/sent', payload),
    conversationHandled: (payload) => post('/api/conversations/handled', payload),
    conversationError: (payload) => post('/api/conversations/error', payload),
    handoff: (payload) => post('/api/handoff', payload),
    async ping() {
      try {
        // Un GET privilégié Chrome peut omettre Origin. Le POST JSON fait
        // vérifier au serveur la même origine que les mutations de l'extension.
        return (await post('/api/health', {}))?.ok === true;
      } catch {
        return false;
      }
    },
  };
}

export const api = createApi();
