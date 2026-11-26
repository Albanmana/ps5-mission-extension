// Ce qu'aucune réponse automatique ne doit approuver, même par une phrase
// neutre : repéré dans les messages du vendeur, la conversation revient à
// l'utilisateur. Volontairement large : dans le doute, on n'envoie pas.
import { findPriceLikeNumbers } from './price-guard.js';
import { normalizeText, sansDefautNie } from './french-text.js';

const motif = (...formes) => new RegExp(formes.join('|'));

const NOMBRE_EN_LETTRES = '(?:dix|vingt|trente|quarante|cinquante|soixante|quatre vingts?|cents?)';

// Textes normalisés : sans accents, sans apostrophes ni traits d'union.
const SUJETS = [
  ['un rendez-vous, un lieu ou un horaire', motif(
    String.raw`\b(?:rdv|rendez vous|rencontr\w*|(?:se|on se) (?:voit|voir|capter?|retrouve\w*)|retrouvons)\b`,
    String.raw`\bje suis (?:a|vers|pres de) (?!votre\b|l ecoute)`,
    String.raw`\b(?:mains? propres?|main a (?:la )?main|sur place|chez (?:moi|vous|toi|nous))\b`,
    String.raw`\b(?:venir|venez|viendr\w*|viens(?! de?\b)|(?:passer|passez|passerai\w*)(?! (?:par|via) (?:le )?(?:paiement|leboncoin|bon coin))|recuper\w*|chercher)\b`,
    String.raw`\b(?:deplac\w*|livrer|je (?:vous )?l apporte|gare|metro|parking|mairie|centre (?:ville|commercial)|habit(?:e|es|ez|ons))\b`,
    String.raw`\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|week ?end|demain|ce (?:soir|midi|matin)|aujourd hui|tout a l heure|cet(?:te)? (?:apres midi|aprem)|quelle heure)\b`,
    String.raw`\b(?:[01]?\d|2[0-3]) ?h(?: ?[0-5]\d)?\b`,
  )],
  ['un paiement hors leboncoin', motif(
    String.raw`\b(?:especes?(?! de\b)|liquide|cash|virement|paypal|lydia|paylib|wero|wise|western union|mandat|cheques?)\b`,
    String.raw`\b(?:crypto\w*|bitcoin|revolut|carte cadeau|transcash|pcs|rib|iban|payez moi|en direct)\b`,
    String.raw`\b(?:regl(?:er|ez|ement)|(?:vous|tu) paye[sz]?|a (?:la )?reception|en (?:\d+|deux|trois|plusieurs) fois)\b`,
    String.raw`\bhors (?:le |du )?(?:bon coin|boncoin|leboncoin|lbc|site|appli\w*|plateforme)\b`,
  )],
  ['un acompte ou une caution', motif(String.raw`\b(?:acompte|arrhes|caution|depot|d avance|une avance)\b`)],
  ['une réservation', motif(
    String.raw`\b(?:reserv\w*|bloquer|(?:je|vous|te) (?:(?:la|le) )?bloqu(?:e|ez|erai\w*)|(?:mets|mettre|mettrai) de cote)\b`,
    String.raw`\b(?:je|vous) (?:(?:la|le) )?gard(?:e|erai\w*)\b|\b(?:vous|te) (?:la|le) gard\w*`,
  )],
  ['des coordonnées ou un contact hors leboncoin', motif(
    String.raw`\b(?:telephone\w*|tel(?! quel)|numero|num|mon portable|votre portable|whats ?app|sms|texto|appel(?:er|ez|le|les|lez)\b)`,
    String.raw`\b(?:e ?mail|mail|courriel|gmail|snap\w*|telegram|instagram|insta|messenger|facebook|fb|discord|joindre|contactez|contacte moi|zero (?:six|sept)|adresse|lien|www|https?)\b`,
    '@', String.raw`\b0[1-9](?:[ .]?\d{2}){4}\b`,
  )],
  ['des frais à votre charge', motif(
    String.raw`\ba (?:votre|ta|vos|tes) (?:charge|frais)\b`,
    String.raw`\b(?:frais|port|livraison|envoi)\b[^.!?]{0,20}\b(?:en plus|en sus|non compris|non inclus|pour vous)\b`,
    String.raw`(?:\bplus|\+) (?:(?:les|le|des) )?(?:frais|port\b|envoi|livraison)`,
  )],
  ['un prix écrit en toutes lettres', motif(
    String.raw`\b(?:un|deux|trois|quatre|cinq|six|sept|huit|neuf|\d) cents?\b(?! pour)`,
    String.raw`\bcents? ${NOMBRE_EN_LETTRES}\b`,
    String.raw`\b${NOMBRE_EN_LETTRES} (?:€|euros?\b|balles\b|de (?:plus|moins)\b)`,
  )],
  ['un supplément payant', motif(
    String.raw`\bsupplement\w*`,
    String.raw`\b(?:r?ajout\w*)\b.*(?:€|\beuros?\b|\b[1-9]\d+\b)`,
    String.raw`\b[1-9]\d+ ?(?:€|euros?)? (?:de plus|en plus|en sus)\b`,
    String.raw`\b(?:de plus|en plus|en sus) (?:pour |a )?[1-9]\d+`,
    String.raw`\+ ?\d+ ?(?:€|euros?\b)`,
  )],
  ['une remise exprimée en différence', motif(
    String.raw`\b(?:baiss\w*|enlev\w*|retir\w*|remise|reduction|rabais|ristourne|geste|deduis|deduire) (?:de |d )?\d+`,
    String.raw`\b(?:descendre|descends) de \d+`,
    String.raw`\b\d+ ?(?:€|euros?)? (?:de )?(?:moins\b(?! de)|remise|reduction|rabais|ristourne)`,
    String.raw`(?:^| )\- ?\d+ ?(?:€|euros?\b)`,
  )],
];

