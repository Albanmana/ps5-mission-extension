# Référence technique

Pour la personne qui maintient le projet. L'installation et l'usage sont dans le
[README](../README.md).
Pour adapter l'outil à un autre achat, voir [personnaliser.md](personnaliser.md).

## Architecture

| Élément | Rôle |
| --- | --- |
| `extension/` | Extension Chrome (Manifest V3), sans étape de build ni clé. |
| `extension/sw/` | Service worker : recherche, contact, conversations, autopilotes, appels au serveur (`api.js`). |
| `extension/content/` | Scripts injectés dans les pages leboncoin. |
| `extension/panel/` | Panneau latéral (HTML, CSS et modules ES, sans étape de build ni ressource réseau). |
| `extension/lib/settings.js` | Source unique des réglages et de leur normalisation, aussi importée par le serveur. |
| `scripts/negotiate-server.js` | Serveur HTTP sur `127.0.0.1:8835` (port fixe, aussi inscrit dans l'extension). |
| `scripts/classify.js` | Classification IA, utilisée par le serveur et en ligne de commande. |
| `scripts/lib/` | Accès à la base et règles métier. |
| `dashboard.html`, `negociation.html` | Pages servies par le serveur. |
| `supabase/` | Configuration et migrations de la base locale. |

La seule dépendance npm est `pg`. Le serveur parle directement à PostgreSQL.

## Commandes

| Commande | Effet |
| --- | --- |
| `npm run setup` | Prérequis, `npm ci`, `.env`, base, migrations. `-- --check` : prérequis seuls. |
| `npm run dev` | Base, migrations en attente, serveur. |
| `npm run serve` (ou `npm run negotiate`) | Serveur seul. Il refuse de démarrer sans clé OpenRouter ou si la base n'est pas à jour. |
| `npm run classify -- …` | Voir « Classification en ligne de commande ». |
| `npm test` | Tests automatisés (Chrome et services externes simulés). |
| `scripts/export-handoff.sh <dossier>` | Copie à remettre. Voir plus bas. |

Certains tests PostgreSQL sont ignorés par défaut. Ils s'activent avec
`PS5_TEST_LOCAL_DB=1 npm test` et se connectent à la base sur le port 54322. Ils
utilisent une table temporaire ou une transaction annulée ; lancez-les de
préférence sur une base sans données réelles.

Les tests ne prouvent pas que les sélecteurs correspondent au site leboncoin
actuel : après un changement du site, refaire un essai en simulation.

## Configuration

Variables lues par le code (`.env.example` en est la liste de référence) :
`OPENROUTER_API_KEY`, `EXTENSION_ORIGIN`, `RESEND_API_KEY`,
`RESEND_FROM_EMAIL`, `HANDOFF_EMAIL`, `SUPABASE_DB_URL`. Le lecteur
(`scripts/lib/env.js`) ne remplace pas une variable déjà non vide dans
l'environnement et ne gère pas les commentaires en fin de ligne.

Réglages utilisateur (`chrome.storage.local`, clé `ps5_settings`) : `dryRun`,
`ownerName`, `handoffEmail`, `goodPrice`, `maxPrice` (entiers de 100 à 2000,
`goodPrice <= maxPrice`), `replyScope` (`contacted` ou `all`). Toute valeur
douteuse retombe sur le défaut. L'extension les joint aux requêtes de
classification, de négociation et de reprise.

## Routes du serveur

Le serveur refuse tout en-tête `Host` autre que `127.0.0.1:8835` ou
`localhost:8835`. Les `POST` exigent une origine acceptée (absente, serveur
lui-même ou `EXTENSION_ORIGIN`) et `Content-Type: application/json`. Corps
limité à 64 Kio.

| Route | Accès | Rôle |
| --- | --- | --- |
| `GET /`, `GET /negociation.html` | local | Page « copilote » de négociation. |
| `GET /dashboard`, `GET /dashboard.html` | local | Tableau de bord. |
| `GET /api/dashboard/annonces` | même origine | Liste des annonces. |
| `POST /api/dashboard/disqualification` | même origine | `{ id, disqualifiee }`, décision manuelle conservée. |
| `GET`, `POST /api/health` | origine acceptée | `{ ok: true }`. |
| `POST /api/log` | origine acceptée | Écrit dans `logs/extension.log` (JSON Lines). |
| `POST /api/annonces/upsert` | origine acceptée | Enregistre une annonce. |
| `POST /api/annonces/classify` | origine acceptée | `{ url_annonce, force, settings }`. |
| `GET /api/annonces/shortlist?limite=&prix_max=` | origine acceptée | Vendeurs à contacter. |
| `POST /api/annonces/contactee` | origine acceptée | Marque une annonce contactée. |
| `POST /api/annonces/contact-erreur` | origine acceptée | Erreur de contact. |
| `POST /api/annonces/contact-reserver`, `contact-finaliser`, `contact-liberer` | extension | Réservation anti-doublon par jeton. |
| `POST /api/annonces/reservations` | extension | Réservations de plus de 10 minutes. |
| `POST /api/annonces/reservation-resoudre` | extension | `{ url_annonce, resultat: "envoye" \| "non_envoye" }`. |
| `POST /api/annonces/introuvable` | extension | Annonce supprimée. |
| `GET`, `POST /api/conversations` | extension | Conversations suivies. |
| `POST /api/conversations/negotiate` | extension | `{ snapshot, fingerprint, settings }`. |
| `POST /api/conversations/sent`, `handled`, `error` | extension | Suivi d'un tour. |
| `POST /api/handoff` | origine acceptée | `{ conversation_id, message_vendeur, handoff, settings }`. |
| `POST /api/negotiate` | origine acceptée | Brouillon pour la page « copilote ». |

Réponses notables :

- `negotiate` hors périmètre : `{ ignored: true, reason: "hors_perimetre" }`,
  sans stockage ni appel au modèle. Sans `settings` valides : portée
  `contacted` et prix par défaut.
- En simulation, `negotiate` enregistre la conversation mais ne réserve pas le
  tour et répond avec `dryRun: true`.
- `handoff` : `{ notified: true, email_id }`, ou
  `{ notified: false, reason: "email_non_configure" }` ; 502 si l'envoi échoue
  (réessayable). Depuis l'origine extension, le destinataire est uniquement
  `settings.handoffEmail` (vide : aucun e-mail). Pour les autres origines
  acceptées (page « copilote »), c'est `HANDOFF_EMAIL` ; l'adresse reçue dans
  `settings` est ignorée.

## Règles métier

### Classification

Modèles (constantes dans le code) : `google/gemini-3.1-flash-lite` pour la
vision, `typesafe/jev-1.13` (API `/api/alpha/decisions` d'OpenRouter, en version
alpha) pour les décisions, `openai/gpt-6-luna` pour la négociation.

Des filtres sans IA écartent d'abord les annonces d'achat (« recherche »), les
demandes de paiement hors plateforme et certains défauts. Viennent ensuite la
question « est-ce une console ? » (texte, puis vision si le résultat est
incertain) et la présence du lecteur de disque (sans lecteur : disqualifiée).
Le prix est comparé en code : `<= goodPrice` donne `saint_graal`,
`<= maxPrice` donne `interessant`, sinon `a_verifier`. Zéro manette détectée
plafonne à `a_verifier`. La sortie brute est gardée dans `analyse_ia`. Une
décision manuelle n'est jamais réanalysée.

Le contact automatique ne vise que `saint_graal` et `interessant`.

### Négociation

Plafond normal `goodPrice`, ouverture `goodPrice - 10`. L'offre finale à
`maxPrice` exige une offre précédente au moins égale à `goodPrice` et un vendeur
qui demande entre `maxPrice + 10` et `maxPrice + 50`. Le serveur rejette un
brouillon contenant un montant au-dessus du plafond. Points d'arrêt : réponse sur
l'envoi avec paiement leboncoin, défaut majeur, et `question_importante`, affiché
« Réponse à rédiger vous-même » (question du vendeur, demande de paiement hors
leboncoin ou message à risque).

`validateDraftPricePolicy` contrôle les prix, pas la formulation. Un brouillon
dépassant le plafond, s'écartant de la cible requise, offrant plus que le plus bas
montant cité par le vendeur ou acceptant sans montant un prix au-dessus du plafond
est régénéré une fois. Les autres refus (offre au-dessus du plafond, offre absente
du message, lieu proposé) et un second refus font échouer le tour : le serveur le
marque `generation_echec` et répond 502, et l'extension compte l'échec du fil
(carte « Réponse automatique impossible : répondez vous-même » sur l'Accueil et
notification au troisième).

`scripts/lib/seller-risk.js` filtre les messages vendeur restés sans réponse. Le
modèle reste appelé pour qualifier un point d'arrêt, mais si le filtre se
déclenche, aucun brouillon n'est envoyé.

### Simulation

Désactivée par défaut : l'envoi est réel quand aucun réglage n'est enregistré ou
avec `dryRun: false` (`extension/lib/settings.js`). Un `dryRun` enregistré non
booléen ou des réglages qui ne sont pas un objet valent simulation, et un
stockage illisible n'autorise aucun clic. Côté serveur, des `settings` absents ou
non objets valent envoi réel (le tour est réservé).

En simulation, le texte est tapé, sans clic sur Envoyer ; rien n'est enregistré
comme envoyé ou contacté et la réservation de contact est libérée. Aucun e-mail
de reprise ne part depuis l'extension. La page « copilote » n'utilise pas ce réglage.

### Activation et rythme

Autopilotes, contact automatique et réanalyse forcée sont désactivés par défaut.
Un état d'autopilote enregistré sans `activationVersion: 2` est considéré comme
désactivé.

Pendant une recherche, les requêtes leboncoin passent par une file sérielle : 3 à
6 s avant les pages suivantes, 10 à 20 s avant chaque fiche. Le serveur local est
appelé avec une concurrence limitée. Les options par défaut sont dans
`extension/sw/search-autopilot-state.js`.

### Conversations

Chaque passage traite au plus une conversation : la première non lue, sinon la
première dont l'aperçu a changé (`extension/content/messages-list.js`, lignes
affichées seulement). Seuls les liens `/messages/id/<identifiant hexadécimal>`
comptent : les lignes promotionnelles (`/messages/id/santa`) sont ignorées, et
une liste sans aucune conversation reconnue mais avec d'autres liens lève une
erreur (format d'URL changé). À chaque activation, le premier passage enregistre les
aperçus existants (`baselinePending`) : les conversations lues sont considérées
comme vues. « Vérifier maintenant » enchaîne les passages (50 au maximum, une
fois chaque conversation) et s'arrête sur tout résultat absent de
`CONTINUE_BATCH` (`extension/sw/conversation-poller.js`), dont `dry_run`.

Reprise après interruption : l'aperçu réel n'est enregistré qu'à la conclusion
du tour. `envoiTente` est persisté juste avant l'appel au script d'envoi, et seul
un résultat `clique: false` ou `dryRun: true` l'efface ; sinon le tour est
consommé, signalé `envoi_incertain` et affiché. Interrompu plus tôt, le tour
n'est pas consommé : sa libération (`generation_echec`) attend dans `aSignaler`
et passe avant toute nouvelle négociation de ce fil. Le serveur refuse cette
libération sur un tour conclu ou incertain. Les codes `modele_indisponible` et
`base_indisponible` ne comptent pas contre la conversation.

Recherche : une pause demandée par l'utilisateur (`pauseUtilisateur`) suspend
l'autopilote de recherche jusqu'à Reprendre ou Stop.

### Contact et anti-doublon

Le message automatique est `MESSAGE_CONTACT_PAR_DEFAUT`
(`extension/lib/templates.js`). L'écran Premier message propose des modèles modifiables
(clé `templates_contact` de `chrome.storage.local`, variables `{{vendeur}}`,
`{{titre}}`, `{{prix}}`, `{{ville}}`). Un contact n'est confirmé qu'après la
redirection `/reply/success/conversations?adId=<id>`. Un clic sans confirmation
est marqué `envoi_incertain`, sans nouvel essai automatique. Le vendeur n'étant
identifié que par son nom, deux homonymes peuvent être regroupés.

`contacte_le` est recopié sur les annonces d'un même vendeur ;
`contact_direct_le` ne concerne que l'annonce réellement contactée et borne la
portée des réponses automatiques.

### Panneau latéral

`panel/app.js` assemble les modules : `coquille.js` (en-tête, alertes,
navigation Accueil / Annonces / Réglages et sous-écrans), `vue-accueil.js`,
`vue-recherche.js` (propriétaire unique des options de recherche ; tout reste
verrouillé tant que les options enregistrées ne sont pas relues) et
`vue-run.js`, `vue-annonces.js`, `vue-contact.js` et `contact-memoire.js`
(anti double envoi), `vue-conversations.js` et `vue-reprises.js`,
`vue-reservations.js`, `vue-envois.js`, `vue-reglages.js`, `dom.js`. Les
données externes ne passent que par `textContent`.

L'interrupteur **Envoyer le premier message** est enregistré par
`recherche-auto-configurer`, autopilote actif ou non, à partir des dernières
options confirmées : un critère invalide en cours de saisie n'empêche pas de le
couper. Il n'agit pas sur un run déjà lancé à la main.

Journal des envois (`sw/sent-log.js`, clé `ps5_messages_envoyes`, 50 entrées au
plus) : `{ kind: 'premier_contact' | 'reponse', simulated, vendeur, debut
(80 caractères), tronque, url (sans paramètres), date }`. Il est alimenté après la
confirmation leboncoin d'un contact, après une bulle sortante confirmée d'une
réponse, ou après la saisie en mode test (`simulated: true`). Un envoi incertain
n'y entre pas. L'écriture n'est jamais attendue et ses erreurs sont avalées ;
aucune décision d'envoi ne le lit. Messages : `envois-liste` (réponse
`{ ok, envois }`), diffusion `envois-maj`, et champ facultatif `vendeur` sur
`contact-envoyer`.

