# Acheter autre chose qu'une PS5

Exemple suivi dans tout ce guide : un **MacBook** d'occasion.
**Personne n'a encore fait cette adaptation du début à la fin.**

## En 30 secondes

Imaginez un robot qui fait vos courses d'occasion. Aujourd'hui, il ne connaît
que la PS5. Pour qu'il achète un MacBook, il faut lui réapprendre quatre choses :

| La question du robot | En clair | Voir |
| --- | --- | --- |
| **Où je cherche ?** | L'adresse de la recherche leboncoin | Parties 2 et 3 (étape 7) |
| **C'est un bon objet ?** | Ce qu'il garde et ce qu'il jette | Étapes 1 et 4 |
| **Combien je paie ?** | Les prix, et comment les lire | Étapes 2, 3 et 5 |
| **Qu'est-ce que je dis ?** | Le premier message et les réponses | Étapes 5 et 6 |

**Vous ne savez pas coder ?** Remplissez la demande de la
[partie 5](#5-la-demande-à-donner-à-une-ia-qui-code) et donnez-la à une IA qui
code. Gardez ensuite le **Mode test** jusqu'à avoir tout relu.

## 1. En une phrase

L'outil sait acheter une PS5 ; pour autre chose, il faut changer des réglages
**et** du code.

**Attention : changer l'adresse de recherche et les prix ne suffit pas.**
Voici ce qui se passerait. Les essais ont utilisé le vrai code, avec de
**fausses réponses de l'IA** (la vraie n'a pas été interrogée).

| Ce que vous attendez | Ce qui se passe |
| --- | --- |
| Voir de bons MacBook | L'IA doit répondre à « est-ce une PS5 ? ». Si elle répond non, l'annonce est écartée. |
| Si elle répond oui par erreur | Sans « lecteur de disque », le MacBook est écarté. |
| Un MacBook à bon prix | Zéro manette sur les photos : il reste « À vérifier », sans contact automatique. Mais si **aucune photo** n'a pu être lue, cette règle ne joue pas : il peut devenir « Saint Graal ». |
| Écrire au vendeur | Le message proposé demande si **la PS5** est disponible. |
| Laisser le robot répondre | Il se présente à l'IA comme l'acheteur d'une **PS5**. |
| Un prix maximum de 2500 € | Le panneau le refuse : la limite est 2000 €. |

L'IA peut aussi se tromper dans l'autre sens et classer un MacBook
« Saint Graal ». Ne comptez sur aucun résultat avant d'avoir changé le code.

**L'envoi réel est le réglage de départ.** Avant tout : activez **Mode test**
(onglet **Réglages**) et coupez les trois interrupteurs de l'**Accueil**. Si une
recherche tourne, faites **Stop** dans **Annonces**.

## 2. Ce qui se change sans code

| Quoi | Où dans le panneau |
| --- | --- |
| Adresses de recherche (10 au maximum) | **Annonces**, icône de réglage, **Ma recherche** |
| Nombre de pages, résultats, fiches | Même écran, **Réglages avancés** |
| Bon prix et prix maximum (**de 100 à 2000 €**) | **Réglages** |
| Votre nom, votre e-mail d'alerte | **Réglages** |
| Le texte d'un premier message envoyé à la main | **Annonces**, une annonce, champ **Votre message** |

Pour la recherche : faites-la sur leboncoin, cliquez **Ajouter la page
ouverte**, puis effacez la ligne de la PS5. Un texte retouché ne vaut que pour
cet envoi. Le contact **automatique** garde le message écrit dans le code.

**Tant que le code n'est pas changé, laissez « Envoyer le premier message » et
« Répondre aux vendeurs » coupés**, même après un contact fait à la main.

## 3. Ce qui demande du code (dans cet ordre)

Pour trouver un nom, utilisez « Rechercher » dans votre éditeur. **Ne faites
jamais « tout remplacer » sur le projet** :

- `console` sert aussi au code (`console.log`) : le remplacer casse des tests ;
- ne renommez pas les noms en `ps5_`, `ps5-` ou `__ps5`, ni `project_id` dans
  `supabase/config.toml`. Vous pourriez perdre vos réglages (l'envoi
  redeviendrait réel) ou ouvrir une base vide, qui ne sait plus qui a déjà été
  contacté.

### Étape 1. Écrire vos règles sur papier

