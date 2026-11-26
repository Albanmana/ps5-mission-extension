import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createConversationTurn } from '../scripts/lib/conversation-turn.js';
import { resoudreReservation, listerReservationsBloquees } from '../scripts/lib/reservations.js';
import { listIdFromUrl, resolveUrlAnnonce } from '../scripts/lib/listing.js';
import { validateConversationNegotiateRequest } from '../scripts/negotiate-server.js';
import { classifyAnnonce } from '../scripts/classify.js';

const URL_CONV = 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101';
const AD = 'https://www.leboncoin.fr/ad/consoles/1000000002';
const FP = 'a'.repeat(64);
const snapshot = { url_conversation: URL_CONV, url_annonce: AD, messages: [] };
const STOP = { message: null, arret: { doit_arreter: true, raison: 'defaut_majeur' }, notes_internes: 'x' };
const REPLY = { message: 'ok', arret: { doit_arreter: false, raison: null } };
const LIVE = { dryRun: false, replyScope: 'all' };

// Base en mémoire reproduisant les règles de réservation du SQL.
function memory({ draft = STOP, contacted = true, delay = null } = {}) {
  const log = [];
  let row = null;
  const db = {
    isListingContacted: async (url) => { log.push(['scope', url]); return contacted; },
    upsertConversation: async () => {
      log.push(['upsert']);
      row ??= { id: 'c1', messages: [{ expediteur: 'vendeur', contenu: 'HS' }], dernier_message_fingerprint: null, traite_le: null, brouillon: null, decision: null, automation_erreur_code: null };
    },
    loadConversationByUrl: async () => structuredClone(row),
    reserveConversationTurn: async (_url, fp) => {
      log.push(['reserve']);
      const free = row.dernier_message_fingerprint !== fp || row.automation_erreur_code === 'generation_echec'
        || (!row.traite_le && !row.decision && !row.brouillon && !row.automation_erreur_code);
      if (free) Object.assign(row, { dernier_message_fingerprint: fp, traite_le: null, brouillon: null, decision: null, automation_erreur_code: null });
      return { reserved: free };
    },
    storeConversationDraft: async (_url, _fp, value) => { log.push(['store']); Object.assign(row, { brouillon: value.message, decision: value }); },
    markConversationError: async (_url, _fp, code) => { row.automation_erreur_code = code; },
  };
  let generations = 0;
  const turn = createConversationTurn({ db, generate: async () => { generations += 1; await delay; return structuredClone(draft); } });
  return { turn, log, get row() { return row; }, get generations() { return generations; } };
}

test('hors périmètre : rien n’est stocké et aucun modèle n’est appelé', async () => {
  const f = memory({ contacted: false });
  for (const settings of [undefined, { dryRun: false }]) {
    assert.deepEqual(await f.turn({ snapshot, fingerprint: FP, settings }), { ignored: true, reason: 'hors_perimetre' });
  }
  assert.deepEqual(await f.turn({ snapshot: { ...snapshot, url_annonce: null }, fingerprint: FP }), { ignored: true, reason: 'hors_perimetre' });
  assert.equal(f.generations, 0);
  assert.equal(f.log.some(([name]) => name !== 'scope'), false);
});

test('replyScope all ne consulte pas le périmètre', async () => {
  const f = memory({ contacted: false });
  assert.equal((await f.turn({ snapshot, fingerprint: FP, settings: LIVE })).duplicate, false);
  assert.equal(f.log.some(([name]) => name === 'scope'), false);
});

test('une simulation ne réserve ni ne stocke le tour, qui reste traitable ensuite', async () => {
  const f = memory({ draft: REPLY });
  for (let i = 0; i < 2; i += 1) {
    const result = await f.turn({ snapshot, fingerprint: FP, settings: { dryRun: true } });
    assert.equal(result.dryRun, true);
    assert.equal(result.duplicate, false);
  }
  assert.equal(f.log.some(([name]) => name === 'reserve' || name === 'store'), false);
  assert.equal((await f.turn({ snapshot, fingerprint: FP, settings: { dryRun: false } })).duplicate, false);
  assert.deepEqual(await f.turn({ snapshot, fingerprint: FP, settings: { dryRun: true } }), { duplicate: true });
});

test('un point d’arrêt non traité est rejoué sans rappeler le modèle, puis doublon une fois traité', async () => {
  const f = memory();
  const first = await f.turn({ snapshot, fingerprint: FP, settings: LIVE });
  for (const settings of [LIVE, { ...LIVE, dryRun: true }]) {
    const again = await f.turn({ snapshot, fingerprint: FP, settings });
    assert.equal(again.duplicate, false);
    assert.deepEqual(again.draft, first.draft);
    assert.equal(again.conversation.id, 'c1');
  }
  f.row.automation_erreur_code = 'persistance_echec';
  assert.equal((await f.turn({ snapshot, fingerprint: FP, settings: LIVE })).duplicate, false);
  assert.equal(f.generations, 1);
  f.row.traite_le = '2026-11-25T00:00:00Z';
  assert.deepEqual(await f.turn({ snapshot, fingerprint: FP, settings: LIVE }), { duplicate: true });
});