## Base de données

Le schéma est défini par `supabase/migrations/` : tables `annonces`
(dédoublonnage par `url_annonce`) et `conversations` (historique en JSONB). Pour
une évolution, ajoutez une migration ; ne modifiez pas une migration déjà
appliquée. Application sans perte : `supabase migration up --local`. Jamais de
`supabase db reset` sur des données réelles.

Console SQL (psql du conteneur) :

```bash
docker exec -it supabase_db_ps5-mission psql -U postgres -d postgres
```

Le mot de passe local est celui par défaut de Supabase ; `anon` et
`authenticated` n'ont aucun droit sur les deux tables.

### Services et exposition

`supabase/config.toml` ne laisse active que la base (port 54322) : API, Studio,
Auth, Storage, Realtime, e-mails de test, Edge Runtime et Analytics sont
désactivés. Un changement demande `supabase stop` puis un redémarrage.

La CLI n'a pas d'option dans `config.toml` pour choisir l'adresse d'écoute.
`scripts/supabase-local.sh` crée donc le réseau Docker `ps5-mission-local` avec
`com.docker.network.bridge.host_binding_ipv4=127.0.0.1`, lance
`supabase start --network-id ps5-mission-local`, puis avertit si `lsof` montre
une écoute sur toutes les interfaces. L'effet réel dépend de la version de
Docker Desktop : vérifiez avec
`lsof -nP -iTCP:54322 -sTCP:LISTEN`. Un `supabase start` lancé à la main
n'applique pas cette restriction.

