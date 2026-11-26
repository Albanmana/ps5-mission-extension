import assert from 'node:assert/strict';
import test from 'node:test';

import { jitteredDelay, createSerialQueue, createParallelQueue } from '../extension/sw/queues.js';

test('jitteredDelay reste dans les bornes', () => {
  assert.equal(jitteredDelay(3000, 6000, () => 0), 3000);
  assert.equal(jitteredDelay(3000, 6000, () => 1), 6000);
  assert.equal(jitteredDelay(3000, 6000, () => 0.5), 4500);
});

test('jitteredDelay refuse un intervalle inversé', () => {
  assert.throws(() => jitteredDelay(6000, 3000, () => 0), /maxMs/);
});

test('la file série exécute dans l\'ordre et espace les tâches', async () => {
  const delays = [];
  const order = [];
  const queue = createSerialQueue({
    minDelayMs: 3000,
    maxDelayMs: 6000,
    sleep: async (ms) => { delays.push(ms); },
    random: () => 0.5,
  });

  await Promise.all([
    queue.push(async () => { order.push('a'); }),
    queue.push(async () => { order.push('b'); }),
    queue.push(async () => { order.push('c'); }),
  ]);

  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(delays, [4500, 4500]);
});

test('une tâche qui échoue ne bloque pas la file', async () => {
  const order = [];
  const queue = createSerialQueue({ minDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });

  const failed = queue.push(async () => { throw new Error('boum'); });
  const after = queue.push(async () => { order.push('suivante'); });

  await assert.rejects(failed, /boum/);
  await after;
  assert.deepEqual(order, ['suivante']);
});

test('pause arrête la file, resume la relance', async () => {
  const order = [];
  const queue = createSerialQueue({ minDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });

  queue.push(async () => { order.push('a'); queue.pause(); });
  const second = queue.push(async () => { order.push('b'); });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ['a']);
  assert.equal(queue.size, 1);
  assert.equal(queue.paused, true);

  queue.resume();
  assert.equal(queue.paused, false);
  await second;
  assert.deepEqual(order, ['a', 'b']);
});

test('clear vide les tâches en attente et règle leurs promesses', async () => {
  const queue = createSerialQueue({ minDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });
  queue.pause();
  const first = queue.push(async () => {});
  const second = queue.push(async () => {});
  assert.equal(queue.size, 2);

  queue.clear();
  assert.equal(queue.size, 0);
  await assert.rejects(first, /Queue cleared/);
  await assert.rejects(second, /Queue cleared/);
});

test('clear reste sûr pour les tâches ajoutées sans attendre leur promesse', async () => {
  const queue = createSerialQueue({ minDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });
  queue.pause();

  queue.push(async () => {});
  queue.clear();

  await new Promise((resolve) => setImmediate(resolve));
});

test('la file parallèle ne dépasse jamais sa concurrence', async () => {
  let active = 0;
  let maxActive = 0;
  const queue = createParallelQueue({ concurrency: 3 });

  const tasks = Array.from({ length: 10 }, () => queue.push(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  }));

  await Promise.all(tasks);
  assert.equal(maxActive, 3);
  assert.equal(queue.active, 0);
  assert.equal(queue.size, 0);
});
