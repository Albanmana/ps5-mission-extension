// Cadre du panneau : en-tête, alertes générales, écrans, message bref et
// navigation du bas.

const TITRES = {
  accueil: 'Accueil', annonces: 'Annonces', fiche: 'Premier message', criteres: 'Ma recherche',
  conversations: 'Conversations', reglages: 'Réglages',
};
const PARENTS = { fiche: 'annonces', criteres: 'annonces', conversations: 'accueil' };
const ONGLETS = [
  ['accueil', 'Accueil', ['M9 11l3 3 8-8', 'M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10']],
  ['annonces', 'Annonces', ['M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0', 'M20 20l-4-4']],
  ['reglages', 'Réglages', ['M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2']],
];
export const MODE_INCONNU = 'Mode inconnu (réglages illisibles) : rien ne doit être envoyé.';

export function monterCoquille(racine, dom) {
  const { el, bouton, icone } = dom;
  let courant = 'accueil';
  const abonnes = [];

  const retour = bouton('', { id: 'retour', classe: 'retour', 'aria-label': 'Retour' },
    () => aller(PARENTS[courant] ?? 'accueil'));
  retour.append(icone(['M15 18l-6-6 6-6']));
  const titre = el('h1', { id: 'titre', tabIndex: -1 });
  const badge = bouton('Mode test : rien ne part', {
    id: 'badge-mode', classe: 'badge-test', hidden: true, 'aria-label': 'Mode test actif, ouvrir les réglages',
  }, () => aller('reglages'));
  const modeInconnu = el('p', {
    id: 'alerte-mode', classe: 'encart encart-erreur', role: 'alert', hidden: true, texte: MODE_INCONNU,
  });
  const entete = el('header', { classe: 'entete' },
    el('div', { classe: 'entete-ligne' }, el('div', { classe: 'entete-titre' }, retour, titre), badge),
    modeInconnu);

  const serveur = el('div', { id: 'alerte-serveur', classe: 'encart encart-serveur', role: 'alert', hidden: true },
    el('strong', { texte: 'Serveur local injoignable' }),
    el('span', { texte: 'Dans le Terminal, dans le dossier du projet, lancez :' }),
    el('code', { texte: 'npm run dev' }));

  const ecrans = Object.fromEntries(Object.entries(TITRES).map(([nom, libelle]) => [nom,
    el('section', { id: `ecran-${nom}`, classe: 'ecran', 'aria-label': libelle })]));

  // La zone annoncée reste en place ; seul son contenu apparaît et disparaît.
  const toastTexte = el('span', { id: 'toast-texte' });
  const toastBoite = el('div', { id: 'toast', classe: 'toast', hidden: true }, toastTexte,
    bouton('OK', { id: 'toast-fermer' }, () => { toastBoite.hidden = true; }));
  const toastZone = el('div', { classe: 'toast-zone', role: 'status' }, toastBoite);

  const boutons = new Map();
  const navigation = el('nav', { classe: 'navigation', 'aria-label': 'Sections' });
  for (const [nom, libelle, traces] of ONGLETS) {
    const texte = el('span', { texte: libelle });
    const node = bouton('', { id: `nav-${nom}` }, () => aller(nom));
    node.append(icone(traces), texte);
    boutons.set(nom, { node, texte, libelle });
    navigation.append(node);
  }

  const bas = el('div', { classe: 'bas' }, toastZone, navigation);
  racine.replaceChildren(entete, serveur, el('main', {}, ...Object.values(ecrans)), bas);

  function afficher() {
    titre.textContent = TITRES[courant];
    retour.hidden = !PARENTS[courant];
    for (const [nom, ecran] of Object.entries(ecrans)) ecran.hidden = nom !== courant;
    const section = PARENTS[courant] ?? courant;
    for (const [nom, { node }] of boutons) {
      if (nom === section) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
  }

  function aller(nom) {
    const change = nom !== courant;
    courant = nom;
    toastBoite.hidden = true;
    afficher();
    if (change) titre.focus?.();
    for (const abonne of abonnes) abonne(nom);
  }

  afficher();
  return {
    ecrans,
    aller,
    vue: () => courant,
    surNavigation: (abonne) => abonnes.push(abonne),
    toast(texte) { toastTexte.textContent = texte; toastBoite.hidden = false; },
    majMode(mode) {
      badge.hidden = mode !== 'simulation';
      modeInconnu.hidden = mode !== 'inconnu';
    },
    majServeur(ok) { serveur.hidden = ok; },
    majCompteur(nombre) {
      const { texte, libelle } = boutons.get('accueil');
      texte.textContent = nombre > 0 ? `${libelle} (${nombre})` : libelle;
    },
  };
}
