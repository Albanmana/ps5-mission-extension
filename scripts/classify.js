#!/usr/bin/env node
// Pipeline de classification IA des annonces PS5.
//
// Usage :
//   node scripts/classify.js chemin/vers/annonces.json [--force] [--limit=N]
//
// `annonces.json` : un tableau d'objets minimum { url_annonce, titre }, avec
// au choix image_url (page de résultats) ou description et images[] (fiche).
//
// Par défaut, saute toute annonce déjà analysée (analyse_ia_le non nul en
// base) pour ne pas repayer des appels API inutilement. --force réanalyse
// tout. --limit=N ne traite que les N premières annonces du fichier.
//
// Pipeline en 2 étages, chacun un appel Jev distinct (typesafe/jev-1.13,
// "Decisions API" — pas un chat completion : renvoie une probabilité
// calibrée pour une question typée, pas du texte libre) :
//
//   1. Étage "console" (texte seul, pas cher) : est-ce que l'annonce
//      concerne bien une console PS5, et pas un accessoire (casque VR,
//      manette seule, façade, support...) ? Si non → disqualifiée direct,
//      on ne dépense pas d'appel vision dessus.
//   2. Étage "lecteur de disque" (vision + décision), seulement pour les
//      annonces confirmées console : un modèle de vision
//      (google/gemini-3.1-flash-lite, multimodal GA pas cher) décrit les
//      photos en JSON structuré, puis Jev tranche la question éliminatoire
//      à partir du titre + description + analyse des photos.
//
// Le reste (palier de prix, présence de manette) est calculé en code,
// déterministe — pas besoin d'un LLM pour comparer un prix à un seuil.
// Résultat upsert dans `annonces` (Supabase local), par url_annonce.

import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { loadEnv } from './lib/env.js';
import { pathToFileURL } from 'node:url';
import { listIdFromUrl, resolveUrlAnnonce, retryOnDuplicate } from './lib/listing.js';
import { DEFAULT_SETTINGS } from './lib/server-settings.js';
import { chargerNonAnalysees, chargerAEnrichir, upsertAnnonce as upsertFiche, marquerIntrouvable } from './lib/annonces.js';
import { recupererFiche, delaiProchaineRequete, patienter, AccesRestreint, FicheIntrouvable } from './lib/leboncoin.js';

loadEnv();

function requireApiKey() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY manquante (attendue dans .env ou l'environnement).");
  }
  return apiKey;
}

export const VISION_MODEL = 'google/gemini-3.1-flash-lite'; // seul "Gemini 3.1 Flash" qui existe sur OpenRouter (pas de variante non-Lite)
export const DECISION_MODEL = 'typesafe/jev-1.13';
const DB_URL = process.env.SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export const PRIX_SAINT_GRAAL = DEFAULT_SETTINGS.goodPrice;
export const PRIX_INTERESSANT = DEFAULT_SETTINGS.maxPrice;

// Zone grise de l'étage "console" (texte seul) : en dessous de 0.3, on fait
// confiance à Jev pour disqualifier direct ; au-dessus de 0.7, on fait
// confiance pour continuer. Entre les deux (une vraie console au titre mal
// orthographié peut y tomber) on vérifie avec le modèle de vision.
const EST_CONSOLE_ZONE_GRISE_BASSE = 0.3;
const EST_CONSOLE_ZONE_GRISE_HAUTE = 0.7;

