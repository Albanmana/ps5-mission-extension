#!/usr/bin/env node
// Importe en base des conversations de messagerie leboncoin à partir d'un
// fichier préparé à la main. Format d'entrée : tableau JSON d'objets
// { conversation_url, vendeur, ad_href, annonce_titre, ad_prix_eur, statut,
//   offre_envoyee_eur?, offre_recue_eur?, messages: [...] }
// — voir scripts/data/conversations-exemple.json pour un exemple fictif.
//
// Usage :
//   node scripts/import-conversations.js chemin/vers/conversations.json
//
// Deux upserts par conversation :
// 1) annonces, par url_annonce (déduite de ad_href) — seulement si absente,
//    ne écrase jamais une annonce déjà enrichie par le pipeline principal
//    (extension / classify.js).
// 2) conversations, par url_conversation — remplacement complet (c'est la
//    source de vérité pour tout ce qui est propre à la conversation).

import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { loadEnv } from './lib/env.js';
import { resolveUrlAnnonce } from './lib/listing.js';

loadEnv();

const DB_URL = process.env.SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage : node scripts/import-conversations.js chemin/vers/conversations.json');
  process.exit(1);
}

const conversations = JSON.parse(readFileSync(inputPath, 'utf8'));
if (!Array.isArray(conversations)) {
  console.error("Le fichier d'entrée doit contenir un tableau JSON de conversations.");
  process.exit(1);
}

async function upsertAnnonce(client, c) {
  if (!c.ad_href) return null;
  const urlAnnonce = new URL(c.ad_href, 'https://www.leboncoin.fr').toString();
  const listIdMatch = c.ad_href.match(/(\d+)$/);
  const listId = listIdMatch ? Number(listIdMatch[1]) : null;

  const { rows } = await client.query(
    `insert into public.annonces (url_annonce, titre, prix_eur, list_id)
     values ($1, $2, $3, $4)
     on conflict (url_annonce) do update set
       titre = coalesce(public.annonces.titre, excluded.titre),
       prix_eur = coalesce(public.annonces.prix_eur, excluded.prix_eur),
       list_id = coalesce(public.annonces.list_id, excluded.list_id)
     returning id`,
    [await resolveUrlAnnonce(client, urlAnnonce, 'public.annonces'), c.annonce_titre ?? null, c.ad_prix_eur ?? null, listId],
  );
  return rows[0]?.id ?? null;
}

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  let upserted = 0;
  for (const c of conversations) {
    if (!c.conversation_url) continue;

    const annonceId = await upsertAnnonce(client, c);

    const messages = (c.messages ?? []).filter((m) => m.contenu);
    const last = messages[messages.length - 1] ?? null;

    await client.query(
      `insert into public.conversations (
         annonce_id, url_conversation, vendeur, annonce_titre, statut, messages,
         dernier_message, dernier_message_le, dernier_message_de, non_lus,
         offre_envoyee_eur, offre_recue_eur
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (url_conversation) do update set
         annonce_id = excluded.annonce_id,
         vendeur = excluded.vendeur,
         annonce_titre = excluded.annonce_titre,
         statut = excluded.statut,
         messages = excluded.messages,
         dernier_message = excluded.dernier_message,
         dernier_message_le = excluded.dernier_message_le,
         dernier_message_de = excluded.dernier_message_de,
         non_lus = excluded.non_lus,
         offre_envoyee_eur = excluded.offre_envoyee_eur,
         offre_recue_eur = excluded.offre_recue_eur`,
      [
        annonceId,
        c.conversation_url,
        c.vendeur ?? null,
        c.annonce_titre ?? null,
        c.statut ?? 'ouverte',
        JSON.stringify(messages),
        last?.contenu ?? null,
        last?.envoye_le ?? null,
        last?.expediteur ?? null,
        0,
        c.offre_envoyee_eur ?? null,
        c.offre_recue_eur ?? null,
      ],
    );
    upserted++;
  }

  console.log(`${upserted} conversation(s) upsertée(s).`);
  await client.end();
}

main();
