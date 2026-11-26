import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings, loadSettings, saveSettings,
} from '../extension/lib/settings.js';

const storage = (initial = {}) => {
  const data = { ...initial };
  return { data, local: { get: async (k) => ({ [k]: data[k] }), set: async (o) => Object.assign(data, o) } };
};

test('a fresh install sends for real and only replies to contacted listings', async () => {
  assert.deepEqual(await loadSettings({ storage: storage() }), {
    dryRun: false, ownerName: '', handoffEmail: '', goodPrice: 350, maxPrice: 370, replyScope: 'contacted',
  });
});

test('invalid stored values fall back to the defaults, and a doubtful mode never sends', () => {
  assert.deepEqual(normalizeSettings({
    dryRun: 'false', ownerName: 42, handoffEmail: 'nope', goodPrice: -1, maxPrice: 'x', replyScope: 'everyone',
  }), { ...DEFAULT_SETTINGS, dryRun: true });
});

test('only nothing stored or an explicit false sends for real', () => {
  for (const raw of [undefined, {}, { goodPrice: 300 }, { dryRun: false }]) {
    assert.equal(normalizeSettings(raw).dryRun, false, JSON.stringify(raw));
  }
  for (const raw of [{ dryRun: true }, { dryRun: 'false' }, { dryRun: 0 }, { dryRun: null }, { dryRun: '' },
    null, false, 0, '', 'x', []]) {
    assert.equal(normalizeSettings(raw).dryRun, true, JSON.stringify(raw));
  }
});

test('a stored test mode is kept and unreadable storage throws', async () => {
  assert.equal((await loadSettings({ storage: storage({ [SETTINGS_KEY]: { dryRun: true } }) })).dryRun, true);
  await assert.rejects(loadSettings({ storage: { local: { get: async () => { throw new Error('illisible'); } } } }));
});

test('only "all" widens the scope', () => {
  assert.equal(normalizeSettings({ replyScope: 'all' }).replyScope, 'all');
});

test('prices must be consistent', () => {
  const value = normalizeSettings({ goodPrice: 400, maxPrice: 300 });
  assert.equal(value.goodPrice, 350);
  assert.equal(value.maxPrice, 370);
});

test('saving normalizes and trims', async () => {
  const fake = storage();
  await saveSettings({ storage: fake }, { ownerName: '  Sam ', handoffEmail: ' sam@example.com ', goodPrice: 300, maxPrice: 320 });
  assert.equal(fake.data[SETTINGS_KEY].ownerName, 'Sam');
  assert.equal(fake.data[SETTINGS_KEY].handoffEmail, 'sam@example.com');
  assert.equal(fake.data[SETTINGS_KEY].maxPrice, 320);
});