async function orFetch(path, body) {
  const res = await fetch(`https://openrouter.ai/api${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

// Signal fiable et purement textuel qu'aucune photo ne peut trancher : un
// titre "Recherche.../Cherche..." ou une intention d'achat placée en tête
// ("Achète...", "J'achète...", "Achat...", "Acheter...") est une annonce
// d'ACHAT (WTB), jamais une
// vente. Pas besoin d'IA pour ça — et surtout, il ne faut PAS laisser la
// vision "confirmer" un faux positif juste parce que la photo (souvent une
// photo de référence) montre une vraie PS5 : la vision ne peut pas juger
// l'intention (vendre vs chercher à acheter), seul le texte le peut.
// Sans ce filtre, des annonces d'achat pouvaient finir classées "saint_graal".
const RE_RECHERCHE = /\b(recherche|cherche|recherch[ée])(?=\W|$)/i;
const RE_ACHAT_EN_TETE = /^\s*(?:j['’]\s*)?(?:ach[eè]te|acheter|achat)(?=\W|$)/i;
const RE_DEFAUT_MAJEUR = /\b(?:a\s+repar(?:er|e)|pour\s+pieces?|hors\s+service)\b|\b(?:ps\s*5|console)\s+hs\b|\bhs\s+(?:ps\s*5|console)\b/i;
const RE_RESTRICTION_RESOLUE = /\bn['’]?est\s+(?:pas|plus)\s+(?:bannie?|suspendue?|bloquee?|interdite?)\b|\bn['’]?a\s+jamais\s+ete\s+(?:bannie?|suspendue?|bloquee?|interdite?)\b|\bsans\s+(?:etre\s+)?(?:bannie?|suspendue?|bloquee?|interdite?)\b|\b(?:pas|non|jamais)\s+(?:bannie?|suspendue?|bloquee?|interdite?)\b|\b(?:pas\s+de|aucun|sans)\s+(?:ban|bannissement|suspension|restriction|blocage)\b(?:\s+(?:psn|playstation))?|\b(?:ban|bannissement|suspension|restriction|blocage)\b.{0,30}\b(?:levee?|resolue?|terminee?)\b|\b(?:suspension|restriction|blocage|interdiction)\s+(?:a\s+ete\s+)?(?:levee?|resolue?|terminee?)\b|\b(?:erreur\s+)?ws-116332-6\b.{0,40}\b(?:resolue?|corrigee?|levee?)\b|\bacces\s+(?:au\s+)?psn\s+(?:est\s+)?(?:ok|retabli|fonctionnel)\b/gi;
const RE_RESTRICTION_NON_RESOLUE = /\b(?:ban|bannissement|suspension|restriction|blocage|erreur\s+ws-116332-6)\b.{0,50}\b(?:(?:non|pas|toujours\s+pas)\s+|n['’]a\s+(?:toujours\s+)?pas\s+ete\s+)(?:levee?|resolue?|terminee?|corrigee?)\b/i;
const RE_CONTEXTE_PLAYSTATION = /\b(?:psn|playstation(?:\s+network)?|sony|services?\s+en\s+ligne)\b/i;
const RE_RESTRICTION_ACTIVE = /\b(?:ps\s*5|console)\b.{0,100}\b(?:bannie?|suspendue?|bloquee?|interdite?)\b|\b(?:bannie?|suspendue?|bloquee?|interdite?)\b.{0,100}\b(?:ps\s*5|console|psn|playstation)\b|\bacces\b.{0,100}\b(?:suspendu|bloque|interdit)\b|\b(?:ban|bannissement|suspension|restriction|blocage)\b.{0,60}\b(?:psn|playstation)\b|\b(?:psn|playstation)\b.{0,60}\b(?:ban|bannissement|suspension|restriction|blocage)\b/i;
const MOYEN_HORS_PLATEFORME = String.raw`(?:virements?(?:\s+bancaires?)?|wero|paypal)`;
const ELEMENT_MOYEN_HORS_PLATEFORME = String.raw`(?:(?:de|du|des|le|la|les)\s+)?${MOYEN_HORS_PLATEFORME}`;
const LISTE_CONJONCTIONS_HORS_PLATEFORME = String.raw`${ELEMENT_MOYEN_HORS_PLATEFORME}(?:\s+(?:et|ni|ou)\s+${ELEMENT_MOYEN_HORS_PLATEFORME})*`;
const LISTE_SUFFIXE_HORS_PLATEFORME = String.raw`${ELEMENT_MOYEN_HORS_PLATEFORME}(?:(?:\s*,\s*(?:(?:et|ni|ou)\s+)?|\s+(?:et|ni|ou)\s+)${ELEMENT_MOYEN_HORS_PLATEFORME})*`;
const RE_PAIEMENT_HORS_PLATEFORME = new RegExp(String.raw`\b${MOYEN_HORS_PLATEFORME}\b`, 'gi');
const RE_REFUS_PAIEMENT_HORS_PLATEFORME = new RegExp(
  String.raw`(?:\b(?:pas|aucun|jamais|sans)\s+(?:de\s+)?(?:paiements?\s+(?:par|via)\s+)?${LISTE_CONJONCTIONS_HORS_PLATEFORME}\b|\bni\s+${ELEMENT_MOYEN_HORS_PLATEFORME}(?:\s+ni\s+${ELEMENT_MOYEN_HORS_PLATEFORME})+\b|\b(?:je\s+)?refus(?:e|ons)\s+(?:les?\s+)?(?:paiements?\s+(?:par|via)\s+)?${LISTE_CONJONCTIONS_HORS_PLATEFORME}\b|\b${LISTE_SUFFIXE_HORS_PLATEFORME}\s+(?:(?:est|sont)\s+)?(?:refusee?s?|interdite?s?|non\s+acceptes?|pas\s+acceptes?)\b)`,
  'gi',
);

export function decideRecherche(annonce) {
  const titre = annonce.titre || '';
  return RE_RECHERCHE.test(titre) || RE_ACHAT_EN_TETE.test(titre);
}

export function decideDefautMajeur(annonce) {
  const titre = normaliserTexte(annonce.titre);
  if (RE_DEFAUT_MAJEUR.test(titre)) return true;
  const description = normaliserTexte(annonce.description);
  return description.split(/(?:[.!?;\n]+|\bmais\b)/).some((phrase) => {
    if (RE_RESTRICTION_NON_RESOLUE.test(phrase)
      && (RE_CONTEXTE_PLAYSTATION.test(phrase) || /\bws-116332-6\b/i.test(phrase))) return true;
    const sansResolution = phrase.replace(RE_RESTRICTION_RESOLUE, ' ');
    if (/\bws-116332-6\b/i.test(sansResolution)) return true;
    const avecContexte = `${titre} ${sansResolution}`;
    return RE_CONTEXTE_PLAYSTATION.test(avecContexte) && RE_RESTRICTION_ACTIVE.test(avecContexte);
  });
}

function normaliserTexte(value) {
  return String(value || '')
    .replaceAll('€', 'e')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export function decidePaiementHorsPlateforme(annonce) {
  const texte = normaliserTexte(`${annonce.titre || ''}\n${annonce.description || ''}`);
  const refus = [...texte.matchAll(RE_REFUS_PAIEMENT_HORS_PLATEFORME)].map((match) => [
    match.index ?? 0,
    (match.index ?? 0) + match[0].length,
  ]);
  for (const mention of texte.matchAll(RE_PAIEMENT_HORS_PLATEFORME)) {
    const debut = mention.index ?? 0;
    const fin = debut + mention[0].length;
    if (!refus.some(([refusDebut, refusFin]) => debut >= refusDebut && fin <= refusFin)) return true;
  }
  return false;
}

export async function decideEstConsole(annonce) {
  const data = await orFetch('/alpha/decisions', {
    model: DECISION_MODEL,
    state: {
      titre: annonce.titre,
      etat: annonce.etat,
      type: annonce.type,
      marque: annonce.marque,
      plateforme: annonce.plateforme,
    },
    questions: {
      est_console: {
        type: 'noul',
        instructions:
          "Cette annonce concerne-t-elle la console PlayStation 5 elle-même (le boîtier), et pas juste un accessoire ou un objet lié (casque VR, manette seule, façade/coque, support, jeu, abonnement, recherche d'achat...) ?",
        criteria: {
          true: 'Le titre désigne clairement la console PS5 en vente (ex. "PS5", "PlayStation 5", "PS5 slim + jeux")',
          false: "Le titre désigne un accessoire ou autre chose que la console elle-même (ex. \"Casque VR PS5\", \"Manette PS5\", \"Façade PS5\", \"Recherche PS5\")",
        },
      },
    },
  });
  return data.answers.est_console;
}

// Les URLs de la page de résultats pointent parfois vers une variante AVIF
// ("?rule=...-avif"), non supportée par les API de vision — on force JPEG.
function normalizeImageUrl(url) {
  return url.replace(/rule=[^&]*/, 'rule=ad-image');
}

export const MAX_IMAGE_BYTES = 5_000_000;

const IMAGE_TIMEOUT_MS = 10_000;

// Leboncoin sert ses images à un navigateur, mais répond 403 aux fetchers des
// fournisseurs de vision (IP de datacenter). On télécharge donc nous-mêmes et
// on transmet les octets inline : le modèle n'a plus rien à aller chercher.
// Un échec sur une image ne doit jamais faire tomber toute la classification.
export async function chargerImage(url, { fetch: request = (...a) => fetch(...a), maxBytes = MAX_IMAGE_BYTES } = {}) {
  try {
    const response = await request(url, {
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      headers: { accept: 'image/*' },
    });
    if (!response.ok) return null;

    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (!type?.startsWith('image/')) return null;

    const annoncee = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(annoncee) && annoncee > maxBytes) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) return null;

    return `data:${type};base64,${buffer.toString('base64')}`;
  } catch {
    // Réseau, délai dépassé, réponse illisible : on se passe de cette image.
    return null;
  }
}

export async function analyzeImages(annonce, { charger = chargerImage, demander = orFetch } = {}) {
  const urls = (annonce.images?.length ? annonce.images : [annonce.image_url])
    .filter(Boolean)
    .map(normalizeImageUrl)
    .slice(0, 8);

  const images = (await Promise.all(urls.map((url) => charger(url)))).filter(Boolean);
  if (images.length === 0) {
    const notes = urls.length === 0
      ? 'Aucune image fournie.'
      : `Aucune image exploitable (${urls.length} téléchargement(s) en échec).`;
    return { lecteur_disque_visible: null, manettes_visibles: null, accessoires_visibles: [], notes };
  }

  const prompt = `Tu regardes des photos d'une annonce leboncoin cataloguée comme console PlayStation 5.
Réponds UNIQUEMENT avec un objet JSON (pas de texte autour), au format exact :
{
  "console_ps5_visible": true | false | null,
  "lecteur_disque_visible": true | false | null,
  "manettes_visibles": <entier>,
  "accessoires_visibles": ["string", ...],
  "notes": "string, 1-2 phrases factuelles"
}

- console_ps5_visible : true si le boîtier d'une console PS5 (peu importe l'édition) est bien visible sur au moins une photo, false si les photos montrent seulement un accessoire (casque, manette seule, façade, câble...) sans la console elle-même, null si les photos ne permettent pas de trancher.

Comment distinguer les deux éditions sur les photos (indice visuel clé) :
- Édition Digitale (SANS lecteur) : le boîtier est globalement SYMÉTRIQUE de haut en bas / d'un côté à l'autre (les deux ailerons ont la même longueur), et il n'y a AUCUNE fente rectangulaire ni bouton d'éjection visible sur la face avant ou le côté.
- Édition à lecteur de disque : une fine fente rectangulaire (le lecteur Blu-ray) est visible sur la face avant ou le côté, en général accompagnée d'un petit bouton d'éjection juste à côté. Sur les modèles verticaux, cette fente rend souvent le boîtier visuellement LÉGÈREMENT ASYMÉTRIQUE à cet endroit (un côté plus large que l'autre).

- lecteur_disque_visible : true si tu identifies clairement la fente de lecteur (ou l'asymétrie qu'elle crée), false si le boîtier est clairement symétrique sans aucune fente (édition Digitale), null si console_ps5_visible est false, ou si les photos ne permettent pas de trancher avec confiance.
- manettes_visibles : nombre de manettes DualSense distinctes visibles sur les photos (0 si aucune).
- accessoires_visibles : liste courte des accessoires/jeux visibles en plus de la console (câbles, socle, jeux en boîte, casque, boîte d'origine, etc). Liste vide si rien de notable.
- N'invente rien qui ne soit pas visible sur les photos.`;

  const content = [
    { type: 'text', text: prompt },
    ...images.map((dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } })),
  ];

  const data = await demander('/v1/chat/completions', {
    model: VISION_MODEL,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
  });

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse vision vide.');
  return extractJson(text);
}

