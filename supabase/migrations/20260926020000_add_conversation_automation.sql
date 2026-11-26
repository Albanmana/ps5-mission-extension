alter table public.conversations
  add column if not exists dernier_message_fingerprint text,
  add column if not exists traite_le timestamptz,
  add column if not exists brouillon text,
  add column if not exists dernier_envoi_le timestamptz,
  add column if not exists automation_erreur_code text,
  add column if not exists automation_erreur_le timestamptz;

create index if not exists conversations_automation_pending_idx
  on public.conversations (dernier_message_de, non_lus, dernier_message_le desc)
  where statut in ('ouverte', 'en_attente_moi');

comment on column public.conversations.dernier_message_fingerprint is
  'Empreinte du dernier tour vendeur réservé ou traité par l automatisation.';
comment on column public.conversations.traite_le is
  'Date de finalisation du dernier tour automatisé, avec ou sans envoi.';
comment on column public.conversations.brouillon is
  'Dernier brouillon IA réservé avant envoi, conservé pour audit et reprise manuelle.';
comment on column public.conversations.dernier_envoi_le is
  'Date du dernier envoi Leboncoin confirmé par le DOM.';
comment on column public.conversations.automation_erreur_code is
  'generation_echec | envoi_incertain | persistance_echec | bloque | connexion_requise.';
