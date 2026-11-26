#!/usr/bin/env bash
# Installation et mise à jour : npm run setup
#   --check  vérifie seulement les prérequis, sans rien modifier.
#
# Relançable sans risque : .env n'est jamais écrasé et la base n'est jamais
# remise à zéro.

set -uo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RACINE" || exit 1
source "$RACINE/scripts/supabase-local.sh"

NODE_MIN=22
SUPABASE_TESTEE=2.109.1
# Remplaçable pour les tests ou une installation ailleurs.
CHROME="${PS5_CHROME_APP:-/Applications/Google Chrome.app}"

CONTROLE_SEUL=0
case "${1:-}" in
  '') ;;
  --check) CONTROLE_SEUL=1 ;;
  *) echo "Option inconnue : $1 (seule option : --check)" >&2; exit 1 ;;
esac

erreurs=0
manque() { echo "  ÉCHEC : $1" >&2; echo "          $2" >&2; erreurs=$((erreurs + 1)); }
present() { command -v "$1" >/dev/null 2>&1; }

echo "▸ Vérification des prérequis"

if [ "$(uname -s)" != "Darwin" ]; then
  manque "ce projet n'est prévu que pour macOS." "Utilisez un Mac."
fi

if ! present node; then
  manque "Node.js introuvable." "Installez Node.js $NODE_MIN ou plus récent : https://nodejs.org"
else
  version=$(node --version 2>/dev/null)
  majeure=${version#v}
  majeure=${majeure%%.*}
  case "$majeure" in
    ''|*[!0-9]*) manque "version de Node.js illisible." "Vérifiez « node --version »." ;;
    *) if [ "$majeure" -lt "$NODE_MIN" ]; then
         manque "Node.js $version est trop ancien." "Il faut la version $NODE_MIN ou plus récente : https://nodejs.org"
       fi ;;
  esac
fi

present npm || manque "npm introuvable." "npm est fourni avec Node.js : réinstallez Node.js."
present curl || manque "curl introuvable." "curl est fourni avec macOS : vérifiez votre PATH."
present lsof || manque "lsof introuvable." "lsof est fourni avec macOS : ajoutez /usr/sbin à votre PATH."

if ! present docker; then
  manque "Docker introuvable." "Installez Docker Desktop : https://www.docker.com/products/docker-desktop/"
elif ! docker info >/dev/null 2>&1; then
  manque "Docker Desktop n'est pas démarré." "Ouvrez l'application Docker, attendez qu'elle soit prête, puis relancez."
fi

if ! present supabase; then
  manque "Supabase CLI introuvable." "Installez-le : brew install supabase/tap/supabase"
else
  echo "  Supabase CLI : $(supabase --version 2>/dev/null | head -1) (testé avec $SUPABASE_TESTEE)"
fi

if [ ! -d "$CHROME" ]; then
  echo "  ATTENTION : Google Chrome introuvable dans /Applications. L'extension en a besoin." >&2
fi

if [ "$erreurs" -gt 0 ]; then
  echo "" >&2
  echo "$erreurs prérequis manquant(s). Rien n'a été modifié." >&2
  exit 1
fi
echo "  prérequis OK"

if [ "$CONTROLE_SEUL" -eq 1 ]; then
  echo "Mode --check : rien n'a été modifié."
  exit 0
fi

echo "▸ Installation des dépendances"
if ! npm ci; then
  echo "ÉCHEC : installation des dépendances (npm ci). Vérifiez votre connexion." >&2
  exit 1
fi

echo "▸ Fichier de configuration .env"
if [ -e .env ]; then
  echo "  .env existe déjà : conservé tel quel"
else
  # umask : le fichier ne doit jamais être lisible par d'autres comptes.
  if ! (umask 077 && cp .env.example .env); then
    echo "ÉCHEC : impossible de créer .env à partir de .env.example." >&2
    exit 1
  fi
  chmod 600 .env
  echo "  .env créé à partir de .env.example"
fi

echo "▸ Base de données locale (plusieurs minutes la première fois)"
demarrer_base || exit 1

echo "▸ Migrations"
appliquer_migrations || exit 1

cat <<'FIN'

Installation terminée. Étapes suivantes :

  1. Ouvrez .env (« open -e .env ») et renseignez OPENROUTER_API_KEY.
  2. Dans Chrome, ouvrez chrome://extensions, activez le mode développeur,
     « Charger l'extension non empaquetée » et choisissez le dossier extension/.
  3. Copiez l'ID affiché et mettez dans .env :
     EXTENSION_ORIGIN=chrome-extension://VOTRE_ID_EXTENSION
  4. Lancez : npm run dev
  5. Suivez « Premier essai en simulation » dans le README.

FIN