export async function decideDiscDrive(annonce, vision) {
  const data = await orFetch('/alpha/decisions', {
    model: DECISION_MODEL,
    state: {
      titre: annonce.titre,
      description: annonce.description,
      analyse_photos: vision,
    },
    questions: {
      lecteur_disque_present: {
        type: 'noul',
        instructions:
          "Cette PS5 est-elle une édition à lecteur de disque physique (PAS une édition 'Digital' sans lecteur) ? Base-toi sur le titre, la description (mention explicite 'Digital'/'Édition Digitale' = pas de lecteur) et l'analyse des photos fournie dans le state.",
        criteria: {
          true: 'Lecteur de disque confirmé (titre/description ne mentionnent pas "Digital", et/ou photos montrent la fente de lecteur)',
          false: "Édition Digitale confirmée (titre/description mentionnent 'Digital', et/ou photos montrent le design sans lecteur)",
        },
      },
    },
  });
  return data.answers.lecteur_disque_present;
}

export function computeClassification(
  { prix_eur, lecteur_disque, manettes_incluses },
  { goodPrice, maxPrice } = DEFAULT_SETTINGS,
) {
  if (!lecteur_disque) {
    return {
      disqualifiee: true,
      disqualification_raison: 'Édition Digitale (pas de lecteur de disque) détectée par le pipeline IA.',
      classification: 'disqualifiee',
    };
  }
  let classification = 'a_verifier';
  // "Au moins une manette incluse" est un critère explicite pour être
  // "intéressant" — sans manette détectée, on plafonne à a_verifier même si
  // le prix est bas (ce n'est pas éliminatoire comme le lecteur de disque,
  // juste pas suffisant pour un verdict positif automatique).
  const manetteOk = manettes_incluses == null || manettes_incluses >= 1;
  if (prix_eur != null && manetteOk) {
    if (prix_eur <= goodPrice) classification = 'saint_graal';
    else if (prix_eur <= maxPrice) classification = 'interessant';
  }
  return { disqualifiee: false, disqualification_raison: null, classification };
}

