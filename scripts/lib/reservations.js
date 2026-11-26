// Réservations de contact restées bloquées (navigateur fermé en plein envoi).
// Jamais libérées toutes seules : l'utilisateur dit si le message est parti.
import { finaliserContact, libererContact } from './annonces.js';
import { resolveUrlAnnonce } from './listing.js';

export const RESERVATION_BLOQUEE_MS = 10 * 60 * 1000;

const limite = (maintenant) => new Date(maintenant.getTime() - RESERVATION_BLOQUEE_MS);
const iso = (date) => date instanceof Date ? date.toISOString() : date;

export async function listerReservationsBloquees(client, maintenant = new Date()) {
  const { rows } = await client.query(
    `select url_annonce, titre, vendeur, contact_reservation_le as reservation_le
       from annonces
      where contact_reservation_token is not null and contact_reservation_le < $1
      order by contact_reservation_le, url_annonce`,
    [limite(maintenant)],
  );
  return rows.map((row) => ({ ...row, reservation_le: iso(row.reservation_le) }));
}

export async function resoudreReservation(client, urlAnnonce, resultat, maintenant = new Date()) {
  if (resultat !== 'envoye' && resultat !== 'non_envoye') throw new Error(`Résultat invalide : ${resultat}`);
  const url = await resolveUrlAnnonce(client, urlAnnonce);
  const { rows } = await client.query(
    `select contact_reservation_token as token, contact_reservation_le as reservation_le
       from annonces
      where url_annonce = $1 and contact_reservation_token is not null and contact_reservation_le < $2`,
    [url, limite(maintenant)],
  );
  if (!rows[0]) return { resolue: false };
  if (resultat === 'non_envoye') return { resolue: (await libererContact(client, url, rows[0].token)).liberee };
  // La date du contact est celle de la tentative, pas celle de la réponse.
  await finaliserContact(client, url, rows[0].token, 'confirme', rows[0].reservation_le);
  return { resolue: true };
}
