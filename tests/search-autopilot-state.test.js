import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SEARCH_OPTIONS,
  createSearchAutopilotState,
  nextFirstSearchAt,
  nextRegularSearchAt,
  nextSearchRetryAt,
  normalizeSearchOptions,
  recoverSearchAutopilotState,
} from '../extension/sw/search-autopilot-state.js';

const CANONICAL_URL = 'https://www.leboncoin.fr/recherche?category=43&text=ps5&price=250-400'
  + '&transaction_status=search__no_value&item_condition=7%2C3%2C2%2C1&video_game_type=console'
  + '&owner_type=private&sort=time&order=desc';

test('l’autopilote de recherche est désactivé par défaut, sans contact ni réanalyse forcée', () => {
  assert.deepEqual(createSearchAutopilotState(), {
    activationVersion: 2,
    enabled: false,
    status: 'paused',
    intervalMinutes: 30,
    nextRunAt: null,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    failureCount: 0,
    options: {
      urlsRecherche: [CANONICAL_URL],
      maxPages: 3,
      maxResultats: 200,
      maxFiches: 50,
      force: false,
      contactAuto: false,
    },
  });
  assert.notEqual(createSearchAutopilotState().options, DEFAULT_SEARCH_OPTIONS);
});

test('les options sont normalisées et une page explicite est supprimée', () => {
  assert.deepEqual(normalizeSearchOptions({
    urlRecherche: `${CANONICAL_URL}&page=8`,
    maxPages: '4',
    maxResultats: '120',
    maxFiches: '30',
    force: 1,
    contactAuto: true,
  }), {
    urlsRecherche: [CANONICAL_URL],
    maxPages: 4,
    maxResultats: 120,
    maxFiches: 30,
    force: false,
    contactAuto: true,
  });
  assert.throws(() => normalizeSearchOptions({ ...DEFAULT_SEARCH_OPTIONS, maxPages: 0 }), /invalides/i);
  assert.throws(() => normalizeSearchOptions({ ...DEFAULT_SEARCH_OPTIONS,
    urlsRecherche: ['https://example.com/'] }), /invalides/i);
});

test('plusieurs recherches sont normalisées et dédupliquées dans leur ordre', () => {
  const autre = 'https://www.leboncoin.fr/recherche?text=ps5+slim';
  assert.deepEqual(normalizeSearchOptions({
    urlsRecherche: [`${CANONICAL_URL}&page=4`, autre, CANONICAL_URL],
    maxPages: 2, maxResultats: 20, maxFiches: 5,
  }), {
    urlsRecherche: [CANONICAL_URL, autre],
    maxPages: 2, maxResultats: 20, maxFiches: 5,
    force: false, contactAuto: false,
  });
});

test('une URL historique devient une liste et les listes invalides sont refusées', () => {
  const base = { maxPages: 2, maxResultats: 20, maxFiches: 5 };
  assert.deepEqual(normalizeSearchOptions({ ...base, urlRecherche: CANONICAL_URL }).urlsRecherche, [CANONICAL_URL]);
  for (const urlsRecherche of [[], [CANONICAL_URL, 'https://example.com/recherche'],
    Array.from({ length: 11 }, (_, i) => `${CANONICAL_URL}&q=${i}`)]) {
    assert.throws(() => normalizeSearchOptions({ ...base, urlsRecherche }), /invalides/i);
  }
});

test('la reprise migre les options historiques en liste', () => {
  const etat = recoverSearchAutopilotState({
    status: 'idle', options: { urlRecherche: `${CANONICAL_URL}&page=3`, maxPages: 2,
      maxResultats: 20, maxFiches: 5, force: false, contactAuto: false },
  });
  assert.deepEqual(etat.options.urlsRecherche, [CANONICAL_URL]);
  assert.equal('urlRecherche' in etat.options, false);
});