| Question | PS5 (aujourd'hui) | MacBook (exemple) |
| --- | --- | --- |
| C'est bien l'objet ? | La console, pas un accessoire | L'ordinateur entier, pas une coque ni un chargeur |
| Obligatoire | Un lecteur de disque | Une puce Apple (M1 ou plus récente) |
| Nécessaire pour un bon classement | Au moins une manette | Le chargeur |
| Défauts graves | HS, bannie de PlayStation | Écran cassé, ne démarre pas, verrou iCloud ou d'entreprise |
| Bon prix / maximum | 350 € / 370 € | 700 € / 800 € (chiffres inventés) |

### Étape 2. Changer les limites de prix

À faire **seulement** si un prix peut dépasser 2000 € ou être sous 100 €.
Sinon, passez à l'étape 3. Les **quatre** limites doivent rester d'accord.

| Fichier | À chercher | Exemple avant → après |
| --- | --- | --- |
| [settings.js](../extension/lib/settings.js) | `const price` | `<= 2000` → `<= 5000` |
| [vue-reglages.js](../extension/panel/vue-reglages.js) | `PRIX_MAX` | `2000` → `5000` |
| [price-context.js](../scripts/lib/price-context.js) | `plausiblePrice` | `2_000` → `5_000` |
| [negotiate-server.js](../scripts/negotiate-server.js) | `prix_max` | `demande <= 2000` → `demande <= 5000` |

Sans cela, `normalizeSettings` remplace en silence 2400 / 2500 € par
**350 / 370 €**. Et « je vous le fais à 2500 € » n'est pas lu comme un prix.

Au-dessus de 2000 €, adaptez aussi `findPriceLikeNumbers` dans
[price-guard.js](../scripts/lib/price-guard.js). Il prend certains nombres seuls
pour une **année** : dans « je peux monter 2030 », il ne voit aucun prix. Un
montant trop haut pourrait donc passer ce contrôle.

**Vérifier** (la réponse doit contenir `goodPrice: 2400`) :

```bash
node -e "import('./extension/lib/settings.js').then(m=>console.log(m.normalizeSettings({goodPrice:2400,maxPrice:2500})))"
```

### Étape 3. Apprendre à lire les prix d'un MacBook

**Même sous 2000 €, c'est le point le plus dangereux.**

| Message du vendeur | Ce que le code lit aujourd'hui |
| --- | --- |
| `je vous le fais à 1500 €` | 1500, correct |
| `je vous le fais à 1 500 €` (avec une espace) | **500, faux** |
| `je vous le fais à 1.500 €` | aucun prix |

Un second filtre bloque souvent ces cas (le montant lui paraît trop bas), mais
ne comptez pas dessus.

| Fichier et nom | À faire pour le MacBook |
| --- | --- |
| [price-context.js](../scripts/lib/price-context.js), `MONTANT` et `currentPrices` | Lire `1 500` et `1.500`, sans coller les chiffres d'une fiche technique. |
| Même fichier, `extractLabelledDescriptionPrice` | Avant : `prix de la ps5` ou `console`. Après : `prix du macbook`. |
| [price-guard.js](../scripts/lib/price-guard.js), `findPriceLikeNumbers` | Ignorer les modèles comme `A2338`, aujourd'hui lus comme 2338 €. |
| [seller-risk.js](../scripts/lib/seller-risk.js), `SUJETS` et `montants` | Voir les fausses alertes ci-dessous. |

Fausses alertes vues : « la batterie a 94 cycles » (montant trop bas, pour un
prix de 800 €) et « numéro de série » (coordonnées). Le robot vous rend alors la
main. C'est gênant mais prudent : dans le doute, gardez le filtre.

`MacBook M2 16 Go 512 Go 2021` n'est pas pris pour un prix demandé : gardez-le
ainsi.

**Vérifier** (aujourd'hui `500`, après correction `1500`) :

```bash
node -e "import('./scripts/lib/price-context.js').then(m=>console.log(m.derivePriceContext({annonce:{prix_eur:1600}},'je vous le fais à 1 500 €',{goodPrice:1400,maxPrice:1500}).sellerMessagePrice))"
```

### Étape 4. Changer le tri des annonces

Tout est dans [classify.js](../scripts/classify.js). Changez le **texte** des
questions à l'IA. **Gardez les noms techniques** (`est_console`,
`console_ps5_visible`, `lecteur_disque_present`, `lecteur_disque_visible`,
`manettes_visibles`) : le code et la base les relisent.

| À chercher | Rôle simple | MacBook : le nouveau sens |
| --- | --- | --- |
| `decideEstConsole` | Est-ce le bon objet, d'après le titre ? | « Est-ce un MacBook entier ? » |
| `analyzeImages` | L'IA regarde les photos | MacBook visible ; puce si elle est lisible ; nombre de chargeurs |
| `decideDiscDrive` | Critère obligatoire | « A-t-il une puce Apple ? » |
| `computeClassification` | Classe selon le prix | `manettes_incluses` veut dire « chargeurs » |
| `RE_DEFAUT_MAJEUR` | Défauts repérés sans IA | `MacBook HS`, écran cassé, verrou iCloud |
| `RE_RESTRICTION_ACTIVE` et ses voisines, `decideDefautMajeur` | Bannissements PlayStation | À remplacer par vos verrous |
| `runPipeline` et `computeClassification` | Raisons affichées | Enlever « PS5 » et « Édition Digitale » |

Exemple pour `decideDiscDrive` :

```text
Avant : « Cette PS5 est-elle une édition à lecteur de disque physique ? »
Après : « Ce MacBook a-t-il une puce Apple, M1 ou plus récente ? »
```

Changez aussi les `criteria` (ce qui veut dire vrai ou faux) et les consignes de
photos. Le critère obligatoire ne se voit pas toujours sur une photo : dites à
l'IA de lire d'abord le titre et la description. Si elle répond « plutôt non »
(score sous 0,5), l'annonce est écartée.

Aujourd'hui, `MacBook Pro pour pièces` et `Recherche MacBook` sont déjà
écartés. `MacBook HS`, « écran cassé » et « bloqué iCloud » **passent** ce
premier filtre.

Si le chargeur n'a pas d'importance, remplacez la règle `manetteOk`.

**La base de données** : inutile de la modifier. Les colonnes
`lecteur_disque` et `manettes_incluses` changent seulement de sens. Gardez les
quatre classements (`saint_graal`, `interessant`, `a_verifier`,
`disqualifiee`) : la base et l'extension les attendent.

**Vérifier** : `npm test`, puis quelques vraies annonces en Mode test (étape 4
de la partie « Tester »). Comparez chaque classement avec votre feuille.

### Étape 5. Changer la négociation

D'abord le **prompt** (le texte qui donne ses consignes à l'IA) : dans
[negotiate-server.js](../scripts/negotiate-server.js), fonction
`buildNegotiationMessages`. Relisez-le en entier.

