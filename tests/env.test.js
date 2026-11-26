import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEnv, loadEnv } from '../scripts/lib/env.js';

test('parseEnv lit les paires clé=valeur', () => {
  assert.deepEqual(parseEnv('FOO=bar\nBAZ=qux'), { FOO: 'bar', BAZ: 'qux' });
});

test('parseEnv retire les guillemets encadrants et les espaces', () => {
  assert.deepEqual(parseEnv('FOO="bar"\nBAZ=  qux  '), { FOO: 'bar', BAZ: 'qux' });
});

test('parseEnv ignore les commentaires et les lignes vides', () => {
  assert.deepEqual(parseEnv('# commentaire\n\nFOO=bar\n'), { FOO: 'bar' });
});

test('parseEnv ignore les clés non conformes', () => {
  assert.deepEqual(parseEnv('minuscule=1\nFOO=bar'), { FOO: 'bar' });
});

test('parseEnv garde les signes égal de la valeur', () => {
  assert.deepEqual(parseEnv('URL=postgres://a:b@c/d?x=1'), { URL: 'postgres://a:b@c/d?x=1' });
});

test("loadEnv n'écrase pas une valeur déjà présente", () => {
  const target = { FOO: 'déjà là' };
  loadEnv(target, new URL('./fixtures/sample.env', import.meta.url));
  assert.equal(target.FOO, 'déjà là');
  assert.equal(target.BAZ, 'depuis le fichier');
});

test('loadEnv remplace une valeur présente mais vide', () => {
  const target = { FOO: '' };
  loadEnv(target, new URL('./fixtures/sample.env', import.meta.url));
  assert.equal(target.FOO, 'ignoré car déjà défini');
});

test('loadEnv ne lève pas si le fichier est absent', () => {
  const target = {};
  loadEnv(target, new URL('./fixtures/absent.env', import.meta.url));
  assert.deepEqual(target, {});
});
