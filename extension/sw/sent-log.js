// Journal des derniers messages confirmés envoyés (ou seulement tapés en mode
// test), pour le panneau. Purement informatif : aucune décision d'envoi ne le
// lit, et il ne doit jamais retarder ni interrompre un envoi. Un envoi non
// confirmé n'y entre pas : il relève des vérifications à la main.

export const SENT_LOG_KEY = 'ps5_messages_envoyes';
export const SENT_LOG_MAX = 50;
const LONGUEUR_VENDEUR = 80;
const LONGUEUR_DEBUT = 80;
const KINDS = new Set(['premier_contact', 'reponse']);

const texteCourt = (value, max) => (typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// Ni paramètres ni ancre, et uniquement une page leboncoin.
function urlNue(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.leboncoin.fr' ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}

export function consigner(journal, entry) {
  try {
    journal?.record(entry)?.catch?.(() => {});
  } catch { /* Le journal ne doit jamais toucher à l'envoi. */ }
}

export function createSentLog({ chrome, now = Date.now, logger = { logErreur() {} } }) {
  let ecritures = Promise.resolve();

  async function lire() {
    const stored = (await chrome.storage.local.get(SENT_LOG_KEY))?.[SENT_LOG_KEY];
    return Array.isArray(stored) ? stored : [];
  }

  return {
    async list() { await ecritures; return lire(); },
    record({ kind, simulated, vendeur, message, url } = {}) {
      if (!KINDS.has(kind)) return ecritures;
      const entry = {
        kind,
        // Seul un « false » explicite annonce un envoi réel.
        simulated: simulated !== false,
        vendeur: texteCourt(vendeur, LONGUEUR_VENDEUR) || null,
        debut: texteCourt(message, LONGUEUR_DEBUT),
        tronque: texteCourt(message).length > LONGUEUR_DEBUT,
        url: urlNue(url),
        date: now(),
      };
      ecritures = ecritures.then(async () => {
        const envois = [entry, ...await lire()].slice(0, SENT_LOG_MAX);
        await chrome.storage.local.set({ [SENT_LOG_KEY]: envois });
        await chrome.runtime.sendMessage({ type: 'envois-maj', envois }).catch(() => {});
      }).catch((error) => { logger.logErreur('envois:journal_echec', error); });
      return ecritures;
    },
  };
}
