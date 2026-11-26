// Extraction par regex des blocs d'accessibilité "sr-only" d'une carte de
// résultat leboncoin. Ces blocs sont stables ; les classes CSS, hashées,
// ne le sont pas. Fonctions pures : aucun accès au DOM.

// Les URLs d'images servies au navigateur pointent parfois vers une variante
// AVIF, que les API de vision (OpenAI/Gemini) refusent en 400. On force une
// règle qui rend du JPEG.
export function normalizeImageUrl(url) {
  return url.replace(/rule=[^&]*/, 'rule=ad-image');
}

export function parseArticleFields(text) {
  const prixMatch = text.match(/Prix:\s*(\d[\d\s]*)\s?€/);
  const etatMatch = text.match(/(État neuf|Très bon état|Bon état|Satisfaisant|Comme neuf)/);
  const attrsMatch = text.match(/Type:\s*"([^"]*)"\.\s*Marque:\s*"([^"]*)"\.\s*Plateforme:\s*"([^"]*)"/);
  const villeMatch = text.match(/Située à (.+?)\s(\d{5})(?:\s+([^.]+))?\./);

  return {
    prix_eur: prixMatch ? parseInt(prixMatch[1].replace(/\s/g, ''), 10) : null,
    etat: etatMatch ? etatMatch[1] : null,
    type: attrsMatch ? attrsMatch[1] : null,
    marque: attrsMatch ? attrsMatch[2] : null,
    plateforme: attrsMatch ? attrsMatch[3] : null,
    livraison_possible: /Livraison possible|Livraison dès/.test(text),
    ville: villeMatch ? villeMatch[1] : null,
    code_postal: villeMatch ? villeMatch[2] : null,
    quartier: villeMatch && villeMatch[3] ? villeMatch[3].trim() : null,
    sponsorise: /Annonce à la une/.test(text),
  };
}
