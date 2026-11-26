-- Cache du titre de l'annonce tel qu'affiché dans la messagerie leboncoin.
-- Utile surtout quand annonce_id est null (annonce supprimée depuis) : on
-- garde une trace du contexte de la conversation sans dépendre d'une ligne
-- annonces qui n'existe plus / n'a jamais existé côté leboncoin.
alter table public.conversations
  add column if not exists annonce_titre text;

comment on column public.conversations.annonce_titre is
  'Titre de l''annonce tel qu''affiché dans le panneau de la messagerie leboncoin, conservé même si annonce_id est null (annonce supprimée).';
