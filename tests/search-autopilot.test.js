import assert from 'node:assert/strict';
import test from 'node:test';

import { createSearchAutopilot } from '../extension/sw/search-autopilot.js';
import {
  DEFAULT_SEARCH_OPTIONS,
  SEARCH_AUTOPILOT_ALARM,
  SEARCH_AUTOPILOT_STATE_KEY,
  createSearchAutopilotState,
} from '../extension/sw/search-autopilot-state.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const actif = () => ({ ...createSearchAutopilotState(), enabled: true, status: 'idle' });

function fixture({ saved = actif(), alarm = null, clock = new Date(2026, 8, 26, 10, 0, 0, 0).getTime() } = {}) {
  let stored = saved ? structuredClone(saved) : null;
  let currentAlarm = alarm ? structuredClone(alarm) : null;
  let nowMs = clock;
  const created = [];
  const cleared = [];
  const messages = [];
  const starts = [];
  let runState = null;
  let currentCompletion = null;
  const completions = [];
  const chrome = {
    storage: { local: {
      get: async () => ({ [SEARCH_AUTOPILOT_STATE_KEY]: structuredClone(stored) }),
      set: async (payload) => { stored = structuredClone(payload[SEARCH_AUTOPILOT_STATE_KEY]); },
    } },
    alarms: {
      get: async (name) => name === SEARCH_AUTOPILOT_ALARM ? structuredClone(currentAlarm) : null,
      create: async (name, options) => {
        currentAlarm = { name, scheduledTime: options.when };
        created.push(structuredClone(currentAlarm));
      },
      clear: async (name) => { cleared.push(name); currentAlarm = null; return true; },
    },
    runtime: { sendMessage: async (message) => { messages.push(structuredClone(message)); } },
  };
  const arrets = [];
  const coupures = [];
  const run = {
    lireEtat: async () => structuredClone(runState),
    couperContactAutomatique: async () => { coupures.push(structuredClone(runState)); },
    arreter: async () => {
      arrets.push(structuredClone(runState));
      if (runState) runState.statut = 'termine';
      currentCompletion?.resolve();
    },
    demarrer: async (options, mode) => {
      const completion = deferred();
      currentCompletion = completion;
      completions.push(completion);
      runState = { statut: 'en_cours', ...structuredClone(options) };
      starts.push({ options: structuredClone(options), mode: structuredClone(mode) });
      return { etat: structuredClone(runState), termine: completion.promise };
    },
  };
  const autopilot = createSearchAutopilot({ chrome, run, now: () => nowMs, random: () => 0 });
  return {
    autopilot, chrome, run, arrets, coupures, setRun: (patch) => { runState = { ...runState, ...patch }; },
    starts, created, cleared, messages, completions,
    stored: () => structuredClone(stored),
    alarm: () => structuredClone(currentAlarm),
    setNow: (value) => { nowMs = value; },
    setRunStatus: (statut) => { runState = { ...runState, statut }; },
    setSearches: (recherches) => { runState = { ...runState, recherches }; },
    complete(index = completions.length - 1, statut = 'termine') {
      runState = { ...runState, statut };
      completions[index].resolve();
    },
    fail(error, statut = 'pause', index = completions.length - 1) {
      runState = { ...runState, statut, erreur: error.message };
      completions[index].reject(error);
    },
  };
}

test('une installation neuve ne planifie rien tant que l’autopilote n’est pas activé', async () => {
  const f = fixture({ saved: null });
  const state = await f.autopilot.initialiser();
  assert.equal(state.enabled, false);
  assert.equal(state.nextRunAt, null);
  assert.equal(f.alarm(), null);
});

test('un état activé sans échéance planifie le premier run une minute plus tard', async () => {
  const f = fixture();
  const state = await f.autopilot.initialiser();
  assert.equal(state.enabled, true);
  assert.equal(state.status, 'idle');
  assert.equal(state.nextRunAt, new Date(2026, 8, 26, 10, 1, 0, 0).getTime());
  assert.deepEqual(f.alarm(), { name: SEARCH_AUTOPILOT_ALARM, scheduledTime: state.nextRunAt });
  assert.deepEqual(state.options, DEFAULT_SEARCH_OPTIONS);
});

