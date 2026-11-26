# PS5 mission

Un outil pour **acheter** une PS5 d'occasion sur leboncoin. Il comprend une
extension Chrome (panneau latéral), un serveur local et une base de données sur
votre Mac. Il peut :

- parcourir des recherches leboncoin et classer les annonces avec une IA
  (`saint_graal`, `interessant`, `a_verifier`, `disqualifiee`) ;
- envoyer un premier message aux vendeurs ;
- répondre aux vendeurs en négociant dans vos limites de prix ;
- vous rendre la main quand une décision humaine est nécessaire.

La référence technique est dans [docs/technique.md](docs/technique.md).
Pour acheter autre chose qu'une PS5 : [docs/personnaliser.md](docs/personnaliser.md).

## À lire avant de commencer

- **Automatiser leboncoin peut enfreindre ses conditions d'utilisation.** Votre
  compte peut être restreint, suspendu ou fermé. leboncoin a aussi une
  protection anti-robot qui peut bloquer l'accès (« Accès temporairement
  restreint »). Le rythme lent de l'outil réduit ce risque sans le supprimer.
  Vous utilisez l'outil sous votre responsabilité.
- **Les messages partent de votre compte leboncoin**, en votre nom. Une IA les
  rédige : elle peut se tromper. Surveillez les conversations.
- **L'envoi réel est le réglage par défaut** : après l'installation, le mode
  simulation est désactivé, et un envoi que vous lancez part vraiment. Les
  autopilotes, le contact automatique et la réanalyse forcée restent désactivés
  par défaut. Pour essayer sans rien envoyer, activez d'abord le **Mode test**
  (onglet **Réglages**) : les messages sont alors tapés dans la page mais jamais
  envoyés.
- Même en simulation, les annonces et les conversations traitées sont
  enregistrées sur votre Mac et envoyées à OpenRouter, ce qui est **facturé**.

## Prérequis

