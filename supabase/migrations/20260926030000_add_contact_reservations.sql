alter table public.annonces
  add column if not exists contact_reservation_token text,
  add column if not exists contact_reservation_le timestamptz;

create index if not exists annonces_contact_reservation_token_idx
  on public.annonces (contact_reservation_token)
  where contact_reservation_token is not null;
