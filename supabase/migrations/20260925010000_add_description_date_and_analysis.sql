-- Champs supplémentaires capturés sur la page annonce (via __NEXT_DATA__) :
-- description intégrale et date de publication exacte (déjà absolue côté site,
-- pas de parsing de date relative "aujourd'hui"/"hier" nécessaire).
alter table public.annonces
  add column if not exists description text,
  add column if not exists date_publication timestamptz;

comment on column public.annonces.date_publication is
  'Date exacte de publication, telle que fournie par le site (ad.first_publication_date). Ne pas déduire d''un texte relatif ("aujourd''hui", "hier") : le site fournit déjà une date absolue.';

-- Pipeline de classification IA (vision + décision) sur les critères de l'utilisateur :
-- 1) éliminatoire : PS5 à lecteur de disque (pas "Digital"/édition digitale) ;
-- 2) au moins une manette incluse ;
-- 3) prix <= 370€ ("intéressant"), <= 350€ ("saint_graal") ;
-- 4) bonus : accessoires/jeux en plus ; 5) annonce récente (via date_publication).
alter table public.annonces
  add column if not exists lecteur_disque boolean,
  add column if not exists manettes_incluses integer,
  add column if not exists accessoires_bonus text[],
  add column if not exists disqualifiee boolean not null default false,
  add column if not exists disqualification_raison text,
  add column if not exists classification text,
  add column if not exists analyse_ia jsonb,
  add column if not exists analyse_ia_le timestamptz;

comment on column public.annonces.lecteur_disque is
  'true = PS5 à lecteur de disque confirmée, false = édition Digitale (sans lecteur) détectée, null = pas encore analysé.';
comment on column public.annonces.disqualifiee is
  'true si l''annonce ne passe pas le critère éliminatoire (pas de lecteur de disque). Voir disqualification_raison.';
comment on column public.annonces.classification is
  'Verdict du modèle de décision : saint_graal | interessant | a_verifier | disqualifiee.';
comment on column public.annonces.analyse_ia is
  'Sortie brute du pipeline IA (descriptions d''images par le modèle de vision, raisonnement du modèle de décision, nom des modèles utilisés) pour audit.';

alter table public.annonces
  add constraint annonces_classification_check
  check (classification is null or classification in ('saint_graal', 'interessant', 'a_verifier', 'disqualifiee'));

create index if not exists annonces_classification_idx on public.annonces (classification);
create index if not exists annonces_date_publication_idx on public.annonces (date_publication);
