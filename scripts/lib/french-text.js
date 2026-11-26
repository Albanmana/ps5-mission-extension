// Lecture de textes français, partagée par le filtre des messages vendeur et la
// mise en forme des réponses.

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// « pas de souci » ou « aucun défaut » n'annoncent rien, sauf s'ils sont nuancés.
const DEFAUT_NIE = /\b(?:pas de|pas d|aucun|aucune|sans) (?:probleme|souci|defaut|panne|bug|rayure|bruit|choc|trace|casse)s?\b(?!,? (?:sauf|a part|mis a part|hormis|excepte|juste))/g;
export const sansDefautNie = (texte) => texte.replace(DEFAUT_NIE, ' ');

// --- Proposition simple : « # » remplace le montant exact de l'offre.

const SOURIRES_FINAUX = /(?:\s*(?:🙂|😊|😉|🤔|😅)️?)+\s*$/u;
const AMORCE = String.raw`(?:ok pour |(?:je peux (?:vous )?(?:faire|mettre|proposer|donner|(?:monter|aller|y aller)(?: jusqu)?(?: a)?)|je (?:vous )?propose) )?`;
const MENTION = String.raw`(?:,? (?:max|maximum|dernier prix))?`;
const AFFIRMATION = new RegExp(`^(?:sinon )?${AMORCE}#${MENTION}$`);

// Vrai si la bulle est une proposition complète : « ça vous va ? » peut en être
// retiré sans laisser de fragment. Sert à la mise en forme, jamais à refuser.
export function isProposalStatement(line, offre) {
  if (offre == null) return false;
  const montant = new RegExp(`(?<![\\d.,])${offre}(?![\\d]|[.,]\\d)(?: ?(?:€|euros?(?![a-z])))?`, 'g');
  const masque = normalizeText(String(line).replace(SOURIRES_FINAUX, ''))
    .replace(/-/g, ' ')
    .trim()
    .replace(montant, '#');
  return masque.split('#').length === 2 && !/\d/.test(masque) && AFFIRMATION.test(masque);
}
