// L'extension n'a pas de console lisible : le service worker et le panneau
// ont chacun leurs DevTools, invisibles depuis un terminal. Ce module pousse
// donc les journaux vers le serveur local, qui les écrit dans un fichier.
//
// Règle absolue : journaliser ne doit jamais casser ce qu'on journalise.
// Toute erreur d'envoi est avalée, et le tampon est borné.

const BASE_URL = 'http://127.0.0.1:8835';

export const MAX_BUFFER = 200;

// Le service worker peut être suspendu à tout moment : on n'attend pas
// longtemps avant de pousser ce qui est en attente.
const FLUSH_DELAY_MS = 250;

// Une donnée cyclique ou trop profonde ne doit pas faire perdre l'entrée.
function serialisable(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return { non_serialisable: true };
  }
}

// Journalisation silencieuse : valeur par défaut des modules, pour qu'un test
// n'aille jamais taper le serveur local sans l'avoir demandé.
export function createNullLogger() {
  return { log() {}, logErreur() {}, flush: async () => {} };
}

export function createLogger({
  scope,
  fetch: request = (...args) => globalThis.fetch(...args),
  baseUrl = BASE_URL,
  flushDelayMs = FLUSH_DELAY_MS,
  maxBuffer = MAX_BUFFER,
  console: journal = globalThis.console,
} = {}) {
  let tampon = [];
  let minuteur = null;

  async function flush() {
    if (minuteur) { clearTimeout(minuteur); minuteur = null; }
    if (tampon.length === 0) return;
    // Le tampon est vidé avant l'envoi : un échec abandonne ces entrées
    // plutôt que de les accumuler jusqu'à saturer la mémoire.
    const entries = tampon;
    tampon = [];
    try {
      await request(`${baseUrl}/api/log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
    } catch {
      // Serveur éteint : on n'a rien de mieux à faire que de continuer.
    }
  }

  function planifier() {
    if (minuteur) return;
    minuteur = setTimeout(() => { minuteur = null; flush(); }, flushDelayMs);
    // Ne pas retenir le processus en vie côté tests Node.
    minuteur?.unref?.();
  }

  function log(event, data) {
    tampon.push({ scope, event, data: serialisable(data) });
    // On garde les plus récentes : en cas d'emballement, la fin du run
    // renseigne davantage que son début.
    if (tampon.length > maxBuffer) tampon = tampon.slice(-maxBuffer);
    journal?.debug?.(`[${scope}] ${event}`, data ?? '');
    planifier();
  }

  function logErreur(event, error, data) {
    log(event, {
      ...serialisable(data),
      erreur: error?.message ?? String(error),
      type: error?.name ?? 'Error',
    });
  }

  return { log, logErreur, flush };
}
