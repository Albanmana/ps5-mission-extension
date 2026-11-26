import { listIdFromUrl, resolveUrlAnnonce, retryOnDuplicate, LIST_ID_SQL } from './listing.js';

const CONVERSATION_URL = /^https:\/\/www\.leboncoin\.fr\/messages\/id\/[0-9a-f-]{16,}(?:[?#].*)?$/i;
const AD_URL = /^https:\/\/www\.leboncoin\.fr\/ad\/[^/?#]+\/\d+(?:[?#].*)?$/;
const ROLES = new Set(['moi', 'vendeur', 'systeme']);
const TYPES = new Set(['texte', 'offre', 'image', 'notice']);
const ERROR_CODES = new Set([
  'generation_echec', 'envoi_incertain', 'persistance_echec', 'bloque', 'connexion_requise',
]);

// Code stable lu par l’extension : réessayer ne servirait à rien.
export const TOUR_INTROUVABLE = 'tour_introuvable';
const tourIntrouvable = () => Object.assign(new Error('Conversation réservée introuvable.'), { code: TOUR_INTROUVABLE });

// Panne de la base elle-même (arrêtée, en démarrage, connexion coupée) : codes
// réseau, classe SQLSTATE 08, arrêts 57P0x, saturation, et messages de `pg`.
export const BASE_INDISPONIBLE = 'base_indisponible';
const CODES_BASE_INJOIGNABLE = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|08[0-9A-Z]{3}|57P0[1-3]|53300)$/;
const MESSAGES_PG_SANS_CODE = /connection terminated|timeout exceeded when trying to connect|client has encountered a connection error/i;

export function estBaseIndisponible(error) {
  return CODES_BASE_INJOIGNABLE.test(String(error?.code ?? ''))
    || MESSAGES_PG_SANS_CODE.test(String(error?.message ?? ''));
}

const CONVERSATION_SELECT = `
  select c.*, a.url_annonce, a.titre, a.prix_eur, a.description, a.etat,
         a.ville, a.code_postal, a.modes_remise, a.images, a.image_url,
         a.livraison_possible
    from public.conversations c
    left join public.annonces a on a.id = c.annonce_id`;

function cleanText(value, { required = false, max = 4000 } = {}) {
  const text = typeof value === 'string' ? value.trim().slice(0, max) : '';
  if (required && !text) throw new Error('Contenu de message requis.');
  return text || null;
}

function normalizeDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Date de message invalide.');
  }
  return new Date(value).toISOString();
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Chaque message doit être un objet.');
  }
  if (!ROLES.has(message.expediteur)) throw new Error('Expediteur de message invalide.');
  const contenu = cleanText(message.contenu, { required: true });
  const type = TYPES.has(message.type) ? message.type : 'texte';
  const montant = message.montant_eur == null ? null : Number(message.montant_eur);
  if (montant != null && !Number.isFinite(montant)) throw new Error('Montant de message invalide.');
  return {
    expediteur: message.expediteur,
    contenu,
    envoye_le: normalizeDate(message.envoye_le),
    type,
    montant_eur: montant,
    lu: typeof message.lu === 'boolean' ? message.lu : null,
  };
}

function requireConversationUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!CONVERSATION_URL.test(url)) throw new Error('URL de conversation leboncoin invalide.');
  return url;
}

function requireFingerprint(value) {
  const fingerprint = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-f0-9]{8,128}$/i.test(fingerprint)) throw new Error('Fingerprint de conversation invalide.');
  return fingerprint;
}

export function validateConversationSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Snapshot de conversation requis.');
  const urlConversation = requireConversationUrl(raw.url_conversation);
  const urlAnnonce = raw.url_annonce == null || raw.url_annonce === '' ? null : String(raw.url_annonce).trim();
  if (urlAnnonce && !AD_URL.test(urlAnnonce)) throw new Error('URL d’annonce leboncoin invalide.');
  if (!Array.isArray(raw.messages)) throw new Error('Messages de conversation requis.');
  const messages = raw.messages.slice(-500).map(normalizeMessage);
  const last = messages.at(-1) ?? null;
  const latestDated = [...messages].reverse().find((message) => message.envoye_le)?.envoye_le ?? null;
  const price = raw.annonce_prix_eur == null ? null : Number(raw.annonce_prix_eur);
  if (price != null && !Number.isFinite(price)) throw new Error('Prix d’annonce invalide.');
  return {
    url_conversation: urlConversation,
    url_annonce: urlAnnonce,
    vendeur: cleanText(raw.vendeur, { max: 200 }),
    annonce_titre: cleanText(raw.annonce_titre, { max: 500 }),
    annonce_prix_eur: price,
    statut: last?.expediteur === 'vendeur' ? 'en_attente_moi' : 'en_attente_vendeur',
    messages,
    dernier_message: last?.contenu ?? null,
    dernier_message_le: last?.envoye_le ?? latestDated,
    dernier_message_de: last?.expediteur ?? null,
    non_lus: Number.isInteger(raw.non_lus) && raw.non_lus >= 0 ? raw.non_lus : (last?.expediteur === 'vendeur' ? 1 : 0),
  };
}

