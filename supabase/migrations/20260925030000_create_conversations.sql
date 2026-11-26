-- Conversations de messagerie leboncoin avec un vendeur, rattachées à une annonce.
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),

  -- Nullable + set null : si l'annonce est supprimée, on garde l'historique
  -- de la conversation plutôt que de la perdre.
  annonce_id uuid references public.annonces (id) on delete set null,

  url_conversation text unique,
  vendeur text,

  statut text not null default 'ouverte',

  -- Historique complet des messages échangés, dans l'ordre chronologique.
  -- ex. [{ "expediteur": "moi" | "vendeur", "contenu": "...", "envoye_le": "2026-09-25T18:16:56.000Z", "type": "texte" | "offre" | "image" }]
  messages jsonb not null default '[]'::jsonb,

  dernier_message text,
  dernier_message_le timestamptz,
  dernier_message_de text,
  non_lus integer not null default 0,

  offre_envoyee_eur numeric,
  offre_recue_eur numeric,

  rdv_propose boolean not null default false,
  rdv_date timestamptz,
  rdv_lieu text,

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.conversations.annonce_id is
  'Annonce concernée par la conversation. Nullable : conservée si l''annonce est supprimée.';
comment on column public.conversations.statut is
  'ouverte | en_attente_vendeur | en_attente_moi | rdv_pris | conclue | abandonnee.';
comment on column public.conversations.messages is
  'Historique complet des messages de la conversation, dans l''ordre chronologique (voir commentaire de colonne pour le format).';
comment on column public.conversations.dernier_message_de is
  'moi | vendeur — qui a envoyé le dernier message (pour savoir qui doit répondre).';

alter table public.conversations
  add constraint conversations_statut_check
  check (statut in ('ouverte', 'en_attente_vendeur', 'en_attente_moi', 'rdv_pris', 'conclue', 'abandonnee'));

alter table public.conversations
  add constraint conversations_dernier_message_de_check
  check (dernier_message_de is null or dernier_message_de in ('moi', 'vendeur'));

create index if not exists conversations_annonce_id_idx on public.conversations (annonce_id);
create index if not exists conversations_statut_idx on public.conversations (statut);
create index if not exists conversations_dernier_message_le_idx on public.conversations (dernier_message_le);

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
  before update on public.conversations
  for each row
  execute function public.set_updated_at();