test('un redémarrage restaure exactement l’échéance persistée', async () => {
  const due = new Date(2026, 8, 26, 10, 17, 0, 0).getTime();
  const f = fixture({ saved: { ...actif(), nextRunAt: due } });
  await f.autopilot.initialiser();
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].scheduledTime, due);
});

test('un redémarrage de nuit reporte une échéance dépassée au prochain 08:00', async () => {
  const due = new Date(2026, 8, 26, 22, 55, 0, 0).getTime();
  const night = new Date(2026, 8, 26, 23, 10, 0, 0).getTime();
  const nextMorning = new Date(2026, 8, 27, 8, 0, 0, 0).getTime();
  const f = fixture({
    clock: night,
    saved: { ...actif(), nextRunAt: due },
    alarm: { name: SEARCH_AUTOPILOT_ALARM, scheduledTime: due },
  });
  const state = await f.autopilot.initialiser();
  assert.equal(state.nextRunAt, nextMorning);
  assert.equal(f.alarm().scheduledTime, nextMorning);
  assert.equal(f.starts.length, 0);
});

test('une alarme périmée est ignorée sans démarrer de recherche', async () => {
  const f = fixture();
  const state = await f.autopilot.initialiser();
  await f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: state.nextRunAt - 1 });
  assert.equal(f.starts.length, 0);
});

test('une alarme due mais livrée après 23:00 attend le prochain 08:00', async () => {
  const due = new Date(2026, 8, 26, 22, 55, 0, 0).getTime();
  const f = fixture({
    clock: new Date(2026, 8, 26, 22, 50, 0, 0).getTime(),
    saved: { ...actif(), nextRunAt: due },
    alarm: { name: SEARCH_AUTOPILOT_ALARM, scheduledTime: due },
  });
  await f.autopilot.initialiser();
  f.setNow(new Date(2026, 8, 26, 23, 10, 0, 0).getTime());
  const state = await f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: due });
  assert.equal(f.starts.length, 0);
  assert.equal(state.nextRunAt, new Date(2026, 8, 27, 8, 0, 0, 0).getTime());
  assert.equal(f.alarm().scheduledTime, state.nextRunAt);
});

test('un run automatique réussi programme le suivant 25 minutes après sa fin', async () => {
  const f = fixture();
  const initial = await f.autopilot.initialiser();
  const running = f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: initial.nextRunAt });
  await tick();
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.starts[0], { options: DEFAULT_SEARCH_OPTIONS, mode: { automatic: true } });
  const finishedAt = new Date(2026, 8, 26, 10, 7, 0, 0).getTime();
  f.setNow(finishedAt);
  f.complete();
  await running;
  assert.equal(f.stored().status, 'idle');
  assert.equal(f.stored().failureCount, 0);
  assert.equal(f.stored().nextRunAt, finishedAt + 25 * 60_000);
});

test('deux alarmes concurrentes ne créent jamais deux runs', async () => {
  const f = fixture();
  const initial = await f.autopilot.initialiser();
  const first = f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: initial.nextRunAt });
  await tick();
  await f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: initial.nextRunAt });
  assert.equal(f.starts.length, 1);
  f.complete();
  await first;
});

for (const [statuses, expectedStatus, minutes] of [
  [['erreur', 'erreur'], 'retrying', 5],
  [['terminee', 'erreur'], 'idle', 25],
]) {
  test(`les recherches ${statuses.join('/')} planifient ${expectedStatus}`, async () => {
    const f = fixture();
    const initial = await f.autopilot.initialiser();
    const running = f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: initial.nextRunAt });
    await tick();
    f.setSearches(statuses.map((statut) => ({ statut })));
    f.complete();
    await running;
    assert.equal(f.stored().status, expectedStatus);
    assert.equal(f.stored().nextRunAt, new Date(2026, 8, 26, 10, 0, 0, 0).getTime() + minutes * 60_000);
  });
}

test('une panne conserve enabled et applique la reprise 5 minutes plus tard', async () => {
  const f = fixture();
  const initial = await f.autopilot.initialiser();
  const running = f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: initial.nextRunAt });
  await tick();
  const failedAt = new Date(2026, 8, 26, 10, 9, 0, 0).getTime();
  f.setNow(failedAt);
  f.fail(new Error('Serveur indisponible'));
  await running;
  assert.equal(f.stored().enabled, true);
  assert.equal(f.stored().status, 'retrying');
  assert.equal(f.stored().failureCount, 1);
  assert.equal(f.stored().nextRunAt, failedAt + 5 * 60_000);
});

