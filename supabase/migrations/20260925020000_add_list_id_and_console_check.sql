-- ID numérique leboncoin (dernier segment de l'URL, ex. 1000000005 pour
-- .../consoles/1000000005), utile pour des lookups/joins sans parser l'URL.
-- url_annonce reste la clé de dédup de référence (déjà UNIQUE) ; list_id est
-- un confort en plus, pas un remplacement.
alter table public.annonces
  add column if not exists list_id bigint;

update public.annonces
  set list_id = substring(url_annonce from '(\d+)$')::bigint
  where list_id is null;

create unique index if not exists annonces_list_id_idx on public.annonces (list_id);

-- Étage 1 du pipeline IA : avant même de regarder les photos (lecteur_disque),
-- on vérifie via Jev, à partir du seul texte (titre/attributs), que l'annonce
-- concerne bien une console PS5 et pas un accessoire (casque VR, manette
-- seule, façade, support...). Évite de payer un appel vision inutile.
alter table public.annonces
  add column if not exists est_console boolean;

comment on column public.annonces.est_console is
  'true = confirmé console PS5 par Jev (étage 1, texte seul), false = probablement un accessoire (annonce alors disqualifiee sans passer par le modèle de vision), null = pas encore analysé.';
