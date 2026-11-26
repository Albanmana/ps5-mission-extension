# Fonctions communes à setup.sh et dev.sh (à charger avec « source »).
#
# La base locale a un mot de passe public (postgres/postgres). Le réseau
# Docker ci-dessous demande de ne publier ses ports que sur 127.0.0.1 : c'est
# l'option documentée par Supabase. On vérifie ensuite le résultat avec lsof.

RESEAU_LOCAL=ps5-mission-local
PORT_BASE=54322

demarrer_base() {
  if ! docker network inspect "$RESEAU_LOCAL" >/dev/null 2>&1; then
    if ! docker network create -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$RESEAU_LOCAL" >/dev/null; then
      echo "ÉCHEC : impossible de créer le réseau Docker local « $RESEAU_LOCAL »." >&2
      return 1
    fi
  fi
  if ! supabase start --network-id "$RESEAU_LOCAL"; then
    echo "ÉCHEC : démarrage de la base locale (supabase start)." >&2
    echo "  Vérifiez que Docker Desktop est démarré. Si le port $PORT_BASE est déjà pris," >&2
    echo "  arrêtez l'autre projet Supabase (supabase stop dans son dossier)." >&2
    return 1
  fi
  verifier_ecoute_locale
}

verifier_ecoute_locale() {
  if lsof -nP -iTCP:"$PORT_BASE" -sTCP:LISTEN 2>/dev/null | grep -qE "(\*|0\.0\.0\.0):$PORT_BASE "; then
    echo "ATTENTION : la base (port $PORT_BASE) écoute sur toutes les interfaces, avec un" >&2
    echo "  mot de passe par défaut. N'utilisez pas l'outil sur un réseau non fiable et" >&2
    echo "  activez le pare-feu de macOS. Voir la section « Dépannage » du README." >&2
  fi
}

# Applique les migrations en attente. Ne remet jamais la base à zéro.
appliquer_migrations() {
  if ! supabase migration up --local; then
    echo "ÉCHEC : les migrations n'ont pas été appliquées (supabase migration up --local)." >&2
    echo "  Vos données sont conservées. Ne lancez JAMAIS « supabase db reset »." >&2
    return 1
  fi
}