test('une réponse ordinaire n’est jamais rejouée', async () => {
  const f = memory({ draft: REPLY });
  await f.turn({ snapshot, fingerprint: FP, settings: LIVE });
  assert.deepEqual(await f.turn({ snapshot, fingerprint: FP, settings: LIVE }), { duplicate: true });
});

test('un rejeu concurrent attend la génération en cours et reçoit la décision', async () => {
  let release;
  const f = memory({ delay: new Promise((resolve) => { release = resolve; }) });
  const both = [f.turn({ snapshot, fingerprint: FP, settings: LIVE }), f.turn({ snapshot, fingerprint: FP, settings: LIVE })];
  setImmediate(release);
  const results = await Promise.all(both);
  assert.deepEqual(results.map((result) => result.draft?.arret.raison), ['defaut_majeur', 'defaut_majeur']);
  assert.equal(f.generations, 1);
});

test('la requête negotiate transmet les réglages ; absents, ils réservent avec le périmètre contacté', () => {
  const body = { snapshot, fingerprint: FP };
  const absent = validateConversationNegotiateRequest(body).settings;
  assert.deepEqual([absent.replyScope, absent.goodPrice, absent.maxPrice, absent.dryRun], ['contacted', 350, 370, false]);
  assert.equal(validateConversationNegotiateRequest({ ...body, settings: {} }).settings.dryRun, false);
  for (const settings of [{ dryRun: true }, { dryRun: 'false' }, { dryRun: null }]) {
    assert.equal(validateConversationNegotiateRequest({ ...body, settings }).settings.dryRun, true);
  }
});

test('une annonce est reconnue sous une autre forme d’URL', async () => {
  assert.equal(listIdFromUrl('https://www.leboncoin.fr/ad/jeux/123?x=1#y'), '123');
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ url_annonce: AD }] }; } };
  assert.equal(await resolveUrlAnnonce(client, `${AD}?ref=1`), AD);
  assert.match(calls[0].sql, /list_id/);
  // La ligne qui porte déjà le numéro l'emporte, sinon l'index unique casse.
  assert.match(calls[0].sql, /order by \(list_id is not null\) desc/);
  assert.equal(await resolveUrlAnnonce({ query: async () => ({ rows: [] }) }, AD), AD);
});

test('seules les réservations de plus de 10 minutes sont listées ou résolues', async () => {
  const now = new Date('2026-11-25T12:00:00.000Z');
  const queries = [];
  await listerReservationsBloquees({ query: async (sql, values) => { queries.push([sql, values]); return { rows: [] }; } }, now);
  assert.equal(queries[0][1][0].toISOString(), '2026-11-25T11:50:00.000Z');
  const none = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.deepEqual(await resoudreReservation(none, AD, 'non_envoye', now), { resolue: false });
});

test('une décision manuelle n’est ni réanalysée ni écrasée, même en forçant', async () => {
  const row = { decision_manuelle: true, analyse_ia_le: null, disqualifiee: true, classification: 'disqualifiee', disqualification_raison: 'Annonce supprimée de leboncoin.' };
  const queries = [];
  const client = { query: async (sql) => { queries.push(sql); return { rows: [row] }; } };
  const result = await classifyAnnonce(client, { url_annonce: AD, titre: 'PS5 HS' }, { force: true });
  assert.equal(result.saute, true);
  assert.equal(result.classification, 'disqualifiee');
  assert.equal(queries.length, 1);
});

test('une décision manuelle prise pendant l’analyse l’emporte sur le résultat', async () => {
  let sql;
  const client = { query: async (text) => {
    if (/^\s*insert/i.test(text)) { sql = text; return { rows: [{ disqualifiee: true, classification: 'disqualifiee', disqualification_raison: 'manuelle' }] }; }
    return { rows: [] };
  } };
  const result = await classifyAnnonce(client, { url_annonce: AD, titre: 'Recherche PS5' }, { force: true });
  assert.match(sql, /classification = case when public\.annonces\.decision_manuelle/);
  assert.equal(result.disqualification_raison, 'manuelle');
});

test('classify.js lancé en ligne de commande s’exécute sans dépendre d’import.meta.main', () => {
  const source = readFileSync(new URL('../scripts/classify.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /import\.meta\.main\b/);
  const result = spawnSync(process.execPath, [new URL('../scripts/classify.js', import.meta.url).pathname], {
    env: { ...process.env, OPENROUTER_API_KEY: 'test' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.match(result.stderr, /Usage/);
});