test('un blocage conserve enabled et retente une heure plus tard', async () => {
  const f = fixture();
  const initial = await f.autopilot.initialiser();
  const running = f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: initial.nextRunAt });
  await tick();
  const blockedAt = new Date(2026, 8, 26, 10, 9, 0, 0).getTime();
  f.setNow(blockedAt);
  f.complete(0, 'bloque');
  await running;
  assert.equal(f.stored().enabled, true);
  assert.equal(f.stored().status, 'blocked');
  assert.equal(f.stored().nextRunAt, blockedAt + 60 * 60_000);
});

test('désactiver efface l’alarme et aucune échéance future ne subsiste', async () => {
  const f = fixture();
  await f.autopilot.initialiser();
  const state = await f.autopilot.activer(false);
  assert.equal(state.enabled, false);
  assert.equal(state.status, 'paused');
  assert.equal(state.nextRunAt, null);
  assert.equal(f.alarm(), null);
  assert.equal(f.cleared.at(-1), SEARCH_AUTOPILOT_ALARM);
});

test('un lancement manuel immédiat reste unique et reprogramme le cycle activé après sa fin', async () => {
  const f = fixture();
  await f.autopilot.initialiser();
  const custom = { ...DEFAULT_SEARCH_OPTIONS, maxPages: 5, force: true };
  const response = await f.autopilot.demarrerManuellement(custom);
  assert.equal(response.etat.statut, 'en_cours');
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.starts[0].mode, { automatic: false });
  await assert.rejects(f.autopilot.demarrerManuellement(custom), /cours|active/i);
  f.complete();
  await tick();
  await tick();
  assert.equal(f.stored().options.maxPages, 5);
  assert.equal(f.stored().status, 'idle');
  assert.ok(f.stored().nextRunAt);
});

test('à son échéance un run suspendu par une erreur est arrêté puis remplacé par un run automatique frais', async () => {
  const f = fixture();
  await f.autopilot.initialiser();
  await f.autopilot.demarrerManuellement(DEFAULT_SEARCH_OPTIONS);
  f.setRun({ statut: 'pause', pauseUtilisateur: false, erreur: 'Serveur indisponible' });
  const initial = f.stored();
  const due = initial.nextRunAt ?? (await f.autopilot.relancerApresDecision()).nextRunAt;
  f.setNow(due);
  const alarm = f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: due });
  for (let index = 0; index < 10 && f.starts.length < 2; index += 1) await tick();
  assert.equal(f.starts.length, 2);
  assert.deepEqual(f.starts[1].mode, { automatic: true });
  f.complete(1);
  await alarm;
});

const userPause = { statut: 'pause', pauseUtilisateur: true, erreur: null };

test('une pause de l’utilisateur suspend l’autopilote : ni échéance, ni remplacement', async () => {
  const f = fixture();
  const initial = await f.autopilot.initialiser();
  await f.autopilot.demarrerManuellement(DEFAULT_SEARCH_OPTIONS);
  f.setRun(userPause);
  const paused = await f.autopilot.planifierApresPause();
  assert.equal(paused.enabled, true);
  assert.equal(paused.status, 'suspended');
  assert.equal(paused.nextRunAt, null);
  assert.equal(f.alarm(), null);
  await f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: initial.nextRunAt });
  await f.autopilot.activer(true);
  assert.equal(f.stored().status, 'suspended');
  assert.equal(f.alarm(), null);
  assert.equal(f.starts.length, 1);
  assert.equal(f.arrets.length, 0);
});

test('une échéance déjà programmée n’arrête ni ne remplace un run mis en pause par l’utilisateur', async () => {
  const f = fixture();
  const initial = await f.autopilot.initialiser();
  f.setRun(userPause);
  const state = await f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: initial.nextRunAt });
  assert.equal(state.status, 'suspended');
  assert.deepEqual([f.starts.length, f.arrets.length, f.alarm()], [0, 0, null]);
});

