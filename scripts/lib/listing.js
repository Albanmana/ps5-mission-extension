// Identité d'une annonce leboncoin. La même annonce circule sous plusieurs
// formes d'URL (autre rubrique, query string) : seul son numéro est stable.

export function listIdFromUrl(url) {
  return String(url ?? '').match(/\/(\d+)\/?(?:[?#].*)?$/)?.[1] ?? null;
}

// Expression SQL du numéro pour les anciennes lignes sans list_id.
export const LIST_ID_SQL = "substring(url_annonce from '/([0-9]+)/?(?:[?#].*)?$')";

// Rend l'URL sous laquelle l'annonce est déjà enregistrée, sinon celle reçue.
export async function resolveUrlAnnonce(client, url, table = 'annonces') {
  const listId = listIdFromUrl(url);
  if (listId === null) return url;
  const { rows } = await client.query(
    `select url_annonce from ${table}
      where url_annonce = $1 or list_id = $2::bigint
         or (list_id is null and ${LIST_ID_SQL} = $3::text)
      order by (list_id is not null) desc, (url_annonce = $1) desc
      limit 1`,
    [url, listId, listId],
  );
  return rows[0]?.url_annonce ?? url;
}

// Deux requêtes simultanées sous deux formes d'URL peuvent toutes deux croire
// l'annonce absente : la perdante heurte l'index unique et recommence.
export async function retryOnDuplicate(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code !== '23505') throw error;
    return operation();
  }
}