function mapRow(row) {
  return {
    id: row.id,
    annonce_id: row.annonce_id,
    url_conversation: row.url_conversation,
    vendeur: row.vendeur,
    annonce_titre: row.annonce_titre,
    statut: row.statut,
    messages: Array.isArray(row.messages) ? row.messages : [],
    dernier_message: row.dernier_message,
    dernier_message_le: row.dernier_message_le,
    dernier_message_de: row.dernier_message_de,
    non_lus: row.non_lus,
    offre_envoyee_eur: row.offre_envoyee_eur == null ? null : Number(row.offre_envoyee_eur),
    offre_recue_eur: row.offre_recue_eur == null ? null : Number(row.offre_recue_eur),
    dernier_message_fingerprint: row.dernier_message_fingerprint,
    traite_le: row.traite_le,
    brouillon: row.brouillon,
    decision: row.decision ?? null,
    dernier_envoi_le: row.dernier_envoi_le,
    automation_erreur_code: row.automation_erreur_code,
    automation_erreur_le: row.automation_erreur_le,
    annonce: {
      url_annonce: row.url_annonce,
      titre: row.titre ?? row.annonce_titre,
      prix_eur: row.prix_eur == null ? null : Number(row.prix_eur),
      description: row.description,
      etat: row.etat,
      ville: row.ville,
      code_postal: row.code_postal,
      modes_remise: row.modes_remise,
      images: Array.isArray(row.images) ? row.images : [],
      image_url: row.image_url,
      livraison_possible: row.livraison_possible,
    },
  };
}

export async function listConversations(client) {
  const { rows } = await client.query(`${CONVERSATION_SELECT}
    order by (c.dernier_message_de = 'vendeur' or c.non_lus > 0) desc,
             c.dernier_message_le desc nulls last, c.created_at desc`);
  return rows.map(mapRow);
}

export async function loadConversationByUrl(client, urlConversation) {
  const url = requireConversationUrl(urlConversation);
  const { rows } = await client.query(`${CONVERSATION_SELECT} where c.url_conversation = $1 limit 1`, [url]);
  return rows[0] ? mapRow(rows[0]) : null;
}

// Périmètre « contacted » : cet outil a enregistré un contact sur cette
// annonce précise, quelle que soit la forme de son URL.
export async function isListingContacted(client, urlAnnonce) {
  const listId = listIdFromUrl(urlAnnonce);
  const { rows } = await client.query(
    `select 1 from public.annonces
      where contact_direct_le is not null
        and (url_annonce = $1 or list_id = $2::bigint or ${LIST_ID_SQL} = $3::text)
      limit 1`,
    [urlAnnonce, listId, listId],
  );
  return rows.length > 0;
}

export async function upsertConversation(client, raw) {
  const value = validateConversationSnapshot(raw);
  let annonceId = null;
  if (value.url_annonce) {
    const listId = listIdFromUrl(value.url_annonce);
    const annonce = await retryOnDuplicate(async () => client.query(
      `insert into public.annonces (url_annonce, titre, prix_eur, list_id)
       values ($1, $2, $3, $4)
       on conflict (url_annonce) do update set
         titre = coalesce(public.annonces.titre, excluded.titre),
         prix_eur = coalesce(public.annonces.prix_eur, excluded.prix_eur),
         list_id = coalesce(public.annonces.list_id, excluded.list_id)
       returning id`,
      [await resolveUrlAnnonce(client, value.url_annonce, 'public.annonces'),
        value.annonce_titre, value.annonce_prix_eur, listId],
    ));
    annonceId = annonce.rows[0]?.id ?? null;
  }
  const { rows } = await client.query(
    `insert into public.conversations (
       annonce_id, url_conversation, vendeur, annonce_titre, statut, messages,
       dernier_message, dernier_message_le, dernier_message_de, non_lus
     ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
     on conflict (url_conversation) do update set
       annonce_id = coalesce(excluded.annonce_id, public.conversations.annonce_id),
       vendeur = coalesce(excluded.vendeur, public.conversations.vendeur),
       annonce_titre = coalesce(excluded.annonce_titre, public.conversations.annonce_titre),
       statut = excluded.statut,
       messages = excluded.messages,
       dernier_message = excluded.dernier_message,
       dernier_message_le = coalesce(excluded.dernier_message_le, public.conversations.dernier_message_le),
       dernier_message_de = excluded.dernier_message_de,
       non_lus = excluded.non_lus
     returning *`,
    [annonceId, value.url_conversation, value.vendeur, value.annonce_titre, value.statut,
      JSON.stringify(value.messages), value.dernier_message, value.dernier_message_le,
      value.dernier_message_de, value.non_lus],
  );
  return rows[0] ?? null;
}