test('la première exécution varie de 1 à 3 minutes et les suivantes de 25 à 35 minutes', () => {
  const now = new Date(2026, 8, 26, 10, 0, 0, 0).getTime();
  assert.equal(nextFirstSearchAt(now, () => 0), now + 60_000);
  assert.equal(nextFirstSearchAt(now, () => 0.999999), now + 3 * 60_000);
  assert.equal(nextRegularSearchAt(now, () => 0), now + 25 * 60_000);
  assert.equal(nextRegularSearchAt(now, () => 0.999999), now + 35 * 60_000);
});

test('les reprises suivent 5, 10, 20 puis 30 minutes et un blocage attend 60 minutes', () => {
  const now = new Date(2026, 8, 26, 10, 0, 0, 0).getTime();
  assert.equal(nextSearchRetryAt(now, 1, false), now + 5 * 60_000);
  assert.equal(nextSearchRetryAt(now, 2, false), now + 10 * 60_000);
  assert.equal(nextSearchRetryAt(now, 3, false), now + 20 * 60_000);
  assert.equal(nextSearchRetryAt(now, 4, false), now + 30 * 60_000);
  assert.equal(nextSearchRetryAt(now, 99, false), now + 30 * 60_000);
  assert.equal(nextSearchRetryAt(now, 1, true), now + 60 * 60_000);
});

test('toute échéance hors de 08:00–22:59 est reportée au prochain 08:00', () => {
  const before = new Date(2026, 8, 26, 6, 30, 0, 0).getTime();
  const sameMorning = new Date(2026, 8, 26, 8, 0, 0, 0).getTime();
  const late = new Date(2026, 8, 26, 22, 50, 0, 0).getTime();
  const nextMorning = new Date(2026, 8, 27, 8, 0, 0, 0).getTime();
  assert.equal(nextFirstSearchAt(before, () => 0.5), sameMorning);
  assert.equal(nextRegularSearchAt(late, () => 1), nextMorning);
  assert.equal(nextSearchRetryAt(late, 1, true), nextMorning);
});

test('seule une désactivation explicite revient en pause au redémarrage', () => {
  const recovered = recoverSearchAutopilotState({
    ...createSearchAutopilotState(),
    enabled: false,
    status: 'retrying',
    nextRunAt: 1234,
  });
  assert.equal(recovered.enabled, false);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.nextRunAt, null);
});

test('une exécution interrompue reprend en retry sans perdre les options', () => {
  const recovered = recoverSearchAutopilotState({
    ...createSearchAutopilotState(),
    enabled: true,
    status: 'running',
    failureCount: 2,
    nextRunAt: 4567,
    options: { ...DEFAULT_SEARCH_OPTIONS, maxPages: 7 },
  });
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.status, 'retrying');
  assert.equal(recovered.failureCount, 3);
  assert.equal(recovered.nextRunAt, null);
  assert.equal(recovered.options.maxPages, 7);
});

test('un état idle, retrying ou bloqué conserve son échéance valide au redémarrage', () => {
  for (const status of ['idle', 'retrying', 'blocked']) {
    const recovered = recoverSearchAutopilotState({
      ...createSearchAutopilotState(), enabled: true, status, nextRunAt: 9876,
    });
    assert.equal(recovered.status, status);
    assert.equal(recovered.nextRunAt, 9876);
  }
});

test('un état stocké sans activationVersion 2 est désactivé et ses automatismes remis à zéro', () => {
  for (const raw of [undefined, { enabled: true, status: 'idle', nextRunAt: 1234,
    options: { ...DEFAULT_SEARCH_OPTIONS, maxPages: 7, force: true, contactAuto: true } },
  { activationVersion: 1, enabled: true, status: 'running' }]) {
    const recovered = recoverSearchAutopilotState(raw);
    assert.equal(recovered.activationVersion, 2);
    assert.equal(recovered.enabled, false);
    assert.equal(recovered.status, 'paused');
    assert.equal(recovered.nextRunAt, null);
    assert.equal(recovered.options.force, false);
    assert.equal(recovered.options.contactAuto, false);
    if (raw?.options) assert.equal(recovered.options.maxPages, 7);
  }
});