async function alreadyAnalyzed(client, urlRecue) {
  const url_annonce = await resolveUrlAnnonce(client, urlRecue, 'public.annonces');
  const res = await client.query(
    'select analyse_ia_le is not null as done from public.annonces where url_annonce = $1',
    [url_annonce],
  );
  return res.rows[0]?.done === true;
}

export async function upsert(client, recue, analysis) {
  return retryOnDuplicate(async () => ecrireAnalyse(client, {
    ...recue,
    url_annonce: await resolveUrlAnnonce(client, recue.url_annonce, 'public.annonces'),
  }, analysis));
}

async function ecrireAnalyse(client, annonce, analysis) {
  const {
    url_annonce, titre, description, prix_eur, etat, type, marque, plateforme,
    livraison_possible, ville, code_postal, images, sponsorise, date_publication,
    likes, modes_remise, call_to_actions,
  } = annonce;

  // coalesce sur les champs "détail" : une entrée issue de la page de
  // résultats (pas de description/images[]) ne doit pas écraser une
  // annonce déjà enrichie via la page annonce.
  const res = await client.query(
    `insert into public.annonces (
       url_annonce, titre, description, prix_eur, etat, type, marque, plateforme,
       livraison_possible, ville, code_postal, images, sponsorise, date_publication,
       likes, modes_remise, call_to_actions,
       est_console, lecteur_disque, manettes_incluses, accessoires_bonus,
       disqualifiee, disqualification_raison, classification, analyse_ia, list_id, analyse_ia_le
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
       $18,$19,$20,$21,$22,$23,$24,$25,$26, now()
     )
     on conflict (url_annonce) do update set
       titre = coalesce(excluded.titre, public.annonces.titre),
       description = coalesce(excluded.description, public.annonces.description),
       prix_eur = coalesce(excluded.prix_eur, public.annonces.prix_eur),
       etat = coalesce(excluded.etat, public.annonces.etat),
       type = coalesce(excluded.type, public.annonces.type),
       marque = coalesce(excluded.marque, public.annonces.marque),
       plateforme = coalesce(excluded.plateforme, public.annonces.plateforme),
       livraison_possible = excluded.livraison_possible,
       ville = coalesce(excluded.ville, public.annonces.ville),
       code_postal = coalesce(excluded.code_postal, public.annonces.code_postal),
       images = case when excluded.images = '{}' then public.annonces.images else excluded.images end,
       sponsorise = excluded.sponsorise,
       date_publication = coalesce(excluded.date_publication, public.annonces.date_publication),
       likes = coalesce(excluded.likes, public.annonces.likes),
       modes_remise = coalesce(excluded.modes_remise, public.annonces.modes_remise),
       call_to_actions = case when excluded.call_to_actions = '{}' then public.annonces.call_to_actions else excluded.call_to_actions end,
       est_console = excluded.est_console,
       lecteur_disque = excluded.lecteur_disque,
       manettes_incluses = excluded.manettes_incluses,
       accessoires_bonus = excluded.accessoires_bonus,
       disqualifiee = case when public.annonces.decision_manuelle then public.annonces.disqualifiee else excluded.disqualifiee end,
       disqualification_raison = case when public.annonces.decision_manuelle then public.annonces.disqualification_raison else excluded.disqualification_raison end,
       classification = case when public.annonces.decision_manuelle then public.annonces.classification else excluded.classification end,
       analyse_ia = excluded.analyse_ia,
       analyse_ia_le = excluded.analyse_ia_le,
      list_id = coalesce(public.annonces.list_id, excluded.list_id)
     returning disqualifiee, disqualification_raison, classification`,
    [
      url_annonce, titre ?? null, description ?? null, prix_eur ?? null, etat ?? null,
      type ?? null, marque ?? null, plateforme ?? null, livraison_possible ?? false,
      ville ?? null, code_postal ?? null, images ?? [], sponsorise ?? false,
      date_publication ?? null, likes ?? null,
      modes_remise ? JSON.stringify(modes_remise) : null,
      call_to_actions ?? [],
      analysis.est_console, analysis.lecteur_disque, analysis.manettes_incluses, analysis.accessoires_bonus,
      analysis.disqualifiee, analysis.disqualification_raison, analysis.classification,
      JSON.stringify(analysis.analyse_ia),
      listIdFromUrl(url_annonce),
    ],
  );
  // Valeurs réellement en base : une décision manuelle a pu primer.
  return res?.rows?.[0] ?? null;
}

