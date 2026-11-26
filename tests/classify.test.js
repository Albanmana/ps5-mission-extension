import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  computeClassification,
  decideDefautMajeur,
  decidePaiementHorsPlateforme,
  decideRecherche,
  PRIX_SAINT_GRAAL,
  PRIX_INTERESSANT,
  classifyAnnonce,
} from '../scripts/classify.js';

test('sans lecteur de disque, une annonce est disqualifiée', () => {
  const result = computeClassification({ prix_eur: 300, lecteur_disque: false, manettes_incluses: 2 });
  assert.equal(result.disqualifiee, true);
  assert.equal(result.classification, 'disqualifiee');
  assert.match(result.disqualification_raison, /Digitale/);
});

test('au prix du saint graal avec manette, la classification est saint_graal', () => {
  const result = computeClassification({ prix_eur: PRIX_SAINT_GRAAL, lecteur_disque: true, manettes_incluses: 1 });
  assert.deepEqual(result, { disqualifiee: false, disqualification_raison: null, classification: 'saint_graal' });
});

test('juste au-dessus du saint graal, la classification est interessant', () => {
  const result = computeClassification({ prix_eur: PRIX_SAINT_GRAAL + 1, lecteur_disque: true, manettes_incluses: 1 });
  assert.equal(result.classification, 'interessant');
});

test('au-dessus du palier interessant, la classification est a_verifier', () => {
  const result = computeClassification({ prix_eur: PRIX_INTERESSANT + 1, lecteur_disque: true, manettes_incluses: 1 });
  assert.equal(result.classification, 'a_verifier');
});

test('sans manette détectée, le verdict est plafonné à a_verifier même à bas prix', () => {
  const result = computeClassification({ prix_eur: 250, lecteur_disque: true, manettes_incluses: 0 });
  assert.equal(result.disqualifiee, false);
  assert.equal(result.classification, 'a_verifier');
});

test('un nombre de manettes inconnu ne plafonne pas le verdict', () => {
  const result = computeClassification({ prix_eur: 250, lecteur_disque: true, manettes_incluses: null });
  assert.equal(result.classification, 'saint_graal');
});

test('sans prix connu, le verdict est a_verifier', () => {
  const result = computeClassification({ prix_eur: null, lecteur_disque: true, manettes_incluses: 1 });
  assert.equal(result.classification, 'a_verifier');
});

test('un titre "Recherche" est reconnu comme annonce d\'achat', () => {
  assert.equal(decideRecherche({ titre: 'Recherche PS5 avec lecteur' }), true);
  assert.equal(decideRecherche({ titre: 'CHERCHE ps5' }), true);
  assert.equal(decideRecherche({ titre: 'Je recherché une ps5' }), true);
});

test('une intention d\'achat en tête du titre est reconnue comme annonce d\'achat', () => {
  assert.equal(decideRecherche({ titre: 'Achète une PS5 avec lecteur et manettes' }), true);
  assert.equal(decideRecherche({ titre: "J'achète une PS5 Slim" }), true);
  assert.equal(decideRecherche({ titre: 'ACHAT PS5 avec lecteur' }), true);
  assert.equal(decideRecherche({ titre: 'Acheter PS5 standard' }), true);
});

test('un titre de vente normal n\'est pas une annonce d\'achat', () => {
  assert.equal(decideRecherche({ titre: 'PS5 Slim comme neuve' }), false);
  assert.equal(decideRecherche({ titre: 'PS5 achetée en 2024, comme neuve' }), false);
  assert.equal(decideRecherche({ titre: 'Vends PS5 pour acheter une PS5 Pro' }), false);
  assert.equal(decideRecherche({ titre: null }), false);
});

test('une console explicitement a reparer est rejetee avant toute qualification positive', () => {
  assert.equal(decideDefautMajeur({ titre: 'PS5 a réparé' }), true);
  assert.equal(decideDefautMajeur({ titre: 'PS5 à réparer' }), true);
  assert.equal(decideDefautMajeur({ titre: 'PS5 pour pièces' }), true);
  assert.equal(decideDefautMajeur({ titre: 'Console PS5 hors service' }), true);
  assert.equal(decideDefautMajeur({ titre: 'PS5 réparée par Sony, fonctionne parfaitement' }), false);
});

