// Upsert d'une annonce par url_annonce (clé UNIQUE depuis la première
// migration). Ne touche jamais aux colonnes du pipeline IA : c'est
// classify.js qui les écrit.
import { randomUUID } from 'node:crypto';
import { listIdFromUrl, resolveUrlAnnonce, retryOnDuplicate, LIST_ID_SQL } from './listing.js';

const COLUMNS = [
  'url_annonce', 'vendeur', 'titre', 'prix_eur', 'etat', 'type', 'marque',
  'plateforme', 'livraison_possible', 'ville', 'code_postal', 'quartier',
  'image_url', 'images', 'sponsorise', 'list_id', 'description', 'date_publication',
  // Ces trois colonnes existaient depuis le début mais manquaient ici : les
  // valeurs étaient extraites puis silencieusement jetées à l'écriture.
  'likes', 'modes_remise', 'call_to_actions',
];

export async function upsertAnnonce(client, annonce) {
  return retryOnDuplicate(() => ecrireAnnonce(client, annonce));
}

async function ecrireAnnonce(client, recue) {
  const listId = recue.list_id ?? listIdFromUrl(recue.url_annonce);
  // Une même annonce sous une autre forme d'URL met à jour la ligne existante.
  const existing = await client.query(
    `select url_annonce, analyse_ia_le from annonces
      where url_annonce = $1 or list_id = $2::bigint or (list_id is null and ${LIST_ID_SQL} = $3::text)
      order by (list_id is not null) desc, (url_annonce = $1) desc limit 1`,
    [recue.url_annonce, listId, listId == null ? null : String(listId)],
  );
  const present = existing.rows.length > 0;
  const dejaAnalysee = present && existing.rows[0].analyse_ia_le != null;
  const annonce = { ...recue, url_annonce: existing.rows[0]?.url_annonce ?? recue.url_annonce };

  const values = { ...annonce, list_id: listId };
  const cols = COLUMNS.filter((column) => values[column] != null);
  const placeholders = cols.map((_, index) => `$${index + 1}`);
  // coalesce : ne jamais écraser une valeur déjà en base par un null entrant.
  const updates = cols
    .filter((column) => column !== 'url_annonce')
    .map((column) => `${column} = coalesce(excluded.${column}, annonces.${column})`);

  await client.query(
    `insert into annonces (${cols.join(', ')}) values (${placeholders.join(', ')})
     on conflict (url_annonce) do update set ${updates.join(', ')}`,
    cols.map((column) => values[column]),
  );

  return { created: !present, deja_analysee: dejaAnalysee };
}

const RANG_CLASSIFICATION = `case classification
  when 'saint_graal' then 0
  when 'interessant' then 1
  when 'a_verifier' then 2
  else 3 end`;

export const CONTACT_ERREUR_CODES = new Set([
  'reply_indisponible',
  'formulaire_absent',
  'envoi_incertain',
]);

// Le nom est la seule identité vendeur disponible. Une clé vide ne doit
// jamais regrouper des vendeurs inconnus ; elle reste propre à chaque URL.
const vendeurCleSql = "nullif(lower(regexp_replace(vendeur, '^[[:space:]]+|[[:space:]]+$', '', 'g')), '')";
const ANNONCES_VENDEURS = `select *,
  ${vendeurCleSql} as vendeur_cle
  from annonces`;

// Les classements enregistrés datent des prix de l’analyse : `prixMax` applique
// le maximum actuel, avant de choisir l’annonce retenue pour chaque vendeur.
export async function chargerShortlist(client, { limite = 50, prixMax = null } = {}) {
  const { rows } = await client.query(
    `with vendeurs as (${ANNONCES_VENDEURS}),
     classees as (
       select a.*, row_number() over (
         partition by vendeur_cle, case when vendeur_cle is null then url_annonce end
         order by ${RANG_CLASSIFICATION}, prix_eur asc nulls last, url_annonce
       ) as choix_vendeur
       from vendeurs a
       where contacte_le is null and contact_erreur_code is null and disqualifiee = false
         and classification in ('saint_graal', 'interessant')
         ${prixMax === null ? '' : 'and prix_eur <= $2'}
         and not exists (
           select 1 from vendeurs contact
           where contact.vendeur_cle = a.vendeur_cle and contact.contacte_le is not null
         )
     )
     select url_annonce, titre, vendeur, prix_eur, ville, classification, image_url,
            lecteur_disque, manettes_incluses
       from classees where choix_vendeur = 1
      order by ${RANG_CLASSIFICATION}, prix_eur asc nulls last, url_annonce
      limit $1`,
    prixMax === null ? [limite] : [limite, prixMax],
  );
  return rows;
}

// Une annonce dont la classification a échoué reste sans `analyse_ia_le`.
// Rien ne la reprend : le run de recherche ne la revoit que si elle réapparaît
// dans les résultats, ce qui n'arrive pas si elle est vendue ou hors des pages
// parcourues. Cette lecture permet de rattraper ces oubliées directement.
export async function chargerNonAnalysees(client, { limite = 500 } = {}) {
  const { rows } = await client.query(
    `select * from annonces
      where analyse_ia_le is null
      order by created_at asc nulls last, url_annonce
      limit $1`,
    [limite],
  );
  return rows;
}