```text
Avant : un particulier qui cherche à acheter une PS5 d'occasion
Après : un particulier qui cherche à acheter un MacBook d'occasion
```

Changez aussi les défauts graves (« console hors service ou lecteur cassé »),
les accessoires et « pour la PS5 ». Gardez les règles de sécurité, les raisons
d'arrêt et le format de réponse. Dans ce même fichier, `SUJET_DEFAUT` liste les
mots qui désignent une panne : ajoutez batterie, écran, clavier.

Ensuite, les **écarts de prix**. Ils sont fixes, en euros : petits pour un
MacBook cher.

| Règle actuelle | Où la chercher |
| --- | --- |
| Première offre : bon prix − 10 | `opening` dans `derivePriceContext` et `buildNegotiationMessages` |
| Montée de 10 en 10, sans dépasser le bon prix | `previousOffer + 10` dans `derivePriceContext` |
| Dernière offre au maximum, après une offre au bon prix, si le vendeur demande maximum + 10 à + 50 | `finalOfferEligible` |
| Exemples du prompt : bon prix − 20, maximum + 30 | `easy` et `resisting` |
| Les mêmes chiffres expliqués à l'écran | [vue-reglages.js](../extension/panel/vue-reglages.js) : cherchez `10 €`, `10 à 50` et `goodPrice - 10` |

Exemple MacBook (un choix, non testé) : première offre − 50, montée de 25,
dernière offre si l'écart est de 25 à 100 €. Changez tout ensemble.

**Vérifier** : `npm test`. Des tests qui attendent les anciens montants vont
échouer. Aucun test ne dit si l'IA négocie bien : relisez ses brouillons.

