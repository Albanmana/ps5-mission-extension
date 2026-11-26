import assert from 'node:assert/strict';
import test from 'node:test';
import { SENT_LOG_KEY, SENT_LOG_MAX, consigner, createSentLog } from '../extension/sw/sent-log.js';

const AD = 'https://www.leboncoin.fr/ad/consoles/123';
const CONVERSATION = 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101';

function fixture({ stored, failSet = false, failGet = false, failBroadcast = false } = {}) {
  const data = stored === undefined ? {} : { [SENT_LOG_KEY]: stored };
  const broadcasts = [];
  const chrome = {
    storage: { local: {
      async get(key) { if (failGet) throw new Error('lecture'); return { [key]: data[key] }; },
      async set(value) { if (failSet) throw new Error('écriture'); Object.assign(data, value); },
    } },
    runtime: { async sendMessage(message) { if (failBroadcast) throw new Error('panneau fermé'); broadcasts.push(message); } },
  };
  let clock = 1000;
  return { chrome, data, broadcasts, log: createSentLog({ chrome, now: () => (clock += 1) }) };
}

test('an entry keeps only seller, message start, bare url, time, kind and the simulation flag', async () => {
  const f = fixture();
  await f.log.record({ kind: 'premier_contact', simulated: false, vendeur: ` ${'A'.repeat(200)} `,
    message: `Bonjour\n  ${'x'.repeat(300)}`, url: `${AD}?utm=1#top`, secret: 'non' });
  const [entry] = f.data[SENT_LOG_KEY];
  assert.deepEqual(Object.keys(entry).sort(), ['date', 'debut', 'kind', 'simulated', 'tronque', 'url', 'vendeur']);
  assert.equal(entry.vendeur, 'A'.repeat(80));
  assert.equal(entry.debut.length, 80);
  assert.equal(entry.tronque, true);
  assert.match(entry.debut, /^Bonjour x/);
  assert.equal(entry.url, AD);
  assert.equal(entry.date, 1001);
  assert.equal(entry.simulated, false);
});

test('the log is newest first, bounded to 50 and broadcast on every change', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: SENT_LOG_MAX + 5 }, (_, i) => f.log.record(
    { kind: 'reponse', simulated: true, vendeur: null, message: `m${i}`, url: CONVERSATION })));
  assert.equal(SENT_LOG_MAX, 50);
  assert.equal(f.data[SENT_LOG_KEY].length, 50);
  assert.equal(f.data[SENT_LOG_KEY][0].debut, 'm54');
  assert.equal(f.broadcasts.length, 55);
  assert.equal(f.broadcasts.at(-1).type, 'envois-maj');
  assert.deepEqual(f.broadcasts.at(-1).envois, f.data[SENT_LOG_KEY]);
  assert.deepEqual(await f.log.list(), f.data[SENT_LOG_KEY]);
});

test('foreign urls are dropped, unknown kinds are not recorded, an absent flag is never read as real', async () => {
  const f = fixture();
  await f.log.record({ kind: 'reponse', simulated: false, vendeur: 'B', message: 'm', url: 'https://evil.example/ad/x/1' });
  await f.log.record({ kind: 'autre', simulated: false, message: 'm', url: AD });
  await f.log.record({ kind: 'reponse', message: 'm', url: AD });
  assert.equal(f.data[SENT_LOG_KEY].length, 2);
  assert.equal(f.data[SENT_LOG_KEY][1].url, null);
  assert.equal(f.data[SENT_LOG_KEY][0].simulated, true);
});

test('storage or broadcast failures never reject, and a corrupt log is replaced', async () => {
  const entry = { kind: 'reponse', simulated: false, vendeur: 'B', message: 'm', url: CONVERSATION };
  for (const options of [{ failSet: true }, { failGet: true }, { failBroadcast: true }]) {
    await fixture(options).log.record(entry);
  }
  const f = fixture({ stored: 'corrompu' });
  assert.deepEqual(await f.log.list(), []);
  await f.log.record(entry);
  assert.equal(f.data[SENT_LOG_KEY].length, 1);
});

test('consigner swallows a journal that throws or rejects and never waits for it', async () => {
  assert.equal(consigner({ record() { throw new Error('x'); } }, {}), undefined);
  assert.equal(consigner({ record: async () => { throw new Error('x'); } }, {}), undefined);
  assert.equal(consigner({ record: () => new Promise(() => {}) }, {}), undefined);
  assert.equal(consigner(undefined, {}), undefined);
  await new Promise((resolve) => setImmediate(resolve));
});

test('a message kept whole is not marked as truncated, even at the limit or after folding spaces', async () => {
  for (const message of ['x'.repeat(80), `  Bonjour${' '.repeat(100)}ça va ?  `]) {
    const f = fixture();
    await f.log.record({ kind: 'reponse', simulated: false, vendeur: null, message, url: CONVERSATION });
    assert.equal(f.data[SENT_LOG_KEY][0].tronque, false);
  }
});