async function runPipeline(annonce, settings) {
  if (decidePaiementHorsPlateforme(annonce)) {
    return {
      analysis: {
          est_console: null,
          lecteur_disque: null,
          manettes_incluses: null,
          accessoires_bonus: null,
          disqualifiee: true,
          disqualification_raison: 'Demande explicite de paiement hors plateforme (virement, Wero ou PayPal).',
          classification: 'disqualifiee',
          analyse_ia: {
            est_console_etage: 'regex_paiement_hors_plateforme',
            analyzed_at: new Date().toISOString(),
          },
        },
      output: '  disqualifiee (paiement hors plateforme demandé)',
    };
  }

  if (decideDefautMajeur(annonce)) {
    return {
      analysis: {
          est_console: true,
          lecteur_disque: null,
          manettes_incluses: null,
          accessoires_bonus: null,
          disqualifiee: true,
          disqualification_raison: 'Défaut majeur explicite (console à réparer, HS, pour pièces ou bannie/suspendue des services PlayStation).',
          classification: 'disqualifiee',
          analyse_ia: {
            est_console_etage: 'regex_defaut_majeur',
            analyzed_at: new Date().toISOString(),
          },
        },
      output: '  disqualifiee (défaut majeur explicite)',
    };
  }

  if (decideRecherche(annonce)) {
    return {
      analysis: {
          est_console: false,
          lecteur_disque: null,
          manettes_incluses: null,
          accessoires_bonus: null,
          disqualifiee: true,
          disqualification_raison: "Annonce de recherche (achat), pas une vente — titre contenant \"recherche\"/\"cherche\".",
          classification: 'disqualifiee',
          analyse_ia: {
            est_console_etage: 'regex_recherche',
            analyzed_at: new Date().toISOString(),
          },
        },
      output: '  disqualifiee (annonce de recherche/achat, pas une vente)',
    };
  }

  const estConsole = await decideEstConsole(annonce);
  const enZoneGrise = estConsole.noul >= EST_CONSOLE_ZONE_GRISE_BASSE && estConsole.noul < EST_CONSOLE_ZONE_GRISE_HAUTE;

  // Confidemment pas une console (proba basse) : pas besoin de vision.
  if (estConsole.noul < EST_CONSOLE_ZONE_GRISE_BASSE) {
    return {
      analysis: {
          est_console: false,
          lecteur_disque: null,
          manettes_incluses: null,
          accessoires_bonus: null,
          disqualifiee: true,
          disqualification_raison: `Ce n'est probablement pas une console PS5 (accessoire ?) — probabilité "console" ${estConsole.noul.toFixed(2)} (texte seul).`,
          classification: 'disqualifiee',
          analyse_ia: {
            decision_model: DECISION_MODEL,
            est_console_etage: 'texte',
            est_console_probabilite: estConsole.noul,
            analyzed_at: new Date().toISOString(),
          },
        },
      output: `  disqualifiee (pas une console, probabilité ${estConsole.noul.toFixed(2)}, texte seul)`,
    };
  }

  // Sinon (console probable, ou zone grise à trancher) : on a de toute
  // façon besoin de la vision — soit pour confirmer/infirmer la
  // présence d'une console sur les photos (zone grise), soit pour le
  // lecteur de disque (console confirmée). Un seul appel vision sert
  // aux deux.
  const vision = await analyzeImages(annonce);

  let isConsole = estConsole.noul >= EST_CONSOLE_ZONE_GRISE_HAUTE;
  let estConsoleEtage = 'texte';
  if (enZoneGrise) {
    estConsoleEtage = 'texte+vision';
    if (vision.console_ps5_visible === true) isConsole = true;
    else if (vision.console_ps5_visible === false) isConsole = false;
    else isConsole = estConsole.noul >= 0.5; // vision aussi inconclusive : dernier recours sur le texte
  }

  if (!isConsole) {
    return {
      analysis: {
          est_console: false,
          lecteur_disque: null,
          manettes_incluses: null,
          accessoires_bonus: null,
          disqualifiee: true,
          disqualification_raison: `Ce n'est probablement pas une console PS5 (accessoire ?) — probabilité "console" ${estConsole.noul.toFixed(2)} (${estConsoleEtage}, vision: ${vision.console_ps5_visible}).`,
          classification: 'disqualifiee',
          analyse_ia: {
            vision_model: VISION_MODEL,
            decision_model: DECISION_MODEL,
            est_console_etage: estConsoleEtage,
            est_console_probabilite: estConsole.noul,
            vision,
            analyzed_at: new Date().toISOString(),
          },
        },
      output: `  disqualifiee (pas une console, ${estConsoleEtage}, proba texte ${estConsole.noul.toFixed(2)})`,
    };
  }

  const discDrive = await decideDiscDrive(annonce, vision);
  const lecteurDisque = discDrive.noul >= 0.5;

  const classification = computeClassification({
    prix_eur: annonce.prix_eur,
    lecteur_disque: lecteurDisque,
    manettes_incluses: vision.manettes_visibles,
  }, settings);

  return {
    analysis: {
      est_console: true,
      lecteur_disque: lecteurDisque,
      manettes_incluses: vision.manettes_visibles ?? null,
      accessoires_bonus: vision.accessoires_visibles?.length ? vision.accessoires_visibles : null,
      ...classification,
      analyse_ia: {
        vision_model: VISION_MODEL,
        decision_model: DECISION_MODEL,
        est_console_etage: estConsoleEtage,
        est_console_probabilite: estConsole.noul,
        vision,
        lecteur_disque_present_probabilite: discDrive.noul,
        analyzed_at: new Date().toISOString(),
      },
    },
    output: `  ${classification.classification}${classification.disqualifiee ? ' (' + classification.disqualification_raison + ')' : ''}`,
  };
}

