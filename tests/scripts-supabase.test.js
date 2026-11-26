// Les scripts shell doivent trouver une Supabase CLI assez récente même quand
// une ancienne passe devant dans le PATH : « npm run » ajoute les
// node_modules/.bin de tous les dossiers parents.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = new URL('../scripts/supabase-local.sh', import.meta.url).pathname;

function lancer(versions, commande) {
  const racine = mkdtempSync(join(tmpdir(), 'ps5-supa-'));
  const dossiers = versions.map((version, index) => {
    const dossier = join(racine, `bin${index}`);
    mkdirSync(dossier);
    const faux = join(dossier, 'supabase');
    writeFileSync(faux, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; else echo "utilisée ${version}: $*"; fi\n`);
    chmodSync(faux, 0o755);
    return dossier;
  });
  const resultat = spawnSync('/bin/bash', ['-c', `source "${LIB}"; ${commande}`], {
    env: { PATH: [...dossiers, '/usr/bin', '/bin'].join(':') }, encoding: 'utf8',
  });
  rmSync(racine, { recursive: true, force: true });
  return resultat;
}

test('une ancienne CLI en tête du PATH est ignorée au profit d’une récente', () => {
  const r = lancer(['2.9.6', '2.109.1'], 'choisir_supabase && supabase start');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /utilisée 2\.109\.1: start/);
  assert.doesNotMatch(r.stdout, /utilisée 2\.9\.6/);
});

test('une version plus récente que la version testée convient', () => {
  for (const version of ['2.110.0', '3.4.0']) {
    const r = lancer([version], 'choisir_supabase && supabase status');
    assert.equal(r.status, 0, `${version}: ${r.stderr}`);
  }
});

test('sans CLI assez récente : échec avec les versions trouvées et la marche à suivre', () => {
  const r = lancer(['2.9.6'], 'choisir_supabase');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /2\.9\.6/);
  assert.match(r.stderr, /brew install supabase\/tap\/supabase|brew upgrade supabase/);
});

test('sans aucune CLI : échec explicite', () => {
  const r = lancer([], 'choisir_supabase');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /introuvable/i);
});

test('les deux scripts choisissent la CLI avant de s’en servir', () => {
  for (const script of ['dev.sh', 'setup.sh']) {
    const source = execFileSync('/bin/cat', [new URL(`../scripts/${script}`, import.meta.url).pathname], { encoding: 'utf8' });
    assert.match(source, /choisir_supabase/, script);
  }
});
