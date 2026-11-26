-- Annonces leboncoin PS5 (recherche + page annonce).
create table if not exists public.annonces (
  id uuid primary key default gen_random_uuid(),
  url_annonce text not null unique,
  vendeur text,
  titre text,
  prix_eur numeric,
  etat text,
  type text,
  marque text,
  plateforme text,
  livraison_possible boolean not null default false,
  ville text,
  code_postal text,
  quartier text,
  image_url text,
  sponsorise boolean not null default false,

  -- Champs capturés sur la page annonce (pas dispo depuis la page de résultats).
  -- modes_remise: { "main_propre": {...}, "point_retrait": {...}, "domicile": {...} }
  -- ex. "point_retrait": { "disponible": true, "prix_min_eur": 6.49, "delai": "3 à 5 jours ouvrés" }
  modes_remise jsonb,
  images text[],
  likes integer,
  call_to_actions text[],

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists annonces_prix_eur_idx on public.annonces (prix_eur);
create index if not exists annonces_created_at_idx on public.annonces (created_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists annonces_set_updated_at on public.annonces;
create trigger annonces_set_updated_at
  before update on public.annonces
  for each row
  execute function public.set_updated_at();