// Traite une annonce de bout en bout : étages 0 à 3, puis upsert.
// Renvoie l'analyse telle qu'elle a été écrite en base.
export async function classifyAnnonce(client, annonce, { force = false, settings = DEFAULT_SETTINGS } = {}) {
  // Un client interrompu peut avoir perdu l’accusé alors que l’analyse est
  // déjà en base. Lui rendre le résultat actuel permet de réconcilier son
  // état sans payer une seconde analyse ni dépendre d’une ancienne lecture.
  // Une décision manuelle n'est jamais réanalysée, même en forçant.
  const { rows } = await client.query(
    `select classification, disqualifiee, disqualification_raison, est_console,
            lecteur_disque, manettes_incluses, accessoires_bonus, analyse_ia_le, decision_manuelle
     from public.annonces where url_annonce = $1`,
    [annonce.url_annonce],
  );
  if (rows[0] && (rows[0].decision_manuelle || (!force && rows[0].analyse_ia_le))) {
    const { decision_manuelle: _manuelle, ...actuel } = rows[0];
    return { ...actuel, url_annonce: annonce.url_annonce, saute: true };
  }
  const { analysis, output } = await runPipeline(annonce, settings);
  const enBase = await upsert(client, annonce, analysis);
  // Titre et résultat sortent d'un seul `console.log` : le serveur classe
  // plusieurs annonces en parallèle, et deux appels séparés autour du `await`
  // du pipeline laissaient les lignes s'entrelacer — un résultat se retrouvait
  // affiché sous le titre d'une autre annonce.
  console.log(`→ ${annonce.titre || annonce.url_annonce}\n${output}`);
  return { url_annonce: annonce.url_annonce, saute: false, ...analysis, ...enBase };
}

