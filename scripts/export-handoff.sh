#!/usr/bin/env bash
# Prépare la copie à remettre pour un NOUVEAU dépôt :
#   scripts/export-handoff.sh <dossier-destination>
#
# Contient uniquement les fichiers suivis par git dans HEAD, sans historique.
# Refuse d'écrire quoi que ce soit si l'export contient un .env, un journal ou
# une chaîne interdite. Ne crée aucun dépôt distant et ne pousse rien.
#
# Chaînes interdites : une par ligne (recherche littérale, sans casse ; lignes
# vides et « # » ignorées) dans .handoff-forbidden, fichier NON suivi par git.
# Autre emplacement : variable HANDOFF_FORBIDDEN_FILE.

set -euo pipefail
export LC_ALL=en_US.UTF-8

echec() { echo "ÉCHEC : $1" >&2; exit 1; }

[ $# -eq 1 ] && [ -n "$1" ] || echec "usage : scripts/export-handoff.sh <dossier-destination>"
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
destination=$1
case "$destination" in /*) ;; *) destination="$PWD/$destination" ;; esac

if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -d "$destination" ] || echec "la destination existe et n'est pas un dossier."
  contenu=$(ls -A "$destination") || echec "destination illisible."
  [ -z "$contenu" ] || echec "la destination n'est pas vide."
  reelle=$(cd "$destination" && pwd -P)
else
  parent=$(dirname "$destination")
  [ -d "$parent" ] || echec "le dossier parent de la destination n'existe pas."
  reelle="$(cd "$parent" && pwd -P)/$(basename "$destination")"
fi
case "$reelle/" in "$RACINE"/*) echec "la destination doit être hors du dépôt." ;; esac

liste="${HANDOFF_FORBIDDEN_FILE:-$RACINE/.handoff-forbidden}"
[ -f "$liste" ] || echec "liste des chaînes interdites introuvable : $liste
  Créez-la (nom, adresses e-mail, chemin du dossier personnel, téléphone...)."
liste_reelle="$(cd "$(dirname "$liste")" && pwd -P)/$(basename "$liste")"
case "$liste_reelle" in
  "$RACINE"/*)
    if git -C "$RACINE" ls-files --error-unmatch -- "$liste_reelle" >/dev/null 2>&1; then
      echec "la liste des chaînes interdites ne doit pas être suivie par git."
    fi ;;
esac

travail=$(mktemp -d)
trap 'rm -rf "$travail"' EXIT
mkdir "$travail/export"

# Une ligne vide correspondrait à tout : elle est retirée, avec les retours
# chariot et les espaces de fin.
sed -e $'s/\r$//' -e 's/[[:space:]]*$//' "$liste" | grep -v -e '^#' -e '^$' > "$travail/motifs" || true
[ -s "$travail/motifs" ] || echec "la liste des chaînes interdites est vide."

git -C "$RACINE" archive --format=tar HEAD | tar -x -C "$travail/export" \
  || echec "git archive a échoué."

cd "$travail/export"
find . -mindepth 1 | sed 's|^\./||' > "$travail/chemins"
problemes=0

interdits=$(find . \( \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' \) -o -name '*.log' -o -name 'logs')
if [ -n "$interdits" ]; then
  echo "Fichiers à ne jamais livrer (.env, journaux) :" >&2
  echo "$interdits" >&2
  problemes=1
fi

liens=$(find . -type l)
if [ -n "$liens" ]; then
  echo "Liens symboliques interdits (leur cible n'est pas contrôlable) :" >&2
  echo "$liens" >&2
  problemes=1
fi

# grep : 0 = trouvé, 1 = absent, autre = contrôle impossible (donc refus).
# Seuls les noms de fichiers sont affichés, jamais les lignes.
code=0
trouves=$(grep -r -a -i -l -F -f "$travail/motifs" .) || code=$?
[ "$code" -le 1 ] || echec "recherche des chaînes interdites impossible."
if [ -n "$trouves" ]; then
  echo "Fichiers contenant une chaîne interdite :" >&2
  echo "$trouves" >&2
  problemes=1
fi
code=0
grep -q -i -F -f "$travail/motifs" "$travail/chemins" || code=$?
[ "$code" -le 1 ] || echec "contrôle des noms de fichiers impossible."
if [ "$code" -eq 0 ]; then
  echo "Un nom de fichier contient une chaîne interdite." >&2
  problemes=1
fi

[ "$problemes" -eq 0 ] || echec "export annulé, la destination n'a pas été modifiée."

nombre=$(find . -type f | wc -l | tr -d ' ')
mkdir -p "$destination"
cp -Rp . "$destination/"

if [ -n "$(git -C "$RACINE" status --porcelain --untracked-files=no)" ]; then
  echo "ATTENTION : des modifications non validées (commit) ne sont PAS dans l'export." >&2
fi
cat <<FIN
Export prêt : $destination
  $nombre fichiers du commit $(git -C "$RACINE" rev-parse --short HEAD), sans historique.
  Rien n'a été poussé et aucun dépôt n'a été créé.
  Avant le premier commit du nouveau dépôt, vérifiez user.name et user.email :
  votre identité git actuelle y serait enregistrée.
FIN