export async function reserveConversationTurn(client, urlConversation, rawFingerprint) {
  const url = requireConversationUrl(urlConversation);
  const fingerprint = requireFingerprint(rawFingerprint);
  const { rows } = await client.query(
    `update public.conversations
        set dernier_message_fingerprint = $2,
            traite_le = null,
            brouillon = null,
            decision = null,
            automation_erreur_code = null,
            automation_erreur_le = null
      where url_conversation = $1
        and (dernier_message_fingerprint is distinct from $2
             or automation_erreur_code = 'generation_echec'
             -- réservé puis interrompu avant tout brouillon : rien n'est parti
             or (traite_le is null and decision is null and brouillon is null
                 and automation_erreur_code is null))
      returning id, dernier_message_fingerprint`,
    [url, fingerprint],
  );
  return { reserved: rows.length === 1, id: rows[0]?.id ?? null };
}

export async function storeConversationDraft(client, urlConversation, fingerprint, draft) {
  const url = requireConversationUrl(urlConversation);
  const fp = requireFingerprint(fingerprint);
  const message = cleanText(draft?.message, { max: 4000 });
  const { rows } = await client.query(
    `update public.conversations set brouillon = $3, decision = $4::jsonb
      where url_conversation = $1 and dernier_message_fingerprint = $2
      returning *`, [url, fp, message, JSON.stringify(draft ?? null)],
  );
  if (!rows[0]) throw tourIntrouvable();
  return rows[0];
}

export async function markConversationSent(client, {
  urlConversation, fingerprint, message, offreProposeeEur = null, date = new Date(),
}) {
  const url = requireConversationUrl(urlConversation);
  const fp = requireFingerprint(fingerprint);
  const text = cleanText(message, { required: true });
  const offer = offreProposeeEur == null ? null : Number(offreProposeeEur);
  if (offer != null && !Number.isFinite(offer)) throw new Error('Offre proposée invalide.');
  const iso = date.toISOString();
  const { rows } = await client.query(
    `update public.conversations
        set messages = messages || jsonb_build_array(jsonb_build_object(
              'expediteur','moi','contenu',$3::text,'envoye_le',($5::timestamptz)::text,
              'type',case when $4::numeric is null then 'texte' else 'offre' end,
              'montant_eur',$4::numeric,'lu',true)),
            dernier_message = $3::text, dernier_message_le = $5::timestamptz,
            dernier_message_de = 'moi', non_lus = 0,
            statut = 'en_attente_vendeur', offre_envoyee_eur = coalesce($4, offre_envoyee_eur),
            dernier_envoi_le = $5::timestamptz, traite_le = $5::timestamptz, brouillon = null,
            automation_erreur_code = null, automation_erreur_le = null
      where url_conversation = $1 and dernier_message_fingerprint = $2
      returning *`, [url, fp, text, offer, iso],
  );
  if (!rows[0]) throw tourIntrouvable();
  return rows[0];
}

export async function markConversationHandled(client, urlConversation, fingerprint, date = new Date()) {
  const url = requireConversationUrl(urlConversation);
  const fp = requireFingerprint(fingerprint);
  const { rows } = await client.query(
    `update public.conversations
        set traite_le = $3, non_lus = 0, brouillon = null,
            automation_erreur_code = null, automation_erreur_le = null
      where url_conversation = $1 and dernier_message_fingerprint = $2
      returning *`, [url, fp, date.toISOString()],
  );
  if (!rows[0]) throw tourIntrouvable();
  return rows[0];
}

export async function markConversationError(client, urlConversation, fingerprint, code, date = new Date()) {
  const url = requireConversationUrl(urlConversation);
  const fp = requireFingerprint(fingerprint);
  if (!ERROR_CODES.has(code)) throw new Error('Code d’erreur d’automatisation invalide.');
  const { rows } = await client.query(
    `update public.conversations
        set automation_erreur_code = $3, automation_erreur_le = $4
      where url_conversation = $1 and dernier_message_fingerprint = $2${code === 'generation_echec'
    // « generation_echec » rouvre le tour : jamais sur un tour conclu ou incertain.
    ? ` and traite_le is null
        and (automation_erreur_code is null or automation_erreur_code = 'generation_echec')` : ''}
      returning *`, [url, fp, code, date.toISOString()],
  );
  if (!rows[0]) throw tourIntrouvable();
  return rows[0];
}
