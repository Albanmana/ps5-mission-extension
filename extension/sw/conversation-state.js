export const CONVERSATION_STATE_KEY = 'conversation_poller_state';
export const CONVERSATION_ALARM = 'ps5-conversation-poll';

// Un état enregistré par une version qui activait l’autopilote d’office est
// traité comme désactivé : seul un nouveau choix de l’utilisateur le réactive.
export const ACTIVATION_VERSION = 2;

export function createConversationState() {
  return {
    activationVersion: ACTIVATION_VERSION,
    enabled: false,
    pauseSeq: 0,
    handoffs: {},
    status: 'paused',
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
    lastBatchProcessed: 0,
    lastError: null,
    failureCount: 0,
    processingFingerprint: null,
    processingUrl: null,
    envoiTente: null,
    aSignaler: {},
    ignorees: {},
    processedFingerprints: {},
    observedPreviews: {},
    baselinePending: false,
    pendingHandled: {},
    echecs: {},
  };
}

export function isConversationWindowOpen(nowMs = Date.now()) {
  const hour = new Date(nowMs).getHours();
  return hour >= 8 && hour < 23;
}

export function nextConversationAlarmAt(nowMs = Date.now(), random = Math.random) {
  const now = new Date(nowMs);
  const hour = now.getHours();
  if (hour < 8) {
    const morning = new Date(now);
    morning.setHours(8, 0, 0, 0);
    return morning.getTime();
  }
  if (hour >= 23) {
    const morning = new Date(now);
    morning.setDate(morning.getDate() + 1);
    morning.setHours(8, 0, 0, 0);
    return morning.getTime();
  }
  const candidate = nowMs + Math.floor((7 * 60_000) + random() * (6 * 60_000));
  const candidateDate = new Date(candidate);
  if (candidateDate.getDate() !== now.getDate() || candidateDate.getHours() >= 23) {
    const morning = new Date(now);
    morning.setDate(morning.getDate() + 1);
    morning.setHours(8, 0, 0, 0);
    return morning.getTime();
  }
  return candidate;
}

export function nextConversationRetryAt(nowMs = Date.now(), failureCount = 1, blocked = false) {
  const now = new Date(nowMs);
  if (now.getHours() < 8) {
    const morning = new Date(now);
    morning.setHours(8, 0, 0, 0);
    return morning.getTime();
  }
  if (now.getHours() >= 23) {
    const morning = new Date(now);
    morning.setDate(morning.getDate() + 1);
    morning.setHours(8, 0, 0, 0);
    return morning.getTime();
  }
  const delays = [2, 5, 10, 20, 30];
  const delayMinutes = blocked ? 60 : delays[Math.min(Math.max(Number(failureCount) || 1, 1), delays.length) - 1];
  const candidate = new Date(nowMs + delayMinutes * 60_000);
  if (candidate.getDate() !== now.getDate() || candidate.getHours() >= 23) {
    const morning = new Date(now);
    morning.setDate(morning.getDate() + 1);
    morning.setHours(8, 0, 0, 0);
    return morning.getTime();
  }
  return candidate.getTime();
}

export function addProcessedFingerprint(state, fingerprint, timestamp = Date.now()) {
  const entries = Object.entries({
    ...(state.processedFingerprints ?? {}),
    [fingerprint]: timestamp,
  }).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 500);
  return {
    ...state,
    processingFingerprint: state.processingFingerprint === fingerprint ? null : state.processingFingerprint,
    processedFingerprints: Object.fromEntries(entries),
  };
}

