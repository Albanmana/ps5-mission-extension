// Mémoire anti double envoi du panneau : les résultats définitifs ou incertains
// restent connus tant que le panneau est ouvert, par annonce et par vendeur.
// Le serveur reste le garde-fou principal.
import { urlContactValide } from '../sw/run-contact.js';

export const cleUrl = (url) => (urlContactValide(url) ? new URL(url).pathname : url);

function cles(annonce) {
  return [
    `url:${cleUrl(annonce.url_annonce)}`,
    ...(typeof annonce.vendeur === 'string' && annonce.vendeur.trim()
      ? [`vendeur:${annonce.vendeur.trim().toLowerCase()}`] : []),
  ];
}

const ENVOI_PAR_LA_RECHERCHE = 'La recherche a déjà envoyé (ou peut-être envoyé) un message à ce vendeur. '
  + 'Vérifiez la conversation avant tout nouvel envoi.';

// Une annonce d'un run, ramenée à la forme d'une ligne de shortlist.
export function annonceDeRun(annonce) {
  const donnee = (cle) => annonce.detail_donnees?.[cle] ?? annonce.donnees?.[cle] ?? annonce[cle] ?? null;
  return {
    url_annonce: annonce.url_annonce,
    titre: donnee('titre'),
    prix_eur: annonce.detail_donnees?.prix_eur ?? annonce.prix_eur ?? null,
    vendeur: donnee('vendeur'),
    ville: donnee('ville'),
    classification: annonce.classification ?? null,
  };
}

export function creerMemoire() {
  const preparations = new Map();
  const liberees = new Set();
  let envoyeesParRun = new Set();
  let run = null;

  return {
    preparation(annonce) {
      if (!annonce) return undefined;
      const connues = cles(annonce);
      const memorisee = connues.map((cle) => preparations.get(cle)).find(Boolean);
      if (memorisee) return memorisee;
      if (connues.some((cle) => envoyeesParRun.has(cle)) && !connues.some((cle) => liberees.has(cle))) {
        return { message: ENVOI_PAR_LA_RECHERCHE, masquer: false };
      }
      return undefined;
    },
    memoriser(annonce, message, masquer = false) {
      for (const cle of cles(annonce)) preparations.set(cle, { message, masquer });
    },
    // L'utilisateur a confirmé que rien n'était parti.
    oublier(annonce) {
      for (const cle of cles(annonce)) { preparations.delete(cle); liberees.add(cle); }
    },
    majRun(etat) {
      if (etat?.id !== run) liberees.clear();
      run = etat?.id;
      envoyeesParRun = new Set(Object.values(etat?.annonces ?? {})
        .filter((annonce) => annonce.contact_envoye || annonce.contact_skip === 'envoi_incertain')
        .flatMap((annonce) => cles(annonceDeRun(annonce))));
    },
  };
}