test('après un redémarrage la pause de l’utilisateur tient toujours', async () => {
  for (const patch of [userPause, { statut: 'pause', erreur: null }, { statut: 'bloque', pauseUtilisateur: true }]) {
    const f = fixture({ saved: { ...actif(), status: 'running' } });
    f.setRun(patch);
    const state = await f.autopilot.initialiser();
    assert.equal(state.status, 'suspended');
    assert.equal(f.alarm(), null);
  }
});

test('une exécution qui se termine sur un run en pause utilisateur ne planifie aucun nouvel essai', async () => {
  const f = fixture();
  await f.autopilot.initialiser();
  await f.autopilot.demarrerManuellement(DEFAULT_SEARCH_OPTIONS);
  f.setRun({ pauseUtilisateur: true });
  f.fail(new Error('Panne tardive'));
  await tick(); await tick();
  assert.equal(f.stored().status, 'suspended');
  assert.equal(f.alarm(), null);
});

test('Reprendre ou Stop reprogramment une échéance ordinaire', async () => {
  for (const patch of [{ statut: 'en_cours', pauseUtilisateur: false }, { statut: 'termine', arretUtilisateur: true }]) {
    const f = fixture();
    await f.autopilot.initialiser();
    f.setRun(userPause);
    await f.autopilot.planifierApresPause();
    f.setRun(patch);
    const state = await f.autopilot.relancerApresDecision();
    assert.equal(state.status, 'idle');
    assert.equal(state.nextRunAt, new Date(2026, 8, 26, 10, 25, 0, 0).getTime());
    assert.equal(f.alarm().scheduledTime, state.nextRunAt);
  }
});

test('Stop n’est pas une panne : pas de nouvel essai rapproché', async () => {
  const f = fixture();
  await f.autopilot.initialiser();
  await f.autopilot.demarrerManuellement(DEFAULT_SEARCH_OPTIONS);
  f.setRun({ arretUtilisateur: true });
  f.complete();
  await tick(); await tick();
  assert.equal(f.stored().status, 'idle');
  assert.equal(f.stored().failureCount, 0);
  assert.equal(f.stored().nextRunAt, new Date(2026, 8, 26, 10, 25, 0, 0).getTime());
});

test('un run repris et non suivi n’est pas arrêté par l’échéance suivante', async () => {
  const f = fixture();
  const initial = await f.autopilot.initialiser();
  f.setRun({ statut: 'en_cours' });
  const state = await f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: initial.nextRunAt });
  assert.deepEqual([f.starts.length, f.arrets.length], [0, 0]);
  assert.ok(state.nextRunAt > initial.nextRunAt);
});

test('désactiver coupe les envois automatiques du run en cours', async () => {
  const f = fixture();
  await f.autopilot.initialiser();
  await f.autopilot.activer(false);
  assert.equal(f.coupures.length, 1);
});

test('la fin d’un run repris en concurrence avec son alarme garde état et alarme alignés', async () => {
  const f = fixture();
  await f.autopilot.initialiser();
  await f.autopilot.demarrerManuellement(DEFAULT_SEARCH_OPTIONS);
  const pausedAt = new Date(2026, 8, 26, 10, 12, 0, 0).getTime();
  f.setNow(pausedAt);
  const paused = await f.autopilot.relancerApresDecision();
  f.setRunStatus('en_cours');
  f.setNow(paused.nextRunAt);
  const alarm = f.autopilot.onAlarm({ name: SEARCH_AUTOPILOT_ALARM, scheduledTime: paused.nextRunAt });
  await tick();
  assert.equal(f.starts.length, 1);
  f.setNow(paused.nextRunAt + 5 * 60_000);
  f.complete();
  await alarm;
  assert.equal(f.starts.length, 1);
  assert.equal(f.stored().nextRunAt, f.alarm().scheduledTime);
  assert.equal(f.stored().status, 'idle');
});

test('désactiver pendant la finalisation gagne la course et ne recrée aucune alarme', async () => {
  const f = fixture();
  await f.autopilot.initialiser();
  await f.autopilot.demarrerManuellement(DEFAULT_SEARCH_OPTIONS);
  const disabled = f.autopilot.activer(false);
  f.complete();
  await disabled;
  await tick();
  await tick();
  assert.equal(f.stored().enabled, false);
  assert.equal(f.stored().status, 'paused');
  assert.equal(f.stored().nextRunAt, null);
  assert.equal(f.alarm(), null);
});
