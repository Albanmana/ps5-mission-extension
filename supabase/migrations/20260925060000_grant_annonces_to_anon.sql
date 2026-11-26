-- RLS est désactivée sur annonces (table locale, pas de multi-utilisateur),
-- mais PostgREST refuse quand même les requêtes du rôle `anon` sans GRANT
-- explicite. Nécessaire pour que dashboard.html (page HTML statique qui
-- interroge directement l'API REST avec la clé anon locale) puisse lire et
-- mettre à jour les annonces (bouton "Disqualifier"/"Ré-qualifier").
grant select, update on public.annonces to anon;
