// Repère dans un message tout nombre qui peut se lire comme un prix. En cas de
// doute le nombre est retenu : mieux vaut refuser un brouillon que proposer
// plus que le plafond.

const NOMBRE = /(?<!\p{N})(?:[1-9][   .]\d{3}(?!\d)|\d+)(?:[.,]\d{1,2}(?!\d))?/gu;
const DEVISE = /^\s*(?:€|(?:euros?|eur|e|balles?)(?![\p{L}\p{N}]))/iu;
// Suffixes collés qui ne sont pas des prix, chacun avec les nombres auxquels il
// s'applique : heure, milliers de pixels, rang, révision d'un modèle.
const SUFFIXES = [
  [/^h(?![\p{L}\p{N}])/u, (valeur) => valeur <= 24],
  [/^[kK](?![\p{L}\p{N}])/u, (valeur) => valeur < 100],
  [/^(?:er|ère|e?me|ème)(?![\p{L}\p{N}])/u, () => true],
  [/^[A-D](?![\p{L}\p{N}])/u, (valeur) => valeur >= 1000],
];
const UNITE = /^\s*(?:go|gb|gigas?|to|tb|téra|tera|mo|hz|fps|pouces?|km|watts?|w)(?![\p{L}\p{N}])/iu;

export function findPriceLikeNumbers(message) {
  // Les heures, dates et références de modèle sont neutralisées d'abord.
  const texte = String(message ?? '')
    .replace(/\b\d{1,2}\s*(?:h|:)\s*\d{2}\b/gi, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\bCFI[\s-]*\w+/gi, ' ')
    .replace(/\bps\s*[1-5](?!\d)/gi, ' ');
  const prix = [];
  for (const match of texte.matchAll(NOMBRE)) {
    const [brut] = match;
    const suite = texte.slice(match.index + brut.length);
    const valeur = Number(brut.replace(/[   ]|\.(?=\d{3})/g, '').replace(',', '.'));
    if (!DEVISE.test(suite)) {
      if (UNITE.test(suite) || SUFFIXES.some(([motif, concerne]) => motif.test(suite) && concerne(valeur))) continue;
      // Une année seule.
      if (/^(?:19[89]\d|20[0-3]\d)$/.test(brut) && !/(?:à|pour|faire|offre|prix)\s*$/i.test(texte.slice(0, match.index))) continue;
    }
    prix.push(valeur);
  }
  return prix;
}
