// Seules données dont le dashboard a besoin. Aucune limite de lignes.

export const RAISON_DISQUALIFICATION_MANUELLE = 'Disqualifiée manuellement (dashboard)';

const COLONNES = `id, url_annonce, titre, prix_eur::float8 as prix_eur, etat, ville, code_postal, vendeur,
  images, image_url, classification, disqualifiee, disqualification_raison, lecteur_disque,
  manettes_incluses, livraison_possible, likes, accessoires_bonus, date_publication, created_at`;

export async function listerAnnoncesDashboard(client) {
  const { rows } = await client.query(`select ${COLONNES} from public.annonces order by created_at desc`);
  return rows;
}

// Disqualifier est une décision de l'utilisateur : le pipeline ne l'écrase
// plus. Ré-qualifier lève cette protection.
export async function definirDisqualification(client, id, disqualifiee) {
  const { rows } = await client.query(
    `update public.annonces
        set disqualifiee = $2, decision_manuelle = $2, classification = $3, disqualification_raison = $4
      where id = $1
      returning ${COLONNES}`,
    [id, disqualifiee, disqualifiee ? 'disqualifiee' : 'a_verifier',
      disqualifiee ? RAISON_DISQUALIFICATION_MANUELLE : null],
  );
  return rows[0] ?? null;
}