// Le script d’envoi a été appelé sans preuve qu’il n’a pas cliqué : le tour ne
// sera jamais rejoué, le serveur garde la réservation et l’humain est prévenu.
// La carte est locale (« enregistre ») : ni e-mail, ni clôture côté serveur.
export function markSendUncertain(state, envoi, timestamp = Date.now()) {
  const { url_conversation: url, fingerprint } = envoi;
  const next = {
    ...addProcessedFingerprint(state, fingerprint, timestamp),
    envoiTente: null,
    processingFingerprint: null,
    processingUrl: null,
  };
  return {
    ...next,
    handoffs: {
      ...next.handoffs,
      [fingerprint]: {
        url_conversation: url,
        fingerprint,
        dryRun: false,
        enregistre: true,
        raison: 'envoi_incertain',
        vendeur: envoi.vendeur ?? null,
        annonce_titre: envoi.annonce_titre ?? null,
        message_vendeur: envoi.message_vendeur ?? null,
        notes: envoi.brouillon ? `Réponse peut-être envoyée : ${envoi.brouillon}` : '',
        cree_le: timestamp,
      },
    },
    aSignaler: { ...next.aSignaler, [url]: { fingerprint, code: 'envoi_incertain' } },
  };
}

// Interrompu avant tout appel au script d’envoi : rien n’est parti. Le tour
// réservé est à libérer, et le serveur décidera (il rejoue un point d’arrêt).
function releaseInterruptedTurn(state, timestamp) {
  const url = state.processingUrl;
  const next = { ...state, processingFingerprint: null, processingUrl: null };
  if (!url) return next;
  return {
    ...next,
    // L’entrée d’un tour en cours est déjà vide et porte `enCours`.
    observedPreviews: {
      ...next.observedPreviews,
      [url]: { ...next.observedPreviews?.[url], preview: null, observedAt: timestamp },
    },
    aSignaler: { ...next.aSignaler, [url]: { fingerprint: state.processingFingerprint, code: 'generation_echec' } },
  };
}

export function observeConversationPreview(state, candidate, timestamp = Date.now()) {
  const url = typeof candidate?.url_conversation === 'string' ? candidate.url_conversation : '';
  const preview = typeof candidate?.preview === 'string' ? candidate.preview.trim() : '';
  if (!url || !preview) return state;
  const entries = Object.entries({
    ...(state.observedPreviews ?? {}),
    [url]: { preview, observedAt: timestamp },
  }).sort((a, b) => Number(b[1]?.observedAt) - Number(a[1]?.observedAt)).slice(0, 500);
  return { ...state, observedPreviews: Object.fromEntries(entries) };
}

// Échecs d’un même fil : il laisse passer les autres le temps d’un délai, puis
// est confié à l’humain. Un nouveau message (aperçu différent) repart de zéro.
const MAX_ESSAIS = 3;
const DELAIS_ESSAI_MIN = [5, 20];

export function recordThreadFailure(state, candidate, details, timestamp = Date.now()) {
  const url = candidate.url_conversation;
  const precedent = state.echecs?.[url];
  const essais = precedent?.preview === candidate.preview ? precedent.essais + 1 : 1;
  const abandonne = essais >= MAX_ESSAIS;
  const entry = {
    ...details,
    preview: candidate.preview,
    essais,
    abandonne,
    traite: false,
    retryAt: abandonne ? null : timestamp + DELAIS_ESSAI_MIN[essais - 1] * 60_000,
    cree_le: timestamp,
  };
  return { ...state, echecs: { ...state.echecs, [url]: entry } };
}

// Aperçus que la liste doit sauter. `sansDelai` : vérification demandée à la main.
export function ignoredPreviews(state, timestamp = Date.now(), { sansDelai = false } = {}) {
  return Object.fromEntries(Object.entries(state.echecs ?? {})
    .filter(([, entry]) => entry.abandonne || (!sansDelai && timestamp < entry.retryAt))
    .map(([url, entry]) => [url, { preview: entry.preview, ouvert: entry.ouvert === true }]));
}

export function abandonPendingFailures(echecs) {
  return Object.fromEntries(Object.entries(echecs ?? {})
    .map(([url, entry]) => [url, { ...entry, abandonne: true, retryAt: null }]));
}

