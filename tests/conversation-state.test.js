import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addProcessedFingerprint,
  createConversationState,
  nextConversationAlarmAt,
  nextConversationRetryAt,
  observeConversationPreview,
  recoverConversationState,
} from '../extension/sw/conversation-state.js';

test('l’autopilote est désactivé par défaut', () => {
  assert.deepEqual(createConversationState(), {
    activationVersion: 2,
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
  });
});

test('les aperçus observés sont persistés et bornés aux 500 plus récents', () => {
  let state = createConversationState();
  const firstUrl = 'https://www.leboncoin.fr/messages/id/aaaaaaaaaaaaaaa0';
  for (let index = 0; index < 505; index += 1) {
    state = observeConversationPreview(state, {
      url_conversation: `https://www.leboncoin.fr/messages/id/${String(index).padStart(16, 'a')}`,
      preview: `message ${index}`,
    }, index);
  }
  assert.equal(Object.keys(state.observedPreviews).length, 500);
  assert.equal(state.observedPreviews[firstUrl], undefined);
  assert.deepEqual(state.observedPreviews[`https://www.leboncoin.fr/messages/id/${String(504).padStart(16, 'a')}`], {
    preview: 'message 504', observedAt: 504,
  });
});

test('la prochaine alarme varie de 7 à 13 minutes dans la plage active', () => {
  const now = new Date('2026-09-26T10:00:00+02:00').getTime();
  assert.equal(nextConversationAlarmAt(now, () => 0), now + 7 * 60_000);
  assert.equal(nextConversationAlarmAt(now, () => 0.999999), now + 13 * 60_000 - 1);
});

test('hors horaires la prochaine alarme attend 08:00 heure locale', () => {
  const atNight = new Date(2026, 8, 26, 23, 30, 0, 0).getTime();
  const expected = new Date(2026, 8, 27, 8, 0, 0, 0).getTime();
  assert.equal(nextConversationAlarmAt(atNight, () => 0.5), expected);
  const before = new Date(2026, 8, 26, 6, 30, 0, 0).getTime();
  assert.equal(nextConversationAlarmAt(before, () => 0.5), new Date(2026, 8, 26, 8, 0, 0, 0).getTime());
});

test('une alarme aléatoire qui dépasserait 23:00 est reportée au lendemain 08:00', () => {
  const late = new Date('2026-09-26T22:55:00+02:00');
  const next = new Date(nextConversationAlarmAt(late.getTime(), () => 1));
  assert.equal(next.getDate(), 27);
  assert.equal(next.getHours(), 8);
  assert.equal(next.getMinutes(), 0);
});

test('les fingerprints traités sont bornés aux 500 plus récents', () => {
  let state = createConversationState();
  for (let index = 0; index < 505; index += 1) {
    state = addProcessedFingerprint(state, String(index).padStart(3, '0'), index);
  }
  assert.equal(Object.keys(state.processedFingerprints).length, 500);
  assert.equal(state.processedFingerprints['000'], undefined);
  assert.equal(state.processedFingerprints['504'], 504);
});

test('les reprises ordinaires augmentent jusqu’à 30 minutes et les blocages attendent une heure', () => {
  const now = new Date('2026-09-26T10:00:00+02:00').getTime();
  assert.equal(nextConversationRetryAt(now, 1, false), now + 2 * 60_000);
  assert.equal(nextConversationRetryAt(now, 2, false), now + 5 * 60_000);
  assert.equal(nextConversationRetryAt(now, 99, false), now + 30 * 60_000);
  assert.equal(nextConversationRetryAt(now, 1, true), now + 60 * 60_000);
});

test('une reprise qui dépasserait la plage active attend le lendemain à 08:00', () => {
  const late = new Date(2026, 8, 26, 22, 45, 0, 0).getTime();
  assert.equal(
    nextConversationRetryAt(late, 99, false),
    new Date(2026, 8, 27, 8, 0, 0, 0).getTime(),
  );
});

test('un état d’une ancienne version avec un tour réservé le consomme : l’envoi a pu partir', () => {
  const { envoiTente: _absent, ...ancien } = createConversationState();
  const recovered = recoverConversationState({
    ...ancien, enabled: true, status: 'running', processingFingerprint: 'abc',
  }, 1234);
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.status, 'retrying');
  assert.equal(recovered.lastError, 'resultat_incertain');
  assert.equal(recovered.lastResult, 'requires_review');
  assert.equal(recovered.processingFingerprint, null);
  assert.equal(recovered.processedFingerprints.abc, 1234);
  assert.equal(recovered.nextRunAt, null);
});

test('un tour interrompu avant l’envoi n’est pas consommé et sa libération est mise en attente', () => {
  const recovered = recoverConversationState({
    ...createConversationState(), enabled: true, status: 'running',
    processingFingerprint: 'abc', processingUrl: 'u',
  }, 1234);
  assert.equal(recovered.status, 'retrying');
  assert.equal(recovered.processingFingerprint, null);
  assert.deepEqual(recovered.processedFingerprints, {});
  assert.equal(recovered.observedPreviews.u.preview, null);
  assert.deepEqual(recovered.aSignaler.u, { fingerprint: 'abc', code: 'generation_echec' });
});

test('un état bloqué reste activé et bloqué au redémarrage', () => {
  const recovered = recoverConversationState({
    ...createConversationState(), enabled: true, status: 'blocked', lastError: 'bloque', nextRunAt: 4567,
  });
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.lastError, 'bloque');
  assert.equal(recovered.nextRunAt, 4567);
});

test('les finalisations handoff en attente sont normalisées et conservées', () => {
  const recovered = recoverConversationState({
    ...createConversationState(), pendingHandled: {
      'https://www.leboncoin.fr/messages/id/abc': 'fingerprint-1',
    },
  });
  assert.deepEqual(recovered.pendingHandled, {
    'https://www.leboncoin.fr/messages/id/abc': 'fingerprint-1',
  });
  assert.deepEqual(recoverConversationState({ ...createConversationState(), pendingHandled: null }).pendingHandled, {});
});

test('seul un choix utilisateur désactivé revient en pause au redémarrage', () => {
  const recovered = recoverConversationState({
    ...createConversationState(), enabled: false, status: 'retrying', lastError: 'generation_echec',
  });
  assert.equal(recovered.enabled, false);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.nextRunAt, null);
});

test('un état sans activationVersion 2 est désactivé mais garde sa mémoire', () => {
  const recovered = recoverConversationState({ enabled: true, status: 'idle', processedFingerprints: { a: 1 } });
  assert.equal(recovered.enabled, false);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.activationVersion, 2);
  assert.deepEqual(recovered.processedFingerprints, { a: 1 });
});

test('un envoi tenté est consommé et affiché au redémarrage même en pause', () => {
  const recovered = recoverConversationState({
    ...createConversationState(), processingFingerprint: 'abc',
    envoiTente: { url_conversation: 'u', fingerprint: 'abc', vendeur: 'V', brouillon: 'ok', cree_le: 5 },
  }, 9);
  assert.equal(recovered.processingFingerprint, null);
  assert.equal(recovered.envoiTente, null);
  assert.equal(recovered.processedFingerprints.abc, 9);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.handoffs.abc.raison, 'envoi_incertain');
  assert.equal(recovered.handoffs.abc.url_conversation, 'u');
  assert.equal(recovered.handoffs.abc.enregistre, true);
  assert.deepEqual(recovered.aSignaler.u, { fingerprint: 'abc', code: 'envoi_incertain' });
});
