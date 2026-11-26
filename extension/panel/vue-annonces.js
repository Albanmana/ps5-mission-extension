// Liste des annonces : la shortlist « à contacter » du serveur, et les
// résultats de la dernière recherche avec le sort de chacun.
import { urlContactValide } from '../sw/run-contact.js';
import { urlAnnonceValide } from '../sw/run-state.js';
import { annonceDeRun } from './contact-memoire.js';

export const CLASSIFICATIONS = {
  saint_graal: ['Saint Graal', 'vert'], interessant: ['Intéressante', 'bleu'],
  a_verifier: ['À vérifier', 'ambre'], disqualifiee: ['Écartée', 'gris'],
};
const ETAPES = {
  recue: 'Reçue', en_base: 'Enregistrée en base', classifiee: 'Classée', enrichie: 'Fiche analysée', erreur: 'Erreur',
};

export function suiviAnnonce(annonce) {
  const lignes = [];
  const ajouter = (texte, classe) => lignes.push({ texte: String(texte), classe });
  if (ETAPES[annonce.etat]) ajouter(ETAPES[annonce.etat]);
  if (annonce.deja_analysee && !annonce.analysee) ajouter('Déjà analysée en base');
  if (annonce.contact_envoye) ajouter('Message envoyé');
  if (annonce.contact_simule) {
    ajouter('Simulation : message saisi, non envoyé (onglet de réponse laissé ouvert)');
  } else if (annonce.contact_skip === 'simulation') {
    ajouter('Simulation : contact non tenté (annonce déjà simulée, ou un seul essai par recherche en mode test)');
  } else if (annonce.contact_skip === 'prix_hors_limite') {
    ajouter('Pas de contact : prix inconnu ou au-dessus du prix maximum actuel');
  } else if (annonce.contact_skip) ajouter(`Contact ignoré — ${annonce.contact_skip}`, 'texte-erreur');
  if (annonce.erreur) ajouter(annonce.erreur, 'texte-erreur');
  return lignes;
}

export function monterAnnonces(emplacement, { dom, surOuvrir, surAutre, surCriteres, surRecharger }) {
  const { el, bouton, icone } = dom;
  let filtre = 'contacter';
  let shortlist = { annonces: [], charge: false, etat: '', occupe: false };
  let run = null;

  const puces = [['contacter', 'À contacter'], ['verifier', 'À vérifier'], ['toutes', 'Toutes']].map(([nom, libelle]) => {
    const node = bouton(libelle, { id: `filtre-${nom}`, classe: 'puce', 'aria-pressed': 'false' }, () => {
      filtre = nom;
      rendre();
    });
    return { nom, libelle, node };
  });
  const criteres = bouton('', { id: 'voir-criteres', classe: 'bouton-icone', 'aria-label': 'Critères de recherche' },
    surCriteres);
  criteres.append(icone(['M4 7h10M18 7h2M4 17h4M12 17h8', 'M14 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    'M8 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0'], 20));
  const origine = el('p', { id: 'origine-liste', classe: 'discret' });
  const liste = el('ul', { id: 'annonces-liste', classe: 'liste-nue pile' });
  const etat = el('p', { id: 'shortlist-etat', classe: 'discret', 'aria-live': 'polite' });
  const recharger = bouton('Recharger la shortlist', { id: 'recharger', classe: 'bouton-lien' }, surRecharger);
  const pied = el('div', { classe: 'pied-shortlist' }, etat, recharger);
  emplacement.replaceChildren(
    el('div', { classe: 'barre-filtres' },
      el('div', { classe: 'puces', role: 'group', 'aria-label': 'Filtrer les annonces' }, ...puces.map((p) => p.node)),
      criteres),
    origine, liste, pied,
    bouton('Contacter une autre annonce', { id: 'autre-annonce', classe: 'bouton-lien bouton-large' }, surAutre));

  function ligne(annonce, suivi, ouvrable) {
    const [libelle, couleur] = CLASSIFICATIONS[annonce.classification] ?? [annonce.classification, 'gris'];
    const infos = [libelle, annonce.ville, annonce.vendeur].filter(Boolean).join(' · ');
    const corps = el('span', { classe: 'annonce-corps' },
      el('span', { classe: 'fort', texte: annonce.titre || annonce.url_annonce }),
      el('span', { classe: 'annonce-infos' },
        el('span', { classe: `point point-${couleur}`, 'aria-hidden': 'true' }),
        el('span', { texte: infos || 'Pas encore classée' })),
      ...suivi.map(({ texte, classe }) => el('span', { classe: `annonce-suivi ${classe ?? ''}`.trim(), texte })));
    const prix = el('span', { classe: 'prix', texte: annonce.prix_eur != null ? `${annonce.prix_eur} €` : '' });
    const contenu = ouvrable
      ? bouton('', { classe: 'annonce', 'data-url': annonce.url_annonce }, () => surOuvrir(annonce))
      : el('div', { classe: 'annonce' });
    contenu.append(corps, prix);
    return el('li', {}, contenu);
  }

  function rendre() {
    const resultats = Object.values(run?.annonces ?? {});
    const aVerifier = resultats.filter((a) => a.classification === 'a_verifier');
    const nombres = {
      contacter: shortlist.charge ? shortlist.annonces.length : null,
      verifier: run ? aVerifier.length : null,
      toutes: null,
    };
    for (const { nom, libelle, node } of puces) {
      node.textContent = nombres[nom] === null ? libelle : `${libelle} ${nombres[nom]}`;
      node.setAttribute('aria-pressed', nom === filtre ? 'true' : 'false');
    }
    let lignes;
    if (filtre === 'contacter') {
      lignes = shortlist.annonces.map((annonce) => ligne(annonce, [], true));
      origine.textContent = 'Une annonce par vendeur connu.';
    } else {
      lignes = (filtre === 'verifier' ? aVerifier : resultats).map((annonce) => ligne(
        annonceDeRun(annonce), suiviAnnonce(annonce), urlAnnonceValide(annonce.url_annonce)
          || urlContactValide(annonce.url_annonce)));
      origine.textContent = 'Résultats de la dernière recherche.';
    }
    if (!lignes.length && (filtre !== 'contacter' || shortlist.charge)) {
      lignes = [el('li', { classe: 'vide', texte: {
        contacter: 'Aucun vendeur à contacter dans la shortlist.',
        verifier: 'Aucune annonce à vérifier dans la dernière recherche.',
        toutes: 'Aucune annonce dans la dernière recherche.',
      }[filtre] })];
    }
    liste.replaceChildren(...lignes);
    pied.hidden = filtre !== 'contacter';
    etat.textContent = shortlist.etat;
    recharger.disabled = shortlist.occupe;
  }

  rendre();
  return {
    majShortlist(nouvelle) { shortlist = nouvelle; rendre(); },
    majRun(nouveau) { run = nouveau; rendre(); },
  };
}