### Étape 6. Changer le premier message

Dans [templates.js](../extension/lib/templates.js), changez
`MESSAGE_CONTACT_PAR_DEFAUT` **et** le second texte de `TEMPLATES_PAR_DEFAUT`.

```js
export const MESSAGE_CONTACT_PAR_DEFAUT = 'Bonjour, est-ce que le MacBook est toujours disponible svp ?';
```

**Vérifier** : en Mode test, ouvrez une annonce et cliquez sur **Essayer sans
envoyer**. Lisez le texte tapé.

### Étape 7. Changer les valeurs de départ

| Fichier | À chercher | Après |
| --- | --- | --- |
| [search-autopilot-state.js](../extension/sw/search-autopilot-state.js) | `DEFAULT_SEARCH_OPTIONS` | Votre adresse, copiée depuis leboncoin |
| [settings.js](../extension/lib/settings.js) | `DEFAULT_SETTINGS` | `goodPrice: 700`, `maxPrice: 800` |
| [leboncoin.js](../scripts/lib/leboncoin.js) | `referer` | `text=macbook` (sert à `--enrichir`) |

L'adresse actuelle contient des filtres de consoles (`category`,
`video_game_type`, prix) : remplacez-la **en entier**.

**Les valeurs déjà enregistrées dans Chrome restent prioritaires.** Changez
aussi l'adresse et les prix dans le panneau. `DEFAULT_SETTINGS` sert aussi à la
commande `npm run classify` et à la page « copilote ».

Les fichiers [extract-detail.js](../extension/sw/extract-detail.js) et
`leboncoin.js` lisent des champs de jeux vidéo (`video_game_type`,
`console_brand`, `console_model`…). Sur une annonce d'ordinateur, `type`,
`marque` ou `plateforme` seront peut-être vides. **Pas vérifié sur le vrai
site** : comparez sur une annonce avant de les changer, dans les deux fichiers.

### Étape 8. Changer les mots à l'écran

Cela ne change pas le comportement. Dans chaque fichier, cherchez le texte
indiqué.

- Extension : [manifest.json](../extension/manifest.json) (`name`,
  `description`, `default_title`), [panel.html](../extension/panel/panel.html)
  (`<title>`), [vue-reglages.js](../extension/panel/vue-reglages.js)
  (`AVERTISSEMENTS`), [vue-contact.js](../extension/panel/vue-contact.js)
  (`ad/consoles`),
  [conversation-poller.js](../extension/sw/conversation-poller.js)
  (`PS5 Mission`, les notifications).
- Serveur : [negotiate-server.js](../scripts/negotiate-server.js)
  (`HANDOFF_ACTIONS`, les objets des e-mails ; `HANDOFF_DEFAULT_FROM` ;
  `Copilote PS5`).
- Pages : [dashboard.html](../dashboard.html) (`PS5 Mission`, `Lecteur disque`,
  `Digital`, `manette`), [negociation.html](../negociation.html) (`PS5`).
- Descriptions : [README.md](../README.md), [technique.md](technique.md),
  [.env.example](../.env.example), [package.json](../package.json).

Les icônes (une simple bulle) peuvent rester. **Vérifier** : rechargez
l'extension et relisez chaque écran.

## 4. Tester sans risque

1. Gardez **Mode test** activé. Le badge **Mode test : rien ne part** doit être
   visible. Dans un onglet d'essai, **n'appuyez ni sur Envoyer ni sur Entrée**.
2. Lancez `npm test` avant et après chaque étape. Les tests simulent Chrome et
   les services externes.
3. **Des tests attendent la PS5.** Voici ce qui a échoué lors d'essais sur une
   copie (la liste dépend de vos choix) :

   | Changement | Tests à regarder |
   | --- | --- |
   | Adresse de départ | `search-autopilot-state` |
   | Premier message | `templates`, `run-recherche` |
   | Limites de prix | `panel-reglages` |
   | Prix de départ | `settings`, `negotiate-server`, `server-pricing`, `server-turns`, `conversation-routes`, `run-recherche`, `service-worker-contact`, `panel-reglages` |
   | Règle des manettes supprimée | `classify` |
   | Mots de l'écran Réglages, objets des e-mails | `panel-reglages`, `negotiate-server` |

   Ils sont dans le dossier `tests/`. Mettez à jour un résultat attendu
   **seulement** si votre règle a vraiment changé. Changer seulement le texte
   des consignes à l'IA ne fait rien échouer : les tests ne le jugent pas.

