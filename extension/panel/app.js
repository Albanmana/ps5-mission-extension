// Assemble le panneau latéral et relie les modules entre eux.
import { creerDom, envoyer } from './dom.js';
import { monterCoquille } from './coquille.js';
import { monterAccueil } from './vue-accueil.js';
import { monterRecherche } from './vue-recherche.js';
import { monterAnnonces } from './vue-annonces.js';
import { monterContact } from './vue-contact.js';
import { annonceDeRun } from './contact-memoire.js';
import { monterConversations } from './vue-conversations.js';
import { monterReservations } from './vue-reservations.js';
import { monterEnvois } from './vue-envois.js';
import { monterReglages, suivreMode } from './vue-reglages.js';

export function monterPanneau(racine, { chrome = globalThis.chrome, maintenant = Date.now } = {}) {
  const dom = creerDom(racine.ownerDocument);
  const coquille = monterCoquille(racine, dom);
  const { ecrans } = coquille;
  const accueil = monterAccueil(ecrans.accueil, dom, { surConversations: () => coquille.aller('conversations') });
  const { emplacements } = accueil;
  const compter = (changement) => coquille.majCompteur(accueil.majCompte(changement));
  const toast = (texte) => coquille.toast(texte);

  const emplacementRun = dom.el('div', { classe: 'pile' });
  const emplacementListe = dom.el('div', { classe: 'pile' });
  ecrans.annonces.replaceChildren(emplacementRun, emplacementListe);

  let contact;
  const annonces = monterAnnonces(emplacementListe, {
    dom,
    surOuvrir: (annonce) => contact.ouvrir(annonce),
    surAutre: () => contact.ouvrirAutre(),
    surCriteres: () => coquille.aller('criteres'),
    surRecharger: () => contact.chargerShortlist(),
  });
  contact = monterContact(ecrans.fiche, {
    chrome, dom, toast,
    surShortlist: (etat) => annonces.majShortlist(etat),
    surOuverture: () => {
      // `aller` efface le message bref : le garder quand on est déjà sur la fiche.
      if (coquille.vue() !== 'fiche') coquille.aller('fiche');
    },
    surEnvoye: (surLaFiche) => {
      if (surLaFiche) coquille.aller('annonces');
      toast('Message envoyé. Le suivi de ce vendeur est enregistré.');
    },
  });

  const recherche = monterRecherche({
    pilote: emplacements.recherche, contact: emplacements.contact, run: emplacementRun, criteres: ecrans.criteres,
  }, {
    chrome, dom,
    surRun: (run) => {
      annonces.majRun(run);
      contact.majRun(run, Object.values(run?.annonces ?? {}).map(annonceDeRun));
      accueil.maj({ run });
    },
    surAuto: (auto) => accueil.maj({ auto }),
  });
  const conversations = monterConversations({
    reponse: emplacements.reponse, suivi: emplacements.suivi, cartes: emplacements.cartes,
    verifier: emplacements.verifier, ecran: ecrans.conversations,
  }, {
    chrome, dom, toast,
    surEtat: (etat) => accueil.maj({ conversations: etat }),
    surCartes: (reprises) => compter({ reprises }),
  });
  const reservations = monterReservations({
    cartes: emplacements.reservations, pied: emplacements.reservationsPied,
  }, {
    chrome, dom, toast,
    surNombre: (verifications) => compter({ verifications }),
    surLiberee: (reservation) => contact.oublier(reservation),
    apresResolution: () => contact.chargerShortlist(),
  });
  const envois = monterEnvois(emplacements.envois, { chrome, dom, maintenant });
  const reglages = monterReglages(ecrans.reglages, { chrome, dom });

  coquille.surNavigation((vue) => {
    contact.majVisible(vue === 'fiche');
    if (vue !== 'reglages') reglages.abandonnerConfirmation();
    if (vue === 'annonces') void contact.chargerShortlist();
    if (vue === 'conversations') void conversations.chargerListe();
    // Ne pas refermer une vérification en cours de réponse.
    if (vue === 'accueil' && !reservations.enConsultation()) void reservations.charger();
  });

  const mode = suivreMode(chrome, (valeur) => {
    coquille.majMode(valeur);
    contact.majMode(valeur);
    recherche.majMode(valeur);
    conversations.majMode(valeur);
    accueil.maj({ mode: valeur });
  });
  accueil.maj({});

  const serveur = envoyer(chrome, { type: 'ping-serveur' }).catch(() => null).then((reponse) => {
    const ok = reponse?.ok === true;
    coquille.majServeur(ok);
    const etat = ecrans.reglages.querySelector('#etat-serveur');
    etat.textContent = ok ? 'Serveur local connecté.' : 'Serveur local injoignable — lancez `npm run dev`.';
  });

  return {
    coquille,
    pret: Promise.all([mode, serveur, recherche.pret, contact.pret, conversations.pret, reservations.pret,
      envois.pret, reglages.pret]),
  };
}
