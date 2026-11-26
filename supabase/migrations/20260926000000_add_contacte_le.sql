-- Date du premier message de contact envoyé au vendeur.
-- Sert à filtrer la shortlist de l'onglet Contact et, surtout, à ne jamais
-- recontacter deux fois le même vendeur.
alter table annonces add column if not exists contacte_le timestamptz;

-- Index partiel : la requête de shortlist ne cherche que les non contactées.
create index if not exists annonces_non_contactees_idx
  on annonces (classification, prix_eur)
  where contacte_le is null and disqualifiee = false;
