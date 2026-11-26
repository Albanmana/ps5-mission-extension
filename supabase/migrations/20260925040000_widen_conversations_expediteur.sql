-- Vu sur la vraie messagerie leboncoin (/messages) : en plus des messages de
-- "moi" et du vendeur, des notices système apparaissent dans le fil
-- ("Annonce supprimée", "Votre vendeur peut être moins réactif...", "Celui-ci
-- ne pourra plus accéder à la messagerie...") et peuvent donc être le
-- dernier message d'une conversation. Le check constraint moi|vendeur était
-- trop strict.
alter table public.conversations
  drop constraint if exists conversations_dernier_message_de_check;

alter table public.conversations
  add constraint conversations_dernier_message_de_check
  check (dernier_message_de is null or dernier_message_de in ('moi', 'vendeur', 'systeme'));

comment on column public.conversations.dernier_message_de is
  'moi | vendeur | systeme — qui a envoyé le dernier message (systeme = notice automatique leboncoin, ex. annonce supprimée, vendeur moins réactif).';

comment on column public.conversations.messages is
  'Historique complet des messages de la conversation, dans l''ordre chronologique. '
  'ex. [{ "expediteur": "moi" | "vendeur" | "systeme", "contenu": "...", "envoye_le": "2026-09-25T18:16:56.000Z", "type": "texte" | "offre" | "image" | "notice", "montant_eur": number | null, "lu": boolean | null }]';