// Annonces connues seulement par leur carte de résultats : pas de description,
// une seule photo. C'est avec si peu que le modèle confond les deux éditions.
// Le run de recherche ne visite que 50 fiches et n'y revient jamais, d'où ce
// rattrapage. Les plus prometteuses d'abord : le budget de requêtes est limité.
export async function chargerAEnrichir(client, { limite = 50 } = {}) {
  const { rows } = await client.query(
    `select url_annonce, titre, classification, prix_eur
       from annonces
      where description is null and disqualifiee = false
      order by ${RANG_CLASSIFICATION}, prix_eur asc nulls last, url_annonce
      limit $1`,
    [limite],
  );
  return rows;
}

// Une annonce retirée de leboncoin ne sera jamais enrichie : on la disqualifie
// pour qu'elle quitte la file et la shortlist — elle n'est plus achetable.
export async function marquerIntrouvable(client, urlRecue) {
  const urlAnnonce = await resolveUrlAnnonce(client, urlRecue);
  const { rowCount } = await client.query(
    `update annonces
        set disqualifiee = true,
            decision_manuelle = true,
            classification = 'disqualifiee',
            disqualification_raison = 'Annonce supprimée de leboncoin.'
      where url_annonce = $1`,
    [urlAnnonce],
  );
  return { marquee: rowCount > 0 };
}

export async function marquerContactee(client, urlRecue, date = new Date()) {
  const urlAnnonce = await resolveUrlAnnonce(client, urlRecue);
  const { rows } = await client.query(
    `with vendeurs as (${ANNONCES_VENDEURS}),
     cible as (select vendeur_cle from vendeurs where url_annonce = $1),
     correspondantes as (
       select url_annonce, contacte_le from vendeurs
       where url_annonce = $1 or vendeur_cle = (select vendeur_cle from cible)
     ),
     premier_contact as (select coalesce(min(contacte_le), $2::timestamptz) as date from correspondantes)
     update annonces a set contacte_le = coalesce(a.contacte_le, premier_contact.date),
         contact_direct_le = case when a.url_annonce = $1
           then coalesce(a.contact_direct_le, $2::timestamptz) else a.contact_direct_le end
       from correspondantes, premier_contact
      where a.url_annonce = correspondantes.url_annonce
      returning a.url_annonce, a.contacte_le`,
    [urlAnnonce, date],
  );
  const contacted = rows.find((row) => row.url_annonce === urlAnnonce);
  if (!contacted) throw new Error(`Annonce inconnue en base : ${urlAnnonce}`);
  return { contacte_le: contacted.contacte_le instanceof Date ? contacted.contacte_le.toISOString() : contacted.contacte_le };
}

const iso = (date) => date instanceof Date ? date.toISOString() : date;

async function transactionContact(client, run) {
  await client.query('begin');
  try {
    const result = await run();
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Conserver l'erreur d'origine si la connexion a déjà échoué.
    }
    throw error;
  }
}

function cleVerrou(vendeurCle, urlAnnonce) {
  return vendeurCle === null ? `url:${urlAnnonce}` : `vendeur:${vendeurCle}`;
}

class CleVendeurModifiee extends Error {}

async function cibleVerrouillee(client, urlAnnonce, token) {
  const initiale = await client.query(
    `select ${vendeurCleSql} as vendeur_cle from annonces where url_annonce = $1`,
    [urlAnnonce],
  );
  if (initiale.rows.length === 0) return null;
  const vendeurCle = initiale.rows[0].vendeur_cle;
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [cleVerrou(vendeurCle, urlAnnonce)]);
  const avecToken = token !== undefined;
  const cible = await client.query(
    avecToken
      ? `select url_annonce, ${vendeurCleSql} as vendeur_cle
           from annonces where url_annonce = $1 and contact_reservation_token = $2 for update`
      : `select url_annonce, ${vendeurCleSql} as vendeur_cle
           from annonces where url_annonce = $1 for update`,
    avecToken ? [urlAnnonce, token] : [urlAnnonce],
  );
  if (cible.rows.length === 0) return null;
  if (cible.rows[0].vendeur_cle !== vendeurCle) throw new CleVendeurModifiee('Identité vendeur modifiée pendant le verrouillage');
  return cible.rows[0];
}

async function transactionVendeur(client, urlAnnonce, token, run) {
  for (let tentative = 0; tentative < 2; tentative += 1) {
    try {
      return await transactionContact(client, async () => run(await cibleVerrouillee(client, urlAnnonce, token)));
    } catch (error) {
      if (!(error instanceof CleVendeurModifiee) || tentative === 1) throw error;
    }
  }
}

