// Briques communes du panneau. Aucune donnée externe ne devient du HTML : tout
// passe par textContent, et seuls des liens leboncoin vérifiés sont cliquables.

const URL_CONVERSATION = /^https:\/\/www\.leboncoin\.fr\/messages\/id\/[0-9a-f-]{16,}(?:[?#].*)?$/i;

export const conversationValide = (url) => URL_CONVERSATION.test(url || '');

export function creerDom(document) {
  // `texte`, `classe` et les attributs à tiret (ou role) ; le reste en propriétés.
  const el = (tag, props = {}, ...enfants) => {
    const node = document.createElement(tag);
    for (const [cle, valeur] of Object.entries(props)) {
      if (valeur === undefined) continue;
      if (cle === 'texte') node.textContent = valeur;
      else if (cle === 'classe') node.className = valeur;
      else if (cle === 'role' || cle.includes('-')) node.setAttribute(cle, String(valeur));
      else node[cle] = valeur;
    }
    const utiles = enfants.filter(Boolean);
    if (utiles.length) node.append(...utiles);
    return node;
  };

  const bouton = (texte, props = {}, action) => {
    const node = el('button', { texte, ...props });
    node.type = props.type ?? 'button';
    if (action) node.addEventListener('click', action);
    return node;
  };

  // Rend un simple texte quand la destination n'est pas sûre.
  const lien = (url, texte, valide, props = {}) => (valide
    ? el('a', { texte, href: url, target: '_blank', rel: 'noopener noreferrer', ...props })
    : el('span', { texte, classe: props.classe }));

  const icone = (traces, taille = 22) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [nom, valeur] of Object.entries({
      width: taille, height: taille, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    })) svg.setAttribute(nom, String(valeur));
    for (const d of traces) {
      const trace = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      trace.setAttribute('d', d);
      svg.append(trace);
    }
    return svg;
  };

  const interrupteur = (id, nom, action) => {
    const node = bouton('', { id, classe: 'interrupteur', role: 'switch', 'aria-label': nom, 'aria-checked': 'false' }, action);
    node.append(el('span', { classe: 'piste', 'aria-hidden': 'true' }));
    return node;
  };

  // Ligne du pilote : titre, état en dessous, interrupteur à droite.
  const ligneReglage = (titre, controle, ...sousTitres) => el('div', { classe: 'ligne-reglage' },
    el('div', { classe: 'ligne-reglage-texte' }, el('div', { classe: 'fort', texte: titre }), ...sousTitres),
    controle);

  return { el, bouton, lien, icone, interrupteur, ligneReglage };
}

export const allume = (node) => node.getAttribute('aria-checked') === 'true';
export const cocher = (node, oui) => node.setAttribute('aria-checked', oui ? 'true' : 'false');

export function envoyer(chrome, message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (reponse) => {
      const erreur = chrome.runtime.lastError;
      if (erreur) reject(new Error(erreur.message));
      else if (!reponse) reject(new Error('Aucune réponse du service worker.'));
      else resolve(reponse);
    });
  });
}

export async function commander(chrome, message) {
  const reponse = await envoyer(chrome, message);
  if (reponse.ok === false) throw new Error(reponse.error || 'Commande impossible.');
  return reponse;
}

export function formaterDate(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return '';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
    .format(new Date(Number(timestamp)));
}

export const formaterHeure = (timestamp) => new Date(Number(timestamp))
  .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

// Une échéance d'un autre jour garde sa date.
export const formaterEcheance = (timestamp, maintenant = Date.now()) => (
  new Date(Number(timestamp)).toDateString() === new Date(maintenant).toDateString()
    ? formaterHeure(timestamp) : formaterDate(timestamp));