## Classification en ligne de commande

Ces commandes utilisent les prix par défaut (350 / 370), pas ceux de l'onglet
Réglages, et sont facturées par OpenRouter.

```bash
npm run classify -- --pending --limit=5   # annonces en base restées sans analyse
npm run classify -- --enrichir --limit=10 # récupère les fiches sans description
npm run classify -- annonces.json         # fichier JSON : url_annonce et titre au minimum
```

Avec un fichier, `--force` réanalyse et `--limit=N` limite le nombre.

**`--enrichir` interroge leboncoin avec `curl`, hors de votre navigateur et sans
session.** Le risque de blocage de votre adresse est réel. Ne le lancez pas
pendant une recherche de l'extension et ne raccourcissez pas ses délais.

`node scripts/import-conversations.js <fichier>` importe des conversations
depuis un tableau JSON (exemple fictif dans
`scripts/data/conversations-exemple.json`) et écrit dans la base.

## Remettre le projet à quelqu'un

```bash
scripts/export-handoff.sh ../ps5-mission-copie
```

Le script exporte uniquement les fichiers suivis du commit `HEAD`, sans
historique. La destination doit être absente ou vide, et hors du dépôt. Il
n'écrit rien si l'export contient un `.env` (hors `.env.example`), un journal, un
lien symbolique ou une chaîne interdite, y compris dans un nom de fichier.

La liste des chaînes interdites est obligatoire : fichier `.handoff-forbidden`
à la racine (ignoré par git), ou chemin donné par `HANDOFF_FORBIDDEN_FILE`. Une
chaîne par ligne : nom, adresses e-mail, chemin du dossier personnel, téléphone,
identifiants. La recherche est littérale et ignore la casse ; elle ne voit pas
le contenu compressé (images, archives).

Le script ne crée aucun dépôt et ne pousse rien. Avant le premier commit du
nouveau dépôt, vérifiez l'identité git utilisée.
