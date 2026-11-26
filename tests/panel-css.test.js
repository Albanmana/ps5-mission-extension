import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../extension/panel/panel.css', import.meta.url), 'utf8');
const declarations = (selecteur) => [...css.matchAll(/(?:^|\n)\s*([^{}\n]+)\{([^}]*)\}/g)]
  .filter(([, liste]) => liste.split(',').map((value) => value.trim()).includes(selecteur))
  .map(([, , corps]) => corps).join(' ');

test('le thème clair est imposé, même quand le système est en sombre', () => {
  assert.match(declarations(':root'), /color-scheme:\s*light\s*;/);
  assert.doesNotMatch(css, /color-scheme:\s*light dark|prefers-color-scheme/);
  assert.match(declarations('body'), /background:/);
});

test('l’en-tête et son badge de mode restent visibles en haut du panneau', () => {
  assert.match(declarations('.entete'), /position:\s*sticky\s*;/);
  assert.match(declarations('.entete'), /top:\s*0\s*;/);
});

test('la navigation reste en bas, en trois colonnes qui rétrécissent', () => {
  assert.match(declarations('.bas'), /position:\s*sticky/);
  assert.match(declarations('.navigation'), /repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(declarations('.puces'), /flex-wrap:\s*wrap/);
  assert.match(declarations('body'), /min-width:\s*320px/);
  assert.match(declarations('body'), /overflow-wrap:\s*anywhere/);
});

test('les blocs masqués ne sont jamais réaffichés par la mise en page', () => {
  assert.match(declarations('[hidden]'), /display:\s*none !important/);
});

test('focus visible, cibles de 44 px et animations coupées sur demande', () => {
  assert.match(declarations(':focus-visible'), /outline:\s*3px solid/);
  assert.match(declarations('button'), /min-height:\s*44px/);
  assert.match(declarations('summary'), /min-height:\s*44px/);
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{[^}]*animation:\s*none !important;\s*transition:\s*none !important/);
});

test('les listes du panneau n’ont pas de puces parasites', () => {
  assert.match(declarations('.liste-nue'), /list-style:\s*none/);
  assert.match(declarations('.liste-nue'), /padding:\s*0/);
});

test('le texte garde sa taille : les pages d’extension Chrome le réduisent à 75 % par défaut', async () => {
  const css = await (await import('node:fs/promises')).readFile(new URL('../extension/panel/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\nbody \{[^}]*font-size: 14px/);
});

test('le bouton du message du bas ne se coupe pas en deux lignes', async () => {
  const css = await (await import('node:fs/promises')).readFile(new URL('../extension/panel/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.toast button \{[^}]*flex: none[^}]*white-space: nowrap/);
});