| Élément | Version |
| --- | --- |
| macOS | |
| [Node.js](https://nodejs.org) (avec npm) | 22 ou plus récent |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | version récente, démarré |
| [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) | 2.109.0 ou plus récente (`brew install supabase/tap/supabase`) ; une version plus ancienne présente ailleurs est ignorée |
| [Google Chrome](https://www.google.com/chrome/) | version récente, avec le panneau latéral |
| Compte leboncoin | le vôtre |
| Clé [OpenRouter](https://openrouter.ai) | avec du crédit |
| Clé [Resend](https://resend.com) | facultative, pour recevoir les reprises par e-mail |

La commande `brew` suppose que [Homebrew](https://brew.sh) est installé. Python
n'est pas nécessaire.

## Installation

Placez le dossier du projet à son emplacement **définitif** : le déplacer plus
tard peut changer l'identifiant de l'extension. Puis, dans le Terminal, depuis
ce dossier :

```bash
npm run setup
```

La commande vérifie les prérequis, installe les dépendances, crée `.env` (sans
jamais écraser un fichier existant), démarre la base locale et applique les
migrations. Le premier lancement télécharge des images Docker et prend quelques
minutes. Pour vérifier seulement les prérequis, sans rien modifier :

```bash
npm run setup -- --check
```

Ouvrez ensuite le fichier de configuration :

```bash
open -e .env
```

Renseignez `OPENROUTER_API_KEY`. Une ligne par variable, sous la forme
`NOM=valeur`, sans commentaire en fin de ligne.

| Variable | Rôle |
| --- | --- |
| `OPENROUTER_API_KEY` | Obligatoire. Sans elle, le serveur ne démarre pas. |
| `EXTENSION_ORIGIN` | Obligatoire pour l'extension (voir ci-dessous). |
| `RESEND_API_KEY` | Facultatif. Active les e-mails de reprise. |
| `RESEND_FROM_EMAIL` | Facultatif. Vide : `PS5 Mission <onboarding@resend.dev>`. |
| `HANDOFF_EMAIL` | Facultatif. Destinataire des reprises de la page « copilote » uniquement. L'extension ne l'utilise pas. |
| `SUPABASE_DB_URL` | Facultatif. Laissez vide pour la base locale. |

Avec l'expéditeur `onboarding@resend.dev`, Resend limite en principe les envois
à l'adresse de votre propre compte Resend ; pour une autre adresse, vérifiez un
domaine chez Resend.

## Charger l'extension

1. Dans Chrome, ouvrez `chrome://extensions`.
2. Activez le **mode développeur**.
3. Cliquez sur **Charger l'extension non empaquetée** et choisissez le dossier
   `extension/` du projet.
4. Copiez l'**ID** affiché sur la carte « PS5 mission ».
5. Dans `.env`, ajoutez-le ainsi :

   ```dotenv
   EXTENSION_ORIGIN=chrome-extension://VOTRE_ID_EXTENSION
   ```

6. Démarrez l'outil (ou redémarrez-le s'il tournait déjà) :

   ```bash
   npm run dev
   ```

7. Cliquez sur l'icône **PS5 mission** pour ouvrir le panneau latéral. Si
   l'encadré **Serveur local injoignable** apparaît, le serveur n'est pas
   joignable ; sinon, l'onglet **Réglages** affiche en bas **Serveur local
   connecté.**

Connectez-vous à leboncoin dans le même profil Chrome.

## Le panneau latéral

Trois onglets en bas du panneau :

- **Accueil** (avec le nombre de décisions en attente) : l'état du pilote et
  trois interrupteurs, **Chercher des annonces** (recherche automatique),
  **Envoyer le premier message** (contact automatique) et **Répondre aux
  vendeurs** (autopilote des conversations) ; les derniers messages envoyés ;
  puis seulement ce qui demande votre décision. En bas : **Toutes les
  conversations** (suivies, ignorées, fonctionnement) et **Vérifier
  maintenant**.
- **Annonces** : le suivi de la recherche (**Pause** / **Reprendre**, **Stop**,
  **Détails**) ou le bouton **Lancer une recherche** ; les filtres **À
  contacter** (shortlist du serveur, une annonce par vendeur connu), **À
  vérifier** et **Toutes** (résultats de la dernière recherche) ; **Contacter
  une autre annonce**. L'icône de réglage à droite des filtres ouvre **Ma
  recherche** : les URL, les limites et la réanalyse. Toucher une annonce ouvre
  **Premier message**.
- **Réglages**.

**Derniers messages envoyés** reprend les premiers contacts et les réponses
dont l'envoi a été confirmé. Les messages seulement tapés en mode test y sont
signalés comme essais. Un envoi non confirmé n'y figure jamais : il est à
vérifier à la main. La liste ne commence qu'avec la version qui l'ajoute.

## Onglet Réglages

| Réglage | Par défaut | Effet |
| --- | --- | --- |
| **Mode test** (simulation) | désactivé | Désactivé : les messages partent réellement. Activé : ils sont tapés mais jamais envoyés, et aucun e-mail de reprise ne part depuis l'extension. |
| **Avancé : qui reçoit des réponses** | Seulement les annonces contactées par l'outil | L'autre choix, **Toutes les conversations**, fait répondre le robot en tant qu'acheteur de PS5 à toutes les conversations de votre compte, y compris celles sans rapport. |
| **Votre nom** | vide | Utilisé dans les notes de négociation et les e-mails. |
| **E-mail de reprise (facultatif)** | vide | Destinataire des reprises de l'extension. Demande `RESEND_API_KEY` dans `.env`. S'il est vide, aucun e-mail n'est envoyé. |
| **Bon prix (€)** | 350 | Jusqu'à ce prix : `saint_graal`. Plafond normal de négociation ; la première offre est 10 € en dessous. |
| **Prix maximum (€)** | 370 | Jusqu'à ce prix : `interessant`. Proposé seulement en dernière offre, après une offre au bon prix, si le vendeur demande 10 à 50 € de plus que ce maximum. |

Le mode et la portée des réponses s'appliquent immédiatement (avec une
confirmation pour les choix risqués, dont le passage en envoi réel). Un mode déjà
enregistré est conservé après une mise à jour. Si les réglages sont illisibles ou
le mode enregistré est invalide, rien n'est envoyé. Les autres champs
s'appliquent avec **Enregistrer**, un bouton qui apparaît dès qu'un champ est
modifié. En mode test, le badge **Mode test : rien ne part** reste en haut du
panneau ; en envoi réel il n'y a pas de badge, et l'Accueil annonce **En
marche, les messages partent** quand un envoi automatique est possible. Des
réglages illisibles affichent un avertissement **Mode inconnu**.

## Premier essai en simulation

Avant tout, dans **Réglages**, activez **Mode test** (il est désactivé après
l'installation), puis vérifiez que le badge **Mode test : rien ne part** est
affiché en haut du panneau.

1. Dans **Réglages**, renseignez vos prix et votre nom (**Nom et e-mail
   d'alerte**), puis **Enregistrer**.
2. Dans **Annonces**, ouvrez **Ma recherche** (icône à droite des filtres),
   **Réglages avancés** : mettez **Pages max** à 1, **Résultats max** à 5 et
   **Fiches max** à 5. Gardez l'URL proposée ou collez la vôtre (ou **Ajouter
   la page ouverte**), revenez, puis **Lancer une recherche**.
3. Observez l'avancement et ses **Détails**. Le détail des annonces est visible
   sur <http://127.0.0.1:8835/dashboard>.
4. Pour essayer le contact, activez **Envoyer le premier message** sur
   l'Accueil avant de lancer la recherche (un seul essai par recherche en mode
   test), ou ouvrez une annonce dans **Annonces** et cliquez sur **Essayer sans
   envoyer**. Le message est saisi dans un onglet laissé ouvert. Il n'est ni
   envoyé ni enregistré comme contact. Une annonce déjà analysée peut
   nécessiter **Réanalyser les annonces déjà en base** pour un nouvel essai
   pendant une recherche.
5. Pour les conversations, ouvrez un onglet
   `https://www.leboncoin.fr/messages`, puis sur l'**Accueil** activez
   **Répondre aux vendeurs** et cliquez sur **Vérifier maintenant**. En
   simulation, une réponse est tapée mais pas envoyée. Les conversations déjà
   lues au moment de l'activation sont laissées telles quelles : sans message
   non lu, rien n'est traité. Avec la portée par défaut, les annonces que
   l'outil n'a jamais réellement contactées sont aussi ignorées (« hors
   périmètre ») : il est donc normal de n'obtenir aucune réponse avant votre
   premier contact réel.
6. Désactivez **Répondre aux vendeurs** à la fin.

**N'appuyez pas sur Envoyer (ni sur Entrée) dans un onglet de simulation** : le
message partirait réellement, sans être suivi par l'outil. Effacez le texte ou
fermez l'onglet.

La page « copilote » (<http://127.0.0.1:8835>) ne dépend **pas** du mode
simulation de l'extension : elle n'envoie rien sur leboncoin, mais appelle
OpenRouter (avec les prix par défaut, 350 et 370 €, sans votre nom) et, sur un
point d'arrêt, envoie un e-mail à `HANDOFF_EMAIL` si cette variable et Resend
sont configurés.

## Passer en envoi réel

1. Relisez les messages et les classements obtenus en simulation.
2. Vérifiez le **Bon prix** et le **Prix maximum**.
3. Laissez la portée sur **Seulement les annonces contactées par l'outil**.
4. Fermez les onglets restés de la simulation.
5. Dans **Réglages**, désactivez **Mode test**, puis **Activer**. Le badge
   disparaît.
6. Commencez par **un seul** envoi manuel (**Annonces**, une annonce,
   **Envoyer le message**) et vérifiez-le dans votre messagerie leboncoin.
7. N'activez les automatismes qu'ensuite, un par un.

Pour tout arrêter : remettez **Mode test**, désactivez les trois
interrupteurs de l'**Accueil**, puis **Stop** dans **Annonces** (désactiver
**Envoyer le premier message** ne retire pas ce droit à une recherche déjà
lancée à la main).

## Usage quotidien

Ouvrez Docker Desktop, puis dans le dossier du projet :

```bash
npm run dev
```

Gardez ce Terminal ouvert. `Ctrl+C` arrête le serveur ; `supabase stop` arrête
la base en conservant les données. **N'ajoutez jamais `--no-backup`**, qui les
efface. Les automatismes ne tournent que si Chrome est ouvert, le Mac éveillé
et le serveur lancé.

- **Recherche** (**Ma recherche**) : une URL de recherche par ligne (10 au
  maximum). Chaque modification valide est enregistrée tout de suite. Chaque
  fiche prend 10 à 20 secondes : 50 fiches ajoutent environ 8 à 17 minutes.
  **Chercher des annonces** relance une recherche environ toutes les
  30 minutes, entre 8 h et 23 h.
  **Pause** tient jusqu'à votre choix : l'autopilote est suspendu et ne relance
  ni ne remplace la recherche, même après un redémarrage de Chrome, tant que
  vous n'avez pas cliqué sur **Reprendre** ou **Stop**. Après **Reprendre**, la
  recherche continue. **Stop** termine la recherche en cours ; si l'autopilote
  reste activé, il en lance une nouvelle environ 30 minutes plus tard.
  **Désactiver l'interrupteur** annule les prochaines recherches et coupe les envois
  automatiques de la recherche qu'il a lancée (elle continue de classer les
  annonces) ; un message dont le clic a déjà eu lieu est parti. Il ne modifie
  pas une recherche lancée à la main avec **Lancer une recherche**. Une
  recherche mise en pause par une erreur est, elle, retentée automatiquement.
- **Premier message** : choisissez une annonce, relisez le message, cliquez sur
  **Envoyer le message**. Pendant l'envoi, l'annonce visée ne change pas.
- **Réponses aux vendeurs** : gardez un onglet Messages leboncoin ouvert. L'autopilote
  traite au plus une conversation toutes les 7 à 13 minutes, entre 08:00 et
  22:59 : les messages non lus d'abord, puis une conversation dont l'aperçu a
  changé. À chaque activation (reprise après une pause comprise), le premier
  passage relève les conversations existantes : celles déjà lues sont laissées
  telles quelles, sans réponse ; les non-lues restent à traiter. Une réponse
  interrompue avant tout envoi (par la pause, par exemple) sur une conversation
  désormais lue apparaît sur l'Accueil, sous **À vous**.
  **Vérifier maintenant** (disponible quand l'autopilote est activé) recharge la
  liste et applique la même règle, même hors de ces horaires, en enchaînant
  jusqu'à 50 conversations. En envoi réel, il peut donc envoyer plusieurs
  réponses. Il s'arrête quand il n'y a plus rien à traiter, à la première
  réponse simulée (les reprises simulées ne l'arrêtent pas), à la première
  erreur ou à la pause. Seules les lignes affichées dans la liste sont prises
  en compte : il ne la fait pas défiler.
  Les réponses partent sans relecture. Le serveur contrôle les prix : aucun
  montant au-dessus du plafond, une offre égale à la cible quand le vendeur
  annonce un prix ou que les prix se contredisent, jamais plus que le plus bas
  montant qu'il cite, et pas d'accord clair sans montant quand son prix dépasse
  le plafond. Un brouillon refusé est le plus souvent régénéré une fois ; s'il
  est encore refusé, c'est un échec de la conversation (voir ci-dessous). La
  formulation, elle, n'est pas contrôlée : surveillez les conversations. Les
  messages du vendeur restés sans réponse sont en revanche filtrés : rendez-vous,
  lieu ou horaire, paiement hors leboncoin, acompte, réservation, coordonnées,
  frais à votre charge, prix en toutes lettres, supplément, remise exprimée en
  différence, montant sous 60 % du prix affiché ou refus citant un montant ;
  rien ne part alors, le motif est « Réponse à rédiger vous-même » et la note dit
  pourquoi. Ce filtre repose sur des mots-clés : il ne reconnaît pas toutes les
  tournures, et vous aurez des reprises pour des messages pourtant anodins.
- **À vous** (Accueil) : **Ouvrir la conversation**, répondez vous-même dans
  leboncoin, puis cliquez sur **C'est fait** (sans retour en arrière). L'outil
  ne paie rien et ne conclut aucun achat.
  Une conversation en échec laisse passer les autres (nouvel essai après 5, puis
  20 minutes ; **Vérifier maintenant** n'attend pas). Au troisième échec, ou si
  vous réactivez l'autopilote entre-temps, elle apparaît dans cette liste et ce
  message n'est plus retenté. Un nouveau message du vendeur est de nouveau
  traité. Un serveur local arrêté, une base de données arrêtée, un modèle
  indisponible (clé, crédit, panne d'OpenRouter), un blocage ou une déconnexion
  ne comptent pas.
  Si l'outil ne sait pas si une réponse est partie (page rechargée ou fermée
  pendant l'envoi, Chrome interrompu, envoi non confirmé), il ne la renvoie
  jamais : la conversation apparaît dans cette liste, « Envoi non confirmé ».
  Vérifiez-la dans leboncoin avant de répondre.
- **Conversations ignorées** (Accueil, **Toutes les conversations**) : avec la portée par défaut,
  les conversations rencontrées dont l'annonce n'a pas de contact enregistré par
  l'outil ne reçoivent aucune réponse. Cette liste (les 100 dernières) permet de
  les repérer. Répondez vous-même, ou changez la portée dans **Réglages**.
- **Envois à vérifier** (Accueil, « Alex : message parti ? ») : un envoi
  interrompu reste bloqué. Après 10 minutes, ouvrez la carte, vérifiez votre
  messagerie, répondez **Oui, il est parti** ou **Non**, puis **Confirmer**.
  Répondre au hasard risque un double message. **Actualiser les envois à
  vérifier** relit la liste.

Évitez de lancer plusieurs outils ou scripts qui interrogent leboncoin en même
temps.

## Mise à jour

1. Mettez l'autopilote de recherche et celui des conversations en pause.
2. Arrêtez le serveur (`Ctrl+C`).
3. [Sauvegardez la base](#sauvegardes) (la base doit être démarrée).
4. Mettez à jour les fichiers **dans le même dossier** (par exemple `git pull`
   si vous avez reçu un dépôt git). Conservez `.env`.
5. Lancez `npm run setup` : il installe les dépendances et applique les nouvelles
   migrations sans effacer les données. `npm run dev` applique aussi les
   migrations en attente.
6. Dans `chrome://extensions`, cliquez sur le bouton de rechargement de « PS5
   mission », puis rechargez les onglets leboncoin déjà ouverts.
7. Lancez `npm run dev` et vérifiez le mode (badge en haut du panneau) et les
   réglages.

**Mode d'envoi après la mise à jour.** L'envoi réel est désormais le réglage par
défaut. Si vous n'aviez jamais enregistré de réglages, la simulation se désactive
avec la mise à jour, et un autopilote resté activé enverra réellement : mettez
les automatismes en pause avant (étape 1) et vérifiez le mode avant de les
réactiver. Une simulation déjà enregistrée est conservée.

**Portée des réponses après la mise à jour.** La version qui ajoute le suivi du
contact par annonce ne répond automatiquement qu'aux annonces avec un contact
enregistré. La migration reprend l'existant seulement quand la preuve vise
l'annonce exacte : envoi incertain, seule annonce contactée d'un vendeur, ou
conversation liée à l'annonce où l'outil a confirmé un envoi. Un message tapé à
la main ne suffit pas. Des négociations en cours peuvent donc rester hors
périmètre, par exemple chez un vendeur à plusieurs annonces sans envoi
enregistré par l'outil.
Après avoir réactivé l'autopilote, surveillez la liste **Conversations
ignorées** et reprenez ces conversations à la main. La réactivation ne
rouvre pas les conversations déjà lues : vérifiez aussi vos négociations en
cours dans leboncoin.

## Dépannage

| Problème | Solution |
| --- | --- |
| « Docker Desktop n'est pas démarré » | Ouvrez Docker, attendez qu'il soit prêt, relancez. |
| Échec de `supabase start` | Mettez à jour Docker et la Supabase CLI. Si le port 54322 est pris, lancez `supabase stop` dans le dossier de l'autre projet Supabase. |
| « OPENROUTER_API_KEY manquante » | Remplissez la ligne dans `.env`, relancez `npm run dev`. |
| « Base non à jour » ou échec des migrations | `supabase migration up --local`. Si l'erreur persiste, gardez le message et demandez de l'aide. **Pas de reset.** |
| « Serveur local injoignable » | Lancez `npm run dev`. Vérifiez que `EXTENSION_ORIGIN` correspond exactement à l'ID de l'extension (sans `/` à la fin), puis redémarrez le serveur. |
| Le port 8835 est occupé | Un autre serveur tourne : arrêtez-le avec `Ctrl+C` dans son Terminal. `lsof -nP -iTCP:8835 -sTCP:LISTEN` indique le programme. |
| `npm run dev` signale un serveur plus ancien que le code | Arrêtez l'ancien serveur et relancez. |
| Une modification de `.env` est ignorée | Redémarrez le serveur. Une variable déjà définie dans le Terminal est prioritaire sur `.env`. |
| « Accès temporairement restreint » | Arrêtez les automatismes et attendez la levée du blocage. N'insistez pas. |
| leboncoin demande de se reconnecter | Reconnectez-vous dans Chrome, puis reprenez. |
| « En attente : gardez un onglet Messages leboncoin ouvert. » | Ouvrez `https://www.leboncoin.fr/messages`. |
| Erreurs de classement ou de réponse | Vérifiez le crédit et la clé OpenRouter. Après des erreurs de classement : `npm run classify -- --pending`. |
| La base écoute sur « toutes les interfaces » | Voir ci-dessous. |

**Exposition réseau.** La base locale utilise un mot de passe par défaut. L'outil
demande à Docker de ne l'ouvrir qu'à votre Mac (`127.0.0.1`). Si vous voyez
l'avertissement, activez le pare-feu de macOS et évitez les réseaux non fiables.
Si la base était déjà lancée avant l'installation, faites `supabase stop` puis
`npm run dev`.

Les journaux de l'extension :

```bash
tail -f logs/extension.log
```

## Données et confidentialité

**Stocké sur votre Mac :**

- la base (volume Docker) : annonces, noms de vendeurs, villes, conversations
  complètes, brouillons et suivi des contacts ;
- le stockage de l'extension dans Chrome : réglages (nom, e-mail), progression
  des recherches, état des conversations et reprises (noms et messages), et les
  50 derniers envois (nom du vendeur, début du message, adresse, date) ;
- `.env` : vos clés ;
- `logs/extension.log` : journal technique, qui peut contenir des adresses de
  pages et des messages d'erreur. Il n'est pas purgé automatiquement.

**Envoyé à OpenRouter** (qui le transmet aux fournisseurs des modèles) :

- pour classer : titre, état, type, marque, plateforme, description, jusqu'à
  8 photos de l'annonce et le résultat de leur analyse ;
- pour répondre : titre, prix, description, état et livraison de l'annonce,
  l'historique des messages de la conversation, le contexte de prix et votre nom
  s'il est renseigné. Les messages peuvent contenir des données personnelles
  écrites par vous ou par le vendeur.

**Envoyé à Resend**, seulement si configuré : le destinataire et le résumé de la
reprise (nom du vendeur, annonce, prix et offres, lieu et date de rendez-vous
enregistrés, notes, dernier message du vendeur, liens).

Ces données concernent aussi des tiers : ne les réutilisez pas pour autre chose
et supprimez ce dont vous n'avez plus besoin. Consultez les conditions
d'OpenRouter et de Resend.

**Ne partagez jamais** `.env`, les journaux, les sauvegardes ni des captures qui
montrent des conversations. En cas de fuite d'une clé, révoquez-la.

Le serveur et ses pages n'ont pas de mot de passe : ils sont prévus pour votre
seul Mac. Ne les exposez pas sur un réseau.

### Sauvegardes

**N'exécutez JAMAIS `supabase db reset` avec de vraies données** : la base est
effacée, y compris le suivi qui évite de recontacter un vendeur. Même
prudence avec `supabase stop --no-backup` et avec le nettoyage ou la
réinitialisation des données de Docker Desktop.

Sauvegarde (base démarrée) :

```bash
mkdir -p sauvegardes
(umask 077; docker exec supabase_db_ps5-mission pg_dump -U postgres -d postgres --schema=public > "sauvegardes/ps5-$(date +%F-%H%M).sql")
ls -lh sauvegardes
```

Vérifiez que le fichier n'est pas vide. Il contient des données personnelles.
La restauration n'est pas automatisée : ne l'improvisez pas sur la base en
service. La sauvegarde ne contient ni `.env` ni les réglages de l'extension.
Retirer l'extension de Chrome efface ses réglages.