// Consultation des fiches depuis le serveur. Le rythme est volontairement
// irrégulier et lent : une cadence régulière est la signature d'un script.
// Au moindre refus de leboncoin on s'arrête net plutôt que d'insister.
async function enrichirFiches(client, limite) {
  const cibles = await chargerAEnrichir(client, { limite });
  console.log(`${cibles.length} fiche(s) à récupérer (les plus prometteuses d'abord).`);

  let reussies = 0;
  let echecs = 0;
  // Un refus franc n'est pas la seule forme de blocage : une connexion coupée
  // à répétition en est souvent le premier signe. On s'arrête avant d'insister.
  let echecsConsecutifs = 0;
  const MAX_ECHECS_CONSECUTIFS = 3;
  for (const [rang, cible] of cibles.entries()) {
    if (rang > 0) {
      const attente = delaiProchaineRequete(rang);
      console.log(`  … ${(attente / 1000).toFixed(1)} s`);
      await patienter(attente);
    }
    try {
      const fiche = await recupererFiche(cible.url_annonce);
      await upsertFiche(client, fiche);
      const { classification } = await classifyAnnonce(client, { ...cible, ...fiche }, { force: true });
      reussies += 1;
      echecsConsecutifs = 0;
      // classifyAnnonce imprime déjà le titre et le verdict : on n'ajoute que
      // le déplacement, qui est l'intérêt de l'enrichissement.
      if (cible.classification && classification && classification !== cible.classification) {
        console.log(`  (sur la seule carte : ${cible.classification})`);
      }
    } catch (error) {
      if (error instanceof AccesRestreint) {
        console.error(`\nArrêt : ${error.message}`);
        console.error('Reprendre plus tard ; insister ferait bloquer votre adresse.');
        break;
      }
      if (error instanceof FicheIntrouvable) {
        await marquerIntrouvable(client, cible.url_annonce);
        // Un 410 est une réponse normale du serveur : nous ne sommes pas
        // freinés, c'est l'annonce qui n'existe plus.
        echecsConsecutifs = 0;
        console.log(`→ ${cible.titre || cible.url_annonce}\n  supprimée de leboncoin, sortie de la file`);
        continue;
      }
      echecs += 1;
      echecsConsecutifs += 1;
      console.error(`  Erreur sur ${cible.url_annonce} : ${error.message}`);
      if (echecsConsecutifs >= MAX_ECHECS_CONSECUTIFS) {
        console.error(`\nArrêt après ${MAX_ECHECS_CONSECUTIFS} échecs consécutifs : leboncoin nous freine probablement.`);
        break;
      }
    }
  }
  console.log(`\n${reussies} fiche(s) enrichie(s), ${echecs} en échec.`);
}

