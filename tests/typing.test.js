import assert from 'node:assert/strict';
import test from 'node:test';

import { randomBetween, nextCharDelay, typeInto } from '../extension/lib/typing.js';

// random injecté sous forme de séquence : chaque branche prise consomme
// une valeur, ce qui rend les délais exactement prévisibles.
const seq = (values) => {
  let i = 0;
  return () => values[i++];
};

test('randomBetween reste dans les bornes', () => {
  assert.equal(randomBetween(10, 20, () => 0), 10);
  assert.equal(randomBetween(10, 20, () => 1), 20);
  assert.equal(randomBetween(10, 20, () => 0.5), 15);
});

test('le délai de base est de 70 à 160 ms', () => {
  assert.equal(nextCharDelay(null, seq([0, 0.9])), 70);
  assert.equal(nextCharDelay(null, seq([1, 0.9])), 160);
});

test('un espace ajoute une pause de 40 à 120 ms', () => {
  assert.equal(nextCharDelay(' ', seq([0, 0, 0.9])), 110);
  assert.equal(nextCharDelay(' ', seq([0, 1, 0.9])), 190);
});

test('une ponctuation ajoute une pause de 150 à 400 ms', () => {
  assert.equal(nextCharDelay('.', seq([0, 0, 0.9])), 220);
  assert.equal(nextCharDelay('?', seq([0, 1, 0.9])), 470);
});

test('une hésitation ajoute 300 à 700 ms', () => {
  assert.equal(nextCharDelay(null, seq([0, 0.01, 0])), 370);
});

test('typeInto écrit le texte caractère par caractère', async () => {
  const events = [];
  const el = {
    value: '',
    focus() {},
    dispatchEvent(event) { events.push({ type: event.type, value: this.value }); },
  };
  const delays = [];
  await typeInto(el, 'ok', {
    sleep: async (ms) => { delays.push(ms); },
    random: () => 0.5,
    setValue: (target, value) => { target.value = value; },
  });

  assert.equal(el.value, 'ok');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.value), ['o', 'ok']);
  assert.equal(events.every((e) => e.type === 'input'), true);
  assert.equal(delays.length, 2);
  assert.equal(delays.every((d) => d >= 70), true);
});

test('typeInto s’arrête dès que doitArreter devient vrai', async () => {
  const el = { value: '', focus() {}, dispatchEvent() {} };
  await typeInto(el, 'abc', { sleep: async () => {}, setValue: (node, v) => { node.value = v; },
    doitArreter: () => el.value === 'a' });
  assert.equal(el.value, 'a');
});