test('une suspension active des services PlayStation est un défaut majeur', () => {
  assert.equal(decideDefautMajeur({
    titre: 'Ps5',
    description: 'La PS5 est actuellement suspendue des services PlayStation et affiche le code WS-116332-6.',
  }), true);
  assert.equal(decideDefautMajeur({ description: 'Console bannie du PSN.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Console bannie par Sony, impossible de se connecter au PSN.' }), true);
  assert.equal(decideDefautMajeur({ description: "Console interdite d'accès au PSN." }), true);
  assert.equal(decideDefautMajeur({ description: "L'accès aux services en ligne est suspendu." }), true);
  assert.equal(decideDefautMajeur({ description: "La suspension a été levée, la console n'est pas bannie." }), false);
  assert.equal(decideDefautMajeur({ description: "La PS5 n'est pas bannie du PSN." }), false);
  assert.equal(decideDefautMajeur({ description: 'Console pas bannie du PSN.' }), false);
  assert.equal(decideDefautMajeur({ description: 'Console non bannie du PSN.' }), false);
  assert.equal(decideDefautMajeur({ description: 'Console jamais bannie du PSN.' }), false);
  assert.equal(decideDefautMajeur({ description: 'Console sans être bannie du PSN.' }), false);
  assert.equal(decideDefautMajeur({ description: "La console n'a jamais été bannie du PSN." }), false);
  assert.equal(decideDefautMajeur({ description: "La PS5 n'est plus suspendue des services PlayStation." }), false);
  assert.equal(decideDefautMajeur({ description: 'Erreur WS-116332-6 résolue, accès PSN OK.' }), false);
  assert.equal(decideDefautMajeur({ description: 'Erreur WS-116332-6 résolue, accès au PSN toujours bloqué.' }), true);
  assert.equal(decideDefautMajeur({ description: "La console n'est pas bannie du PSN, elle est suspendue des services PlayStation." }), true);
  assert.equal(decideDefautMajeur({ titre: 'PS5', description: 'Bannie par Sony.' }), true);
  assert.equal(decideDefautMajeur({ titre: 'PS5', description: 'Suspendue des services en ligne.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Ban permanent PSN.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Console avec bannissement PSN permanent.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Suspension PSN active.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Console sous suspension PSN permanente.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Restriction PSN active.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Pas de ban PSN.' }), false);
  assert.equal(decideDefautMajeur({ description: 'Aucun bannissement PSN.' }), false);
  assert.equal(decideDefautMajeur({ description: 'Ban PSN levé.' }), false);
  assert.equal(decideDefautMajeur({ description: 'Bannissement PSN terminé.' }), false);
  assert.equal(decideDefautMajeur({ description: 'Restriction PSN non levée.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Suspension PSN toujours pas levée.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Bannissement PSN non résolu.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Ban PSN pas terminé.' }), true);
  assert.equal(decideDefautMajeur({ description: 'Erreur WS-116332-6 non résolue.' }), true);
  assert.equal(decideDefautMajeur({ description: "Suspension PSN n'a pas été levée." }), true);
  assert.equal(decideDefautMajeur({ description: "Restriction PlayStation n'a pas été résolue." }), true);
  assert.equal(decideDefautMajeur({ description: "Blocage Sony n'a pas été terminé." }), true);
  assert.equal(decideDefautMajeur({ description: "Erreur WS-116332-6 n'a pas été corrigée." }), true);
  assert.equal(decideDefautMajeur({ titre: 'PlayStation 5', description: 'Restriction de circulation non levée.' }), false);
  assert.equal(decideDefautMajeur({ titre: 'PlayStation 5 Slim', description: 'Blocage parental pas résolu.' }), false);
  assert.equal(decideDefautMajeur({
    description: "Connexion à mon compte PSN impossible car j'ai oublié le mot de passe, console fonctionnelle.",
  }), false);
});

test('une demande de paiement hors plateforme dans le titre ou la description est rejetee', () => {
  assert.equal(decidePaiementHorsPlateforme({
    titre: 'PlayStation 5',
    description: 'Paiement via vir€m€nt ou wero',
  }), true);
  assert.equal(decidePaiementHorsPlateforme({ titre: 'PS5 - PayPal uniquement' }), true);
  assert.equal(decidePaiementHorsPlateforme({ description: 'Règlement par virement bancaire' }), true);
});

