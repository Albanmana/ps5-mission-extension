export const SEARCH_AUTOPILOT_STATE_KEY = 'search_autopilot_state';
export const SEARCH_AUTOPILOT_ALARM = 'ps5-search-autopilot';

export const DEFAULT_SEARCH_OPTIONS = Object.freeze({
  urlsRecherche: ['https://www.leboncoin.fr/recherche?category=43&text=ps5&price=250-400'
    + '&transaction_status=search__no_value&item_condition=7%2C3%2C2%2C1&video_game_type=console'
    + '&owner_type=private&sort=time&order=desc'],
  maxPages: 3,
  maxResultats: 200,
  maxFiches: 50,
  force: false,
  contactAuto: false,
});

// Seule une activation faite sous cette version compte : les anciens états
// étaient actifs par défaut, sans choix de l’utilisateur.
const ACTIVATION_VERSION = 2;

function entierPositif(value, maximum = Infinity) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= maximum ? number : null;
}

export function normaliserUrlRecherche(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL de recherche leboncoin ou limites invalides.');
  }
  if (url.origin !== 'https://www.leboncoin.fr' || url.pathname !== '/recherche'
    || url.username || url.password) throw new Error('URL de recherche leboncoin ou limites invalides.');
  url.searchParams.delete('page');
  return url.href;
}

export function normalizeSearchOptions(options = {}) {
  const entries = options.urlsRecherche === undefined ? [options.urlRecherche] : options.urlsRecherche;
  const maxPages = entierPositif(options.maxPages, 50);
  const maxResultats = entierPositif(options.maxResultats);
  const maxFiches = entierPositif(options.maxFiches);
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 10
    || maxPages === null || maxResultats === null || maxFiches === null) {
    throw new Error('URL de recherche leboncoin ou limites invalides.');
  }
  const urlsRecherche = [...new Set(entries.map(normaliserUrlRecherche))];
  return {
    urlsRecherche,
    maxPages,
    maxResultats,
    maxFiches,
    force: options.force === true,
    contactAuto: options.contactAuto === true,
  };
}

export function createSearchAutopilotState() {
  return {
    activationVersion: ACTIVATION_VERSION,
    enabled: false,
    status: 'paused',
    intervalMinutes: 30,
    nextRunAt: null,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    failureCount: 0,
    options: { ...DEFAULT_SEARCH_OPTIONS, urlsRecherche: [...DEFAULT_SEARCH_OPTIONS.urlsRecherche] },
  };
}

export function isSearchWindowOpen(nowMs = Date.now()) {
  const hour = new Date(nowMs).getHours();
  return hour >= 8 && hour < 23;
}

export function nextSearchWindowAt(nowMs = Date.now()) {
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
  return nowMs;
}

function nextOpenWindow(candidateMs, nowMs) {
  const now = new Date(nowMs);
  if (!isSearchWindowOpen(nowMs)) return nextSearchWindowAt(nowMs);
  const candidate = new Date(candidateMs);
  if (candidate.getDate() !== now.getDate() || candidate.getHours() >= 23) {
    const morning = new Date(now);
    morning.setDate(morning.getDate() + 1);
    morning.setHours(8, 0, 0, 0);
    return morning.getTime();
  }
  return candidateMs;
}

function randomMinuteDelay(nowMs, minimum, spread, random) {
  const ratio = Math.min(1, Math.max(0, Number(random()) || 0));
  const minutes = minimum + Math.min(spread, Math.floor(ratio * (spread + 1)));
  return nextOpenWindow(nowMs + minutes * 60_000, nowMs);
}

export function nextFirstSearchAt(nowMs = Date.now(), random = Math.random) {
  return randomMinuteDelay(nowMs, 1, 2, random);
}

export function nextRegularSearchAt(nowMs = Date.now(), random = Math.random) {
  return randomMinuteDelay(nowMs, 25, 10, random);
}

export function nextSearchRetryAt(nowMs = Date.now(), failureCount = 1, blocked = false) {
  const delays = [5, 10, 20, 30];
  const index = Math.min(Math.max(Math.floor(Number(failureCount)) || 1, 1), delays.length) - 1;
  const minutes = blocked ? 60 : delays[index];
  return nextOpenWindow(nowMs + minutes * 60_000, nowMs);
}

export function recoverSearchAutopilotState(raw) {
  const base = createSearchAutopilotState();
  const source = raw && typeof raw === 'object' ? raw : {};
  const choisi = source.activationVersion === ACTIVATION_VERSION;
  let options;
  try {
    const saved = source.options && typeof source.options === 'object' ? source.options : {};
    const urlsRecherche = Object.hasOwn(saved, 'urlsRecherche') ? saved.urlsRecherche
      : saved.urlRecherche === undefined ? base.options.urlsRecherche : undefined;
    options = normalizeSearchOptions({ ...base.options, ...saved, urlsRecherche,
      ...(choisi ? {} : { force: false, contactAuto: false }) });
  } catch {
    options = { ...base.options, urlsRecherche: [...base.options.urlsRecherche] };
  }
  const enabled = choisi && source.enabled === true;
  const failureCount = Number.isFinite(Number(source.failureCount)) && Number(source.failureCount) >= 0
    ? Math.floor(Number(source.failureCount)) : 0;
  const state = {
    ...base,
    ...source,
    activationVersion: ACTIVATION_VERSION,
    enabled,
    intervalMinutes: 30,
    failureCount,
    options,
    nextRunAt: Number.isFinite(Number(source.nextRunAt)) && Number(source.nextRunAt) > 0
      ? Number(source.nextRunAt) : null,
  };
  if (!enabled) return { ...state, status: 'paused', nextRunAt: null };
  if (source.status === 'running' || source.status === 'paused') {
    return { ...state, status: 'retrying', failureCount: failureCount + 1, nextRunAt: null };
  }
  if (['idle', 'retrying', 'blocked', 'suspended'].includes(source.status)) return state;
  return { ...state, status: 'idle' };
}
