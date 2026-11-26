#!/usr/bin/env bash
# Démarre tout l'environnement local et affiche les URLs.
#
# Idempotent : chaque service déjà lancé est réutilisé tel quel, jamais
# redémarré. Les migrations en attente sont appliquées à chaque lancement.
#
# Ctrl+C arrête uniquement le serveur démarré par CE script. La base reste en
# route (« supabase stop » l'arrête sans effacer les données).

set -uo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RACINE" || exit 1
source "$RACINE/scripts/supabase-local.sh"

PORT_SERVEUR=8835

enfants=()

occupe() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# Un port ouvert ne prouve pas que le serveur fonctionne : on interroge
# la route de santé, celle-là même qu'appelle l'extension.
sain() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST \
      "http://127.0.0.1:$1/api/health" \
      -H 'content-type: application/json' -d '{}' 2>/dev/null)" = "200" ]
}

demarrage_de() {
  local brut
  brut=$(ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//') || return 1
  [ -n "$brut" ] || return 1
  date -j -f '%a %b %e %T %Y' "$brut" +%s 2>/dev/null
}

# Date de la dernière modification du code serveur, pour repérer un processus
# qui tourne encore sur une version antérieure.
code_modifie_le() {
  find scripts negociation.html dashboard.html extension/lib/settings.js -type f -exec stat -f '%m' {} + 2>/dev/null \
    | sort -rn | head -1
}

# Attend qu'un port réponde ; abandonne dès que le processus est mort.
attendre() {
  local port=$1 pid=$2 limite=${3:-30} i=0
  while ! occupe "$port"; do
    kill -0 "$pid" 2>/dev/null || return 1
    i=$((i + 1))
    [ "$i" -ge "$((limite * 10))" ] && return 1
    sleep 0.1
  done
}

nettoyer() {
  local code=${1:-0}
  [ ${#enfants[@]} -eq 0 ] && exit "$code"
  echo ""
  echo "Arrêt des services démarrés par ce script…"
  for pid in "${enfants[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  exit "$code"
}
trap nettoyer INT TERM

if [ ! -f .env ]; then
  echo "ÉCHEC : fichier .env absent. Lancez d'abord : npm run setup" >&2
  exit 1
fi

# « supabase start » ne fait rien si la base de CE projet tourne déjà, et
# échoue si un autre projet occupe le port : on ne migre jamais la mauvaise base.
echo "▸ Base de données locale"
choisir_supabase || exit 1
demarrer_base || exit 1

echo "▸ Migrations en attente"
appliquer_migrations || exit 1

echo "▸ Serveur local (API de l'extension + copilote)"
if occupe "$PORT_SERVEUR"; then
  if sain "$PORT_SERVEUR"; then
    pid=$(lsof -nP -iTCP:"$PORT_SERVEUR" -sTCP:LISTEN -t 2>/dev/null | head -1)
    demarre=$(demarrage_de "$pid")
    modifie=$(code_modifie_le)
    if [ -n "$demarre" ] && [ -n "$modifie" ] && [ "$demarre" -lt "$modifie" ]; then
      echo "  déjà lancé (PID $pid), réutilisé"
      echo "  ⚠ il a démarré AVANT la dernière modification du code serveur."
      echo "    Vos changements ne sont pas pris en compte : Ctrl+C dans son"
      echo "    terminal, puis relancez cette commande."
    else
      echo "  déjà lancé (PID $pid) et à jour, réutilisé"
    fi
  else
    echo "  ÉCHEC : le port $PORT_SERVEUR est occupé mais rien n'y répond." >&2
    echo "  Un autre programme l'utilise, ou le serveur est bloqué." >&2
    nettoyer 1
  fi
else
  node scripts/negotiate-server.js &
  enfants+=($!)
  if attendre "$PORT_SERVEUR" "${enfants[0]}"; then
    echo "  démarré"
  else
    echo "  ÉCHEC : voir l'erreur ci-dessus (OPENROUTER_API_KEY manquante dans .env ?)" >&2
    nettoyer 1
  fi
fi

cat <<URLS

  Tout est prêt.

  Copilote de négociation   http://127.0.0.1:$PORT_SERVEUR
  Dashboard des annonces    http://127.0.0.1:$PORT_SERVEUR/dashboard

  Journaux de l'extension   tail -f logs/extension.log

URLS

if [ ${#enfants[@]} -eq 0 ]; then
  echo "  (rien à surveiller : tout tournait déjà)"
  exit 0
fi

echo "  Ctrl+C pour arrêter le serveur (la base reste lancée : supabase stop)."
wait