async function main() {
  requireApiKey();
  const args = process.argv.slice(2);
  const inputPath = args.find((a) => !a.startsWith('--'));
  const force = args.includes('--force');
  // Rattrape les annonces déjà en base qu'aucune analyse n'a abouti à couvrir
  // (échec d'API, image refusée...). Le run de recherche ne les revoit que si
  // elles réapparaissent dans les résultats, ce qui n'est pas garanti.
  const pending = args.includes('--pending');
  // Récupère la fiche complète (description, toutes les photos) des annonces
  // connues seulement par leur carte de résultats.
  const enrichir = args.includes('--enrichir');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

  if (!inputPath && !pending && !enrichir) {
    console.error('Usage : node scripts/classify.js chemin/vers/annonces.json [--force] [--limit=N]');
    console.error('        node scripts/classify.js --pending [--limit=N]');
    console.error('        node scripts/classify.js --enrichir [--limit=N]');
    console.error('        --pending  reprend les annonces en base restées sans analyse.');
    console.error('        --enrichir récupère la fiche complète des annonces sans description.');
    process.exit(1);
  }

  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  if (enrichir) {
    await enrichirFiches(client, Number.isFinite(limit) ? limit : 50);
    await client.end();
    return;
  }

  let annonces;
  if (pending) {
    annonces = await chargerNonAnalysees(client, { limite: Number.isFinite(limit) ? limit : 500 });
    console.log(`${annonces.length} annonce(s) en base sans analyse.`);
  } else {
    annonces = JSON.parse(readFileSync(inputPath, 'utf8'));
    if (!Array.isArray(annonces)) {
      console.error('Le fichier d\'entrée doit contenir un tableau JSON d\'annonces.');
      process.exit(1);
    }
    annonces = annonces.slice(0, limit);
  }

  let nbAnalysees = 0;
  let nbSautees = 0;

  for (const recue of annonces) {
    let annonce = recue;
    if (!annonce.url_annonce) {
      console.warn('Annonce sans url_annonce, ignorée.');
      continue;
    }
    if (!force && (await alreadyAnalyzed(client, annonce.url_annonce))) {
      console.log(`→ ${annonce.titre || annonce.url_annonce} — déjà analysée, ignorée (--force pour réanalyser)`);
      nbSautees++;
      continue;
    }
    try {
      annonce = { ...annonce, url_annonce: await resolveUrlAnnonce(client, annonce.url_annonce, 'public.annonces') };
      await classifyAnnonce(client, annonce, { force: true });
      nbAnalysees++;
    } catch (err) {
      console.error(`  Erreur : ${err.message}`);
    }
  }

  console.log(`\n${nbAnalysees} annonce(s) analysée(s), ${nbSautees} déjà analysée(s) ignorée(s).`);
  await client.end();
}

// Comparaison d'argv, comme le serveur : les Node plus anciens ignorent
// silencieusement la propriété `main` d'import.meta.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
