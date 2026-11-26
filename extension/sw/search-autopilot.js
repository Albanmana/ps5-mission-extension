import { recherchesReussies, pauseParUtilisateur } from './run-state.js';
import {
  SEARCH_AUTOPILOT_ALARM,
  SEARCH_AUTOPILOT_STATE_KEY,
  nextFirstSearchAt,
  nextRegularSearchAt,
  nextSearchRetryAt,
  nextSearchWindowAt,
  isSearchWindowOpen,
  normalizeSearchOptions,
  recoverSearchAutopilotState,
} from './search-autopilot-state.js';

export function createSearchAutopilot({
  chrome,
  run,
  now = Date.now,
  random = Math.random,
  logger = { log() {}, logErreur() {} },
}) {
  let state = null;
  let initialization = null;
  let active = null;
  let mutations = Promise.resolve();

  function serialize(operation) {
    const result = mutations.then(operation, operation);
    mutations = result.catch(() => {});
    return result;
  }

  async function persist(next) {
    state = next;
    await chrome.storage.local.set({ [SEARCH_AUTOPILOT_STATE_KEY]: state });
    await chrome.runtime.sendMessage({ type: 'recherche-auto-maj', etat: state }).catch(() => {});
    return state;
  }

  async function clearAlarmLocked() {
    await chrome.alarms.clear(SEARCH_AUTOPILOT_ALARM);
  }

  async function scheduleLocked(when, status) {
    if (!state.enabled) return persist({ ...state, status: 'paused', nextRunAt: null });
    await persist({ ...state, status, nextRunAt: when });
    await chrome.alarms.create(SEARCH_AUTOPILOT_ALARM, { when });
    return state;
  }

  // Run mis en pause par l’utilisateur : aucune échéance tant qu’il n’a pas
  // choisi Reprendre ou Stop.
  async function suspendreLocked(patch = {}) {
    await clearAlarmLocked();
    return persist({ ...state, ...patch, status: 'suspended', nextRunAt: null });
  }

  const runRetenu = async () => pauseParUtilisateur(await run.lireEtat());

  async function initialiser() {
    initialization ??= (async () => {
      const stored = (await chrome.storage.local.get(SEARCH_AUTOPILOT_STATE_KEY))[SEARCH_AUTOPILOT_STATE_KEY];
      state = recoverSearchAutopilotState(stored);
      if (!state.enabled) {
        await clearAlarmLocked();
        return persist(state);
      }
      if (await runRetenu()) return suspendreLocked();
      if (!state.nextRunAt) {
        const when = state.status === 'retrying' || state.status === 'blocked'
          ? nextSearchRetryAt(now(), Math.max(1, state.failureCount), state.status === 'blocked')
          : nextFirstSearchAt(now(), random);
        return scheduleLocked(when, state.status === 'blocked' ? 'blocked' : state.status === 'retrying' ? 'retrying' : 'idle');
      }
      const nowMs = now();
      const nextWindow = nextSearchWindowAt(nowMs);
      if (!isSearchWindowOpen(nowMs) && state.nextRunAt < nextWindow) {
        return scheduleLocked(nextWindow, state.status);
      }
      const alarm = await chrome.alarms.get(SEARCH_AUTOPILOT_ALARM);
      if (!alarm || Number(alarm.scheduledTime) !== Number(state.nextRunAt)) {
        await chrome.alarms.create(SEARCH_AUTOPILOT_ALARM, { when: state.nextRunAt });
      }
      return persist(state);
    })();
    return initialization;
  }

  async function finishLocked(error = null) {
    let runState = null;
    try { runState = await run.lireEtat(); } catch (readError) { error ??= readError; }
    const blocked = runState?.statut === 'bloque';
    const successful = !error && runState?.statut === 'termine' && recherchesReussies(runState) > 0;
    if (!state.enabled) {
      await clearAlarmLocked();
      return persist({
        ...state,
        status: 'paused',
        nextRunAt: null,
        lastResult: successful ? 'completed' : blocked ? 'blocked' : 'failed',
        lastError: successful ? null : String(error?.message ?? runState?.erreur ?? 'Échec de la recherche.'),
      });
    }
    if (pauseParUtilisateur(runState)) return suspendreLocked();
    // Stop n’est pas une panne : échéance ordinaire, sans nouvel essai rapproché.
    if (runState?.statut === 'termine' && runState.arretUtilisateur) {
      state = { ...state, failureCount: 0, lastResult: 'stopped', lastError: null };
      return scheduleLocked(nextRegularSearchAt(now(), random), 'idle');
    }
    if (successful) {
      state = { ...state, status: 'idle', failureCount: 0, lastResult: 'completed', lastError: null, nextRunAt: null };
      return scheduleLocked(nextRegularSearchAt(now(), random), 'idle');
    }
    const failureCount = state.failureCount + 1;
    state = {
      ...state,
      status: blocked ? 'blocked' : 'retrying',
      failureCount,
      lastResult: blocked ? 'blocked' : 'failed',
      lastError: String(error?.message ?? runState?.erreur ?? 'Échec de la recherche.'),
      nextRunAt: null,
    };
    return scheduleLocked(nextSearchRetryAt(now(), failureCount, blocked), state.status);
  }

  async function startLocked(normalized, automatic) {
    if (active) throw new Error('Une recherche est déjà active ou en cours de lancement.');
    try {
      if (automatic) {
        const current = await run.lireEtat();
        if (['en_cours', 'pause', 'bloque'].includes(current?.statut)) await run.arreter();
      }
      await clearAlarmLocked();
      await persist({
        ...state,
        options: normalized,
        status: 'running',
        nextRunAt: null,
        lastRunAt: now(),
        lastError: null,
      });
      const started = await run.demarrer(normalized, { automatic });
      let completion;
      const settle = (error) => serialize(async () => {
        try {
          return await finishLocked(error);
        } finally {
          if (active === completion) active = null;
        }
      });
      completion = Promise.resolve(started.termine)
        .then(() => settle(null), (error) => settle(error))
        .catch((error) => {
          logger.logErreur('recherche-auto:finalisation_echec', error);
          return state;
        });
      active = completion;
      return { etat: started.etat, termine: completion };
    } catch (error) {
      await finishLocked(error);
      throw error;
    }
  }

  async function demarrerManuellement(options) {
    await initialiser();
    return serialize(async () => {
      const normalized = normalizeSearchOptions(options);
      if (state.enabled) await persist({ ...state, options: normalized });
      const started = await startLocked(normalized, false);
      return { etat: started.etat };
    });
  }

  return {
    initialiser,
    async lireEtat() { await initialiser(); return serialize(() => state); },
    async configurer(options) {
      await initialiser();
      return serialize(() => persist({ ...state, options: normalizeSearchOptions(options) }));
    },
    async activer(enabled, options) {
      await initialiser();
      return serialize(async () => {
        if (enabled === false) {
          await run.couperContactAutomatique();
          await clearAlarmLocked();
          return persist({ ...state, enabled: false, status: 'paused', nextRunAt: null });
        }
        const normalized = options ? normalizeSearchOptions(options) : state.options;
        state = { ...state, enabled: true, status: active ? 'running' : 'idle', options: normalized };
        if (await runRetenu()) return suspendreLocked();
        if (active) return persist(state);
        return scheduleLocked(nextFirstSearchAt(now(), random), 'idle');
      });
    },
    async planifierApresPause() {
      await initialiser();
      return serialize(async () => (state.enabled && await runRetenu() ? suspendreLocked() : state));
    },
    // Après Reprendre ou Stop.
    async relancerApresDecision() {
      await initialiser();
      return serialize(async () => {
        if (!state.enabled) return state;
        if (await runRetenu()) return suspendreLocked();
        return scheduleLocked(nextRegularSearchAt(now(), random), active ? 'running' : 'idle');
      });
    },
    demarrerManuellement,
    async onAlarm(alarm) {
      await initialiser();
      const decision = await serialize(async () => {
        if (alarm?.name !== SEARCH_AUTOPILOT_ALARM || !state.enabled
          || Number(alarm.scheduledTime) !== Number(state.nextRunAt)) return null;
        if (!isSearchWindowOpen(now())) {
          await scheduleLocked(nextSearchWindowAt(now()), state.status);
          return null;
        }
        const current = await run.lireEtat();
        if (pauseParUtilisateur(current)) {
          await suspendreLocked();
          return null;
        }
        // Run repris hors de ce suivi (service worker redémarré) : on le laisse finir.
        if (!active && current?.statut === 'en_cours') {
          await scheduleLocked(nextRegularSearchAt(now(), random), 'idle');
          return null;
        }
        if (active) {
          if (current?.statut === 'pause') {
            const previous = active;
            await run.arreter();
            return { completion: previous, restart: true };
          }
          return { completion: active, restart: false };
        }
        const started = await startLocked(state.options, true);
        return { completion: started.termine, restart: false };
      });
      if (!decision) return state;
      await decision.completion;
      if (decision.restart) {
        const restarted = await serialize(async () => {
          if (!state.enabled || active) return { completion: active };
          if (await runRetenu()) { await suspendreLocked(); return { completion: null }; }
          return { completion: (await startLocked(state.options, true)).termine };
        });
        if (restarted.completion) await restarted.completion;
      }
      return state;
    },
  };
}