4. Relancez `npm run dev`, rechargez l'extension et les onglets leboncoin.
   Faites une petite recherche : 1 page, 5 résultats, 5 fiches. Cochez
   **Réanalyser les annonces déjà en base** après un changement du tri.
5. Même en Mode test, leboncoin est consulté, la base est écrite et
   OpenRouter est **facturé**.
6. Si l'outil a déjà servi pour la PS5, les anciennes annonces et conversations
   restent. Écartez les anciennes annonces dans le tableau de bord. **N'effacez
   pas la base** ([sauvegardes](../README.md#sauvegardes)).

En Mode test, le robot ignore les annonces jamais contactées pour de vrai : ne
pas voir de réponse ne prouve rien. Avant un vrai envoi, suivez
[Passer en envoi réel](../README.md#passer-en-envoi-réel) : **un seul**
message, relu.

## 5. La demande à donner à une IA qui code

Remplissez les crochets, puis copiez tout. Ne donnez jamais votre fichier
`.env`, vos journaux ni vos conversations.

```text
Adapte ce projet pour acheter [un MacBook d'occasion] au lieu d'une PS5.
Lis docs/personnaliser.md et vérifie-le contre le code.
Mes règles : objet [...], obligatoire [...], pour un bon classement [...],
défauts graves [...], bon prix [...], maximum [...], première offre / montée /
dernière offre [...], premier message [...].

À traiter :
- limites : settings.js (price), vue-reglages.js (PRIX_MIN, PRIX_MAX),
  price-context.js (plausiblePrice), negotiate-server.js (prix_max)
- prix et risques : price-context.js (MONTANT, currentPrices,
  extractLabelledDescriptionPrice), price-guard.js (findPriceLikeNumbers),
  seller-risk.js (SUJETS, montants). Cas : "1 500 €", "1.500 €", "512 Go",
  "A2338", "94 cycles", "2030"
- scripts/classify.js : decideEstConsole, analyzeImages, decideDiscDrive,
  computeClassification (manetteOk), RE_DEFAUT_MAJEUR,
  RE_RESTRICTION_ACTIVE et voisines, decideDefautMajeur, runPipeline
- negotiate-server.js : buildNegotiationMessages, SUJET_DEFAUT,
  HANDOFF_ACTIONS, HANDOFF_DEFAULT_FROM, message de démarrage
- écarts de prix : derivePriceContext, prompt, textes de vue-reglages.js
- templates.js, search-autopilot-state.js (DEFAULT_SEARCH_OPTIONS),
  DEFAULT_SETTINGS, scripts/lib/leboncoin.js (referer)
- champs de fiche : extension/sw/extract-detail.js et scripts/lib/leboncoin.js
  (ne pas deviner : me demander un exemple anonymisé)
- textes : manifest.json, panel.html, vue-contact.js, conversation-poller.js,
  dashboard.html, negociation.html, README.md, docs/technique.md,
  .env.example, package.json

Contraintes : pas de remplacement global. Ne renomme ni les noms ps5_*, ps5-*,
__ps5*, ni project_id, ni les colonnes, classements, clés JSON ou raisons
d'arrêt. Aucune migration modifiée, jamais de supabase db reset. Test d'abord,
vu en échec, puis correction ; montre npm test. N'affaiblis aucun contrôle de
prix ou de risque sans me demander. Ne lis pas .env. N'envoie aucun message et
ne consulte pas leboncoin.
```

## 6. Liste à cocher

- [ ] Mode test activé, interrupteurs coupés, base sauvegardée
- [ ] Mes règles sont écrites
- [ ] `1 500 €` est lu 1500 ; les limites couvrent mes prix
- [ ] Le tri correspond à ma feuille sur de vraies annonces
- [ ] Brouillons de négociation relus, écarts de prix adaptés
- [ ] Message, adresse et prix changés, aussi dans le panneau
- [ ] `npm test` passe, plus de « PS5 » à l'écran
- [ ] Premier envoi réel : un seul, vérifié sur leboncoin

Rappel : automatiser leboncoin peut enfreindre ses conditions d'utilisation
([à lire](../README.md#à-lire-avant-de-commencer)).
