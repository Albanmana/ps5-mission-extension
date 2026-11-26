// Substitution des variables d'un template de premier contact. Pur : aucun
// accès au DOM ni à chrome.*, pour rester testable sous Node.

export const VARIABLES = ['vendeur', 'titre', 'prix', 'ville'];
export const MESSAGE_CONTACT_PAR_DEFAUT = 'Bonjour vous allez bien ? Est-ce que la PS5 est toujours disponible svp?';

const ACCESSEURS = {
  vendeur: (annonce) => annonce.vendeur,
  titre: (annonce) => annonce.titre,
  prix: (annonce) => (annonce.prix_eur != null ? String(annonce.prix_eur) : null),
  ville: (annonce) => annonce.ville,
};

export const TEMPLATES_PAR_DEFAUT = [
  {
    id: 'dispo',
    nom: 'Disponibilité',
    texte: MESSAGE_CONTACT_PAR_DEFAUT,
  },
  {
    id: 'dispo-nom',
    nom: 'Disponibilité avec prénom',
    texte: 'Bonjour {{vendeur}}, est-ce que la PS5 est toujours disponible ?',
  },
];

export function resoudreTemplate(texte, annonce) {
  const manquantes = [];
  const manquantesVues = new Set();
  const signalerManquante = (nom) => {
    if (!manquantesVues.has(nom)) {
      manquantesVues.add(nom);
      manquantes.push(nom);
    }
  };

  const resolu = texte.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (motif, nom) => {
    const accesseur = ACCESSEURS[nom];
    if (!accesseur) {
      // Variable inconnue : on la laisse visible dans le texte plutôt que
      // de la faire disparaître silencieusement du message envoyé.
      signalerManquante(nom);
      return motif;
    }

    const valeur = accesseur(annonce);
    if (valeur == null || valeur === '') {
      signalerManquante(nom);
      return '';
    }
    return String(valeur);
  });

  return { texte: resolu, manquantes };
}