export async function reserverContact(client, urlRecue, date = new Date()) {
  const urlAnnonce = await resolveUrlAnnonce(client, urlRecue);
  return transactionVendeur(client, urlAnnonce, undefined, async (cible) => {
    if (cible === null) return { reservee: false, raison: 'annonce_inconnue' };
    const vendeurCle = cible.vendeur_cle;
    const groupe = await client.query(
      `select url_annonce, contacte_le, contact_erreur_code, contact_reservation_token
         from annonces
        where url_annonce = $1 or ($2::text is not null and ${vendeurCleSql} = $2)`,
      [urlAnnonce, vendeurCle],
    );
    const exacte = groupe.rows.find((row) => row.url_annonce === urlAnnonce);
    if (exacte.contact_erreur_code !== null) return { reservee: false, raison: 'erreur_contact' };
    if (groupe.rows.some((row) => row.contacte_le !== null)) return { reservee: false, raison: 'vendeur_contacte' };
    if (groupe.rows.some((row) => row.contact_reservation_token !== null)) return { reservee: false, raison: 'reservation_existante' };

    const reservationToken = randomUUID();
    const { rows } = await client.query(
      `update annonces set contact_reservation_token = $2, contact_reservation_le = $3
        where url_annonce = $1 returning contact_reservation_le`,
      [urlAnnonce, reservationToken, date],
    );
    return { reservee: true, reservation_token: reservationToken, reservation_le: iso(rows[0].contact_reservation_le) };
  });
}

export async function finaliserContact(client, urlRecue, token, resultat, date = new Date()) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('Jeton de réservation de contact requis');
  if (resultat !== 'confirme' && resultat !== 'incertain') throw new Error(`Résultat de contact invalide : ${resultat}`);
  const urlAnnonce = await resolveUrlAnnonce(client, urlRecue);
  return transactionVendeur(client, urlAnnonce, token, async (cible) => {
    if (cible === null) throw new Error(`Réservation de contact inconnue : ${urlAnnonce}`);
    const vendeurCle = cible.vendeur_cle;
    const groupe = await client.query(
      `select contacte_le from annonces
        where url_annonce = $1 or ($2::text is not null and ${vendeurCleSql} = $2)`,
      [urlAnnonce, vendeurCle],
    );
    const premierContact = new Date(Math.min(
      new Date(date).getTime(),
      ...groupe.rows.filter((row) => row.contacte_le !== null).map((row) => row.contacte_le.getTime()),
    ));
    const { rows } = await client.query(
      `update annonces
          set contacte_le = $3,
              contact_direct_le = case when url_annonce = $1 then coalesce(contact_direct_le, $5) else contact_direct_le end,
              contact_reservation_token = null,
              contact_reservation_le = null,
              contact_erreur_code = case when url_annonce = $1 and $4 = 'incertain' then 'envoi_incertain' else contact_erreur_code end,
              contact_erreur_le = case when url_annonce = $1 and $4 = 'incertain' then $5 else contact_erreur_le end
        where url_annonce = $1 or ($2::text is not null and ${vendeurCleSql} = $2)
        returning url_annonce, contacte_le, contact_erreur_code, contact_erreur_le`,
      [urlAnnonce, vendeurCle, premierContact, resultat, date],
    );
    const exacte = rows.find((row) => row.url_annonce === urlAnnonce);
    return resultat === 'incertain'
      ? { contacte_le: iso(exacte.contacte_le), contact_erreur_code: exacte.contact_erreur_code, contact_erreur_le: iso(exacte.contact_erreur_le) }
      : { contacte_le: iso(exacte.contacte_le) };
  });
}

export async function libererContact(client, urlRecue, token) {
  const urlAnnonce = await resolveUrlAnnonce(client, urlRecue);
  return transactionContact(client, async () => {
    const { rowCount } = await client.query(
      `update annonces set contact_reservation_token = null, contact_reservation_le = null
        where url_annonce = $1 and contact_reservation_token = $2`,
      [urlAnnonce, token],
    );
    return { liberee: rowCount > 0 };
  });
}

export async function marquerErreurContact(client, urlRecue, code, date = new Date(), reservationToken) {
  if (!CONTACT_ERREUR_CODES.has(code)) throw new Error(`Code d’erreur de contact invalide : ${code}`);
  const urlAnnonce = await resolveUrlAnnonce(client, urlRecue);
  const avecReservation = reservationToken !== undefined;
  const { rows } = await client.query(
    `update annonces
        set contact_erreur_code = $2,
            contact_erreur_le = $3${code === 'envoi_incertain' ? ', contact_direct_le = coalesce(contact_direct_le, $3)' : ''}${avecReservation ? ', contact_reservation_token = null, contact_reservation_le = null' : ''}
      where url_annonce = $1${avecReservation ? ' and contact_reservation_token = $4' : ''}
      returning contact_erreur_code, contact_erreur_le`,
    avecReservation ? [urlAnnonce, code, date, reservationToken] : [urlAnnonce, code, date],
  );
  if (rows.length === 0) throw new Error(`Annonce inconnue ou réservation invalide en base : ${urlAnnonce}`);
  const marked = rows[0];
  return {
    contact_erreur_code: marked.contact_erreur_code,
    contact_erreur_le: marked.contact_erreur_le instanceof Date
      ? marked.contact_erreur_le.toISOString() : marked.contact_erreur_le,
  };
}