// Un tour jamais conclu garde, à côté de son aperçu vide, l’aperçu qui l’a
// ouvert. Si le relevé va considérer ce fil comme vu, il est confié à l’humain.
export function surfaceInterruptedTurns(state, lignes, timestamp = Date.now()) {
  const nonLus = new Set(lignes.filter((ligne) => ligne.non_lu).map((ligne) => ligne.url_conversation));
  const cartes = Object.entries(state.observedPreviews ?? {})
    .filter(([url, entry]) => entry?.enCours && !nonLus.has(url) && !state.echecs?.[url])
    .map(([url, entry]) => [url, {
      code: 'interrompu', preview: entry.enCours, essais: 0, abandonne: true, traite: false,
      retryAt: null, ouvert: false, vendeur: null, annonce_titre: null, message_vendeur: null,
      cree_le: timestamp,
    }]);
  return { ...state.echecs, ...Object.fromEntries(cartes) };
}

// Relevé d’activation : ces fils sont considérés comme vus. Les non-lus gardent
// un aperçu vide, qui les laisse à traiter même après leur ouverture.
export function baselinePreviews(lignes, timestamp = Date.now()) {
  return Object.fromEntries(lignes.slice(0, 500).map((ligne) => [ligne.url_conversation, {
    preview: ligne.non_lu ? null : String(ligne.preview ?? '').trim(),
    observedAt: timestamp,
  }]));
}

export function recoverConversationState(raw, timestamp = Date.now()) {
  const base = createConversationState();
  let state = raw && typeof raw === 'object' ? { ...base, ...raw } : base;
  state.processedFingerprints = state.processedFingerprints && typeof state.processedFingerprints === 'object'
    ? state.processedFingerprints : {};
  state.observedPreviews = state.observedPreviews && typeof state.observedPreviews === 'object'
    ? state.observedPreviews : {};
  state.pendingHandled = state.pendingHandled && typeof state.pendingHandled === 'object'
    ? state.pendingHandled : {};
  state.handoffs = state.handoffs && typeof state.handoffs === 'object' ? state.handoffs : {};
  state.echecs = state.echecs && typeof state.echecs === 'object' ? state.echecs : {};
  state.baselinePending = state.baselinePending === true;
  state.pauseSeq = Number.isInteger(state.pauseSeq) ? state.pauseSeq : 0;
  state.failureCount = Number.isFinite(Number(state.failureCount)) && Number(state.failureCount) >= 0
    ? Math.floor(Number(state.failureCount)) : 0;
  if (raw && raw.activationVersion !== ACTIVATION_VERSION) state.enabled = false;
  state.activationVersion = ACTIVATION_VERSION;
  state.aSignaler = state.aSignaler && typeof state.aSignaler === 'object' ? state.aSignaler : {};
  state.ignorees = state.ignorees && typeof state.ignorees === 'object' ? state.ignorees : {};
  state.envoiTente = state.envoiTente && typeof state.envoiTente === 'object' ? state.envoiTente : null;
  const interrompu = Boolean(state.processingFingerprint || state.envoiTente);
  if (state.envoiTente) {
    state = {
      ...markSendUncertain(state, state.envoiTente, timestamp),
      lastError: 'envoi_incertain',
      lastResult: 'requires_review',
    };
  } else if (state.processingFingerprint && !Object.hasOwn(raw, 'envoiTente')) {
    // Ancien état sans marque d’envoi : le message a pu partir.
    state = {
      ...addProcessedFingerprint(state, state.processingFingerprint, timestamp),
      lastError: 'resultat_incertain',
      lastResult: 'requires_review',
    };
  } else if (state.processingFingerprint) {
    state = releaseInterruptedTurn(state, timestamp);
  }
  if (state.enabled !== true) return { ...state, enabled: false, status: 'paused', nextRunAt: null };
  if (interrompu) {
    return { ...state, status: 'retrying', failureCount: Math.max(1, state.failureCount), nextRunAt: null };
  }
  if (state.status === 'blocked') return state;
  if (state.status === 'retrying') {
    return { ...state, failureCount: Math.max(1, state.failureCount) };
  }
  if (state.status === 'running' || state.status === 'paused') {
    return { ...state, status: 'retrying', failureCount: Math.max(1, state.failureCount), nextRunAt: null };
  }
  return { ...state, status: 'idle' };
}
