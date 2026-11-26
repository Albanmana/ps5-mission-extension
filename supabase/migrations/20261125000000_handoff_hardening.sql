-- Contact enregistré sur CETTE annonce précise. contacte_le est recopié sur
-- toutes les annonces d'un même vendeur : trop large pour borner les réponses.
alter table public.annonces add column if not exists contact_direct_le timestamptz;

comment on column public.annonces.contact_direct_le is
  'Date du contact confirmé ou incertain envoyé par cet outil sur cette annonce précise.';

-- Reprise de l'existant, uniquement quand l'annonce exacte est certaine :
-- envoi incertain, ou seule annonce contactée parmi celles de ce vendeur.
with cles as (
  select id, contacte_le, contact_erreur_code,
    coalesce(nullif(lower(regexp_replace(vendeur, '^[[:space:]]+|[[:space:]]+$', '', 'g')), ''), id::text) as cle
  from public.annonces
),
uniques as (
  select cle from cles where contacte_le is not null group by cle having count(*) = 1
)
update public.annonces a
   set contact_direct_le = coalesce(a.contacte_le, a.contact_erreur_le)
  from cles
 where cles.id = a.id
   and a.contact_direct_le is null
   and (cles.contact_erreur_code = 'envoi_incertain'
        or (cles.contacte_le is not null and cles.cle in (select cle from uniques)));

-- Un vendeur aux plusieurs annonces échappe à la reprise ci-dessus. On reprend
-- aussi les annonces avec une preuve propre : une conversation liée à CETTE
-- annonce où l'outil a confirmé un envoi (dernier_envoi_le). Un message tapé à
-- la main ne suffit pas : dans le doute, l'outil ne répond pas.
with preuves as (
  select annonce_id, min(dernier_envoi_le) as envoi_le
  from public.conversations
  where annonce_id is not null and dernier_envoi_le is not null
  group by annonce_id
)
update public.annonces a
   set contact_direct_le = preuves.envoi_le
  from preuves
 where a.id = preuves.annonce_id
   and a.contact_direct_le is null;

-- Décision prise à la main (dashboard) ou annonce supprimée : une nouvelle
-- analyse, même forcée, ne doit pas l'écraser.
alter table public.annonces add column if not exists decision_manuelle boolean not null default false;

update public.annonces set decision_manuelle = true
 where disqualifiee
   and disqualification_raison in ('Disqualifiée manuellement (dashboard)', 'Annonce supprimée de leboncoin.');

-- Décision complète du modèle, pour rendre un point d'arrêt non encore traité.
alter table public.conversations add column if not exists decision jsonb;

-- Le dashboard passe désormais par le serveur local : plus aucun accès direct.
revoke all on public.annonces from anon, authenticated;
revoke all on public.conversations from anon, authenticated;
