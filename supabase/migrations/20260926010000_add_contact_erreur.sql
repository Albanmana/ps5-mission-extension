-- Échec terminal du premier contact automatisé. Les erreurs transitoires
-- (réseau, navigateur, anti-bot) ne sont jamais persistées ici.
alter table annonces add column if not exists contact_erreur_code text;
alter table annonces add column if not exists contact_erreur_le timestamptz;

alter table annonces drop constraint if exists annonces_contact_erreur_code_check;
alter table annonces add constraint annonces_contact_erreur_code_check
  check (contact_erreur_code is null or contact_erreur_code in
    ('reply_indisponible', 'formulaire_absent', 'envoi_incertain'));

create index if not exists annonces_contactables_idx
  on annonces (classification, prix_eur)
  where contacte_le is null and contact_erreur_code is null and disqualifiee = false;