const REFUS_CHIFFRE = /\btrop (?:bas|peu)\b|\b(?:pas|jamais|refuse)(?: (?!moins\b)[a-z]+){0,4} \d{3}\b/;
const NEGATION = /\b(?:non|pas|ne|jamais|aucun\w*|refus\w*|trop|impossible)\b/;
// Sous cette part du prix affiché, un montant n'est pas le prix de la console.
const PART_MINIMALE = 0.6;

function montants(message) {
  // « 100 % » ou « 100 pour cent » ne sont pas des montants.
  const texte = message.replace(/\d+ ?(?:%|pour ?cent)/g, ' ');
  const avecDevise = [...texte.matchAll(/(\d+) ?(?:€|euros?\b|balles\b)/g)].map((match) => Number(match[1]));
  return [...avecDevise, ...findPriceLikeNumbers(texte).filter((nombre) => nombre >= 50)];
}

function sujetDuMessage(message, { reference, offrePrecedente }) {
  const brut = normalizeText(message);
  const texte = brut.replace(/-/g, ' ').replace(/\s+/g, ' ');
  const sujet = SUJETS.find(([, forme]) => forme.test(texte) || forme.test(brut));
  if (sujet) return sujet[0];
  const cites = montants(texte);
  if (cites.some((montant) => montant < reference * PART_MINIMALE)) return 'un montant très inférieur au prix affiché';
  const propos = sansDefautNie(texte);
  // Un refus qui cite un montant, ou notre offre reprise à côté d'un autre prix :
  // impossible de savoir lequel le vendeur demande.
  const offreCitee = offrePrecedente != null && cites.some((montant) => montant <= offrePrecedente)
    && (NEGATION.test(propos) || cites.some((montant) => montant > offrePrecedente));
  if (cites.length && (offreCitee || REFUS_CHIFFRE.test(propos))) return 'un refus qui cite un montant';
  return null;
}

// Les messages du vendeur restés sans réponse de notre part.
export function unansweredSellerMessages(conversation, messageVendeur) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const depuis = messages.slice(messages.findLastIndex((message) => message?.expediteur === 'moi') + 1)
    .filter((message) => message?.expediteur === 'vendeur')
    .map((message) => String(message.contenu ?? ''));
  return [...new Set([...depuis, String(messageVendeur ?? '')])];
}

// Premier sujet à risque trouvé, sinon null.
export function screenSellerMessages(messages, options) {
  for (const message of messages) {
    const sujet = sujetDuMessage(message, options);
    if (sujet) return sujet;
  }
  return null;
}
