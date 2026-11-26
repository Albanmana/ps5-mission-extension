// Quel prix le vendeur demande, et quelle offre il autorise.
import { DEFAULT_SETTINGS } from './server-settings.js';

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function plausiblePrice(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 2_000 ? parsed : null;
}

function extractLabelledDescriptionPrice(description) {
  if (typeof description !== 'string') return null;
  const match = description.match(
    /(?:prix\s+(?:de\s+la\s+)?(?:ps5|console)|(?:ps5|console)(?:\s+seule?)?\s*(?:[:=]|est\s+à))\s*[:=]?\s*(\d{3,4})\s*(?:€|euros?)?/i,
  );
  return plausiblePrice(match?.[1]);
}

const MONTANT = /(?<![\p{L}\d]|\d[.,])(\d{3,4})(?!\d|[.,]\d)(?!\s*(?:go|gb|to|tb|hz|pouces?)(?!\p{L}))(\s*(?:€|(?:euros?|e)(?![\p{L}\d])))?/giu;

// Montant lié à la vente par le vendeur lui-même : jamais écarté.
const VENTE_AVANT = /(?:je\s+(?:peux\s+)?(?:(?:vous|te)\s+)?(?:(?:la|le)\s+)?(?:vends|fais|faire|laisse|laisser|c[èe]de|c[ée]der)(?:\s+partir)?(?:\s+(?:à|a|pour))?|dernier\s+prix(?:\s*(?::|=|de|c'est|est(?:\s+de)?))?)\s*$/u;
const VENTE_APRES = /^\s*(?:€|euros?)?\s*,?\s*dernier\s+prix(?!\s*(?:de|:|=)?\s*\d)/u;
// Autres tournures qui font d'un nombre nu un prix demandé.
const PRIX_AVANT = /(?:prix(?:\s+est)?(?:\s+de)?|est\s+[àa]|reste\s+[àa]|moins\s+de|descends?\s+[àa]|monte\s+[àa]|co[uû]te(?:ra)?|ok\s+pour)\s*(?::|=|à|de)?\s*$/u;
const PRIX_APRES = /^\s*,?\s*(?:pas\s+moins|et\s+(?:elle|c'est|il)\s+(?:est\s+)?[àa]\s+(?:vous|toi)|port\s+(?:compris|inclus)|ferme(?!\p{L}))/u;

const ADVERBES = String.raw`(?:\s+(?:pas|bien|tout|juste|déjà|deja|pourtant|vraiment|vite|quand\s+m[êe]me))*`;
const AUXILIAIRE = String.raw`(?<!\p{L})(?:ai|as|a|avons|avez|ont|avais|avait|avaient)`;
// Récit d'un achat. « port payé 380 » ou « elle coûte 380 » restent un prix actuel.
const ACHAT_PASSE = new RegExp([
  String.raw`(?<!(?:port|envoi|livraison|frais)\s+)(?<!\p{L})(?:achet|pay)(?:é|ée|és|ées|ee|ees)(?!\p{L})`,
  String.raw`(?<!\p{L})(?:achete|acheter|achat)(?!\p{L})`,
  String.raw`${AUXILIAIRE}${ADVERBES}\s+(?:paye|coute)(?!\p{L})`,
  String.raw`${AUXILIAIRE}${ADVERBES}\s+(?:eue?|prise?)(?!\p{L})`,
  String.raw`(?<!\p{L})co[uû]t(?:é|ée|és|ées|ais|ait|aient)(?!\p{L})`,
  String.raw`(?<!\p{L})co[uû]t\s+(?:\p{L}+\s+)?[ée]tait(?!\p{L})`,
  String.raw`viens\s+de\s+(?:l'|la\s+|le\s+)?(?:acheter|payer)(?!\p{L})`,
].join('|'), 'u');
// Prix de référence (neuf ou autre vendeur), avant ou après le montant.
// « comme neuve » décrit l'occasion.
const PRIX_DE_REFERENCE = /(?<!(?:comme|[ée]tat|quasi|quasiment|presque)\s+)(?<!\p{L})(?:neu(?:f|ve)s?|en\s+magasin|[àa]\s+la\s+fnac|ailleurs|back\s?market|vinted|ebay|amazon|cdiscount|micromania|rakuten|cash\s+converters|sur\s+(?:internet|le\s+net)|(?:un\s+autre|quelqu'un(?:\s+d'autre)?)\s+(?:m'|me\s+)(?:propose|offre|donne))(?!\p{L})/u;

const COUPURE = /[.,;!?\n]|(?<!\p{L})mais(?!\p{L})/u;

// Chaque montant du message qui peut être le prix demandé aujourd'hui. Ceux
// qu'écarte un prix de référence sont marqués : la lecture reste incertaine.
function currentPrices(message) {
  if (typeof message !== 'string') return [];
  const texte = message.toLowerCase().replace(/’/g, "'");
  const matches = [...texte.matchAll(MONTANT)];
  const seul = /^\s*\d{3,4}\s*[?!]*\s*$/.test(texte);
  const prices = [];
  let debut = 0;
  matches.forEach((match, index) => {
    const fin = match.index + match[0].length;
    const avant = texte.slice(debut, match.index).split(COUPURE).at(-1);
    const suite = texte.slice(fin, matches[index + 1]?.index);
    debut = fin;
    const price = plausiblePrice(match[1]);
    if (price == null) return;
    const lie = VENTE_AVANT.test(avant) || VENTE_APRES.test(suite);
    if (!lie) {
      // Après le montant, seule sa propre proposition compte.
      if (ACHAT_PASSE.test(avant)) return;
      if (PRIX_DE_REFERENCE.test(avant) || PRIX_DE_REFERENCE.test(suite.split(COUPURE)[0])) {
        prices.push({ price, ecarte: true });
        return;
      }
      if (!(seul || match[2] || PRIX_AVANT.test(avant) || PRIX_APRES.test(suite))) return;
    }
    prices.push({ price, lie });
  });
  return prices;
}

export function derivePriceContext(conversation, messageVendeur, settings = DEFAULT_SETTINGS) {
  const { goodPrice, maxPrice } = settings;
  const listingPrice = nullableNumber(conversation?.annonce?.prix_eur);
  const descriptionPrice = extractLabelledDescriptionPrice(conversation?.annonce?.description);
  const amounts = currentPrices(messageVendeur);
  const asked = amounts.filter((entry) => !entry.ecarte);
  const lies = asked.filter((entry) => entry.lie);
  const sellerMessagePrice = asked.length
    ? Math.min(...(lies.length ? lies : asked).map((entry) => entry.price))
    : null;
  const effectiveSellerPrice = sellerMessagePrice ?? descriptionPrice ?? listingPrice;
  const distinctPrices = new Set(
    [listingPrice, descriptionPrice, sellerMessagePrice].filter((price) => price != null),
  );
  const previousOffer = nullableNumber(conversation?.offre_envoyee_eur);
  // Un montant que nous avons déjà proposé reste répétable, jamais au-delà de maxPrice.
  const alreadyOffered = previousOffer != null && previousOffer > goodPrice
    ? Math.min(previousOffer, maxPrice) : null;
  const finalOfferEligible = previousOffer != null
    && previousOffer >= goodPrice
    && sellerMessagePrice != null
    && sellerMessagePrice >= maxPrice + 10
    && sellerMessagePrice <= maxPrice + 50;
  const ceiling = finalOfferEligible ? maxPrice : alreadyOffered ?? goodPrice;
  const opening = goodPrice - 10;
  let targetOffer = effectiveSellerPrice;
  if (effectiveSellerPrice != null && effectiveSellerPrice > goodPrice) {
    if (finalOfferEligible) targetOffer = maxPrice;
    else if (alreadyOffered != null) targetOffer = Math.min(effectiveSellerPrice, alreadyOffered);
    else targetOffer = previousOffer == null || previousOffer < opening ? opening : Math.min(goodPrice, previousOffer + 10);
  }
  return {
    listingPrice,
    descriptionPrice,
    sellerMessagePrice,
    effectiveSellerPrice,
    conflict: distinctPrices.size > 1,
    targetOffer,
    ceiling,
    // Contrôles d'envoi seulement, non transmis au modèle.
    // Plancher des offres : un montant écarté à tort ne doit pas faire offrir plus.
    sellerLowestAsked: amounts.length ? Math.min(...amounts.map((entry) => entry.price)) : null,
  };
}