test('un refus explicite de paiement hors plateforme ne bloque pas une annonce', () => {
  assert.equal(decidePaiementHorsPlateforme({ description: 'Pas de virement, paiement Leboncoin uniquement' }), false);
  assert.equal(decidePaiementHorsPlateforme({ description: 'Sans Wero merci' }), false);
  assert.equal(decidePaiementHorsPlateforme({ description: 'PayPal refusé' }), false);
  assert.equal(decidePaiementHorsPlateforme({ description: 'Pas de virement ni PayPal' }), false);
  assert.equal(decidePaiementHorsPlateforme({ description: 'Pas de virement ni de PayPal' }), false);
  assert.equal(decidePaiementHorsPlateforme({ description: 'Ni virement ni PayPal' }), false);
  assert.equal(decidePaiementHorsPlateforme({ description: 'Wero et PayPal refusés' }), false);
  assert.equal(decidePaiementHorsPlateforme({ description: 'Virement, Wero, ou PayPal refusés' }), false);
  assert.equal(decidePaiementHorsPlateforme({ description: 'Je refuse les paiements par virement' }), false);
  assert.equal(decidePaiementHorsPlateforme({ description: 'Je refuse le virement et le PayPal' }), false);
  assert.equal(decidePaiementHorsPlateforme({ titre: 'PS5 achetée en 2024', description: 'Envoi possible' }), false);
});

test('le pipeline persiste le rejet hors plateforme sans appeler OpenRouter', async () => {
  const url = 'https://www.leboncoin.fr/ad/consoles/1000000003';
  const queries = [];
  const client = { query: async (sql, values) => {
    queries.push({ sql, values });
    return { rows: [] };
  } };
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('OpenRouter ne doit pas être appelé'); };
  try {
    const result = await classifyAnnonce(client, {
      url_annonce: url,
      titre: 'PlayStation 5',
      description: 'Paiement via vir€m€nt ou wero',
      prix_eur: 290,
    }, { force: true });
    assert.equal(result.classification, 'disqualifiee');
    assert.match(result.disqualification_raison, /paiement hors plateforme/i);
    assert.equal(result.analyse_ia.est_console_etage, 'regex_paiement_hors_plateforme');
    const writes = queries.filter(({ sql }) => !/^\s*select/i.test(sql));
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /^insert into public\.annonces/i);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('le rejet hors plateforme fonctionne dans un processus sans cle OpenRouter', () => {
  const moduleUrl = new URL('../scripts/classify.js', import.meta.url).href;
  const script = `
    import { classifyAnnonce } from ${JSON.stringify(moduleUrl)};
    delete process.env.OPENROUTER_API_KEY;
    if (process.env.OPENROUTER_API_KEY) process.exit(3);
    const client = { query: async () => ({ rows: [] }) };
    const result = await classifyAnnonce(client, {
      url_annonce: 'https://www.leboncoin.fr/ad/consoles/1000000003',
      titre: 'PlayStation 5',
      description: 'Paiement via vir€m€nt ou wero',
    }, { force: true });
    if (result.analyse_ia?.est_console_etage !== 'regex_paiement_hors_plateforme') process.exit(2);
  `;
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('une classification déjà écrite est relue en base sans perdre son résultat dans la réponse sautée', async () => {
  const url = 'https://www.leboncoin.fr/ad/consoles/123';
  const client = { query: async (sql, values) => {
    assert.match(sql, /^select /i);
    assert.deepEqual(values, [url]);
    return { rows: [{ done: true, classification: 'saint_graal', disqualifiee: false,
      lecteur_disque: true, manettes_incluses: 2, analyse_ia_le: '2026-09-25T21:00:00.000Z' }] };
  } };
  const resultat = await classifyAnnonce(client, { url_annonce: url }, { force: false });
  assert.equal(resultat.saute, true);
  assert.equal(resultat.classification, 'saint_graal');
  assert.equal(resultat.disqualifiee, false);
  assert.equal(resultat.analyse_ia_le, '2026-09-25T21:00:00.000Z');
});

test('le CLI échoue si le contrôle de dédoublonnage échoue', () => {
  const root = new URL('../', import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-loader',
      new URL('./fixtures/failing-pg-loader.mjs', import.meta.url).pathname,
      'scripts/classify.js',
      new URL('./fixtures/single-annonce.json', import.meta.url).pathname,
    ],
    {
      cwd: root.pathname,
      encoding: 'utf8',
      env: { ...process.env, OPENROUTER_API_KEY: 'task-2-regression-test-key' },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /dedup query failed/);
  assert.doesNotMatch(result.stdout, /0 annonce\(s\) analysée\(s\)/);
});
