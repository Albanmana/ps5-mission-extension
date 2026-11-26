// Envois à vérifier : réservations bloquées. Une réponse n'est enregistrée
// qu'après confirmation, car répondre au hasard risque un double message.
import { urlContactValide } from '../sw/run-contact.js';
import { envoyer } from './dom.js';

const MESSAGERIE = 'https://www.leboncoin.fr/messages';

export function monterReservations({ cartes, pied }, {
  chrome, dom, surNombre = () => {}, surLiberee = () => {}, apresResolution = async () => {}, toast = () => {},
}) {
  const { el, bouton, lien } = dom;
  const liste = el('ul', { id: 'reservations', classe: 'liste-nue pile' });
  const etat = el('span', { id: 'reservations-etat', 'aria-live': 'polite' });
  const actualiser = bouton('Actualiser les envois à vérifier', { id: 'reservations-recharger', classe: 'bouton-lien' },
    () => charger());
  cartes.replaceChildren(liste);
  pied.replaceChildren(el('div', { classe: 'pied-reservations discret' }, etat, actualiser));
  let ouvertes = 0;

  function carte(reservation) {
    const nom = reservation.vendeur || 'Vendeur inconnu';
    const actions = el('div', { classe: 'pile' });
    const reponses = () => actions.replaceChildren(el('div', { classe: 'rangee' },
      bouton('Oui, il est parti', { classe: 'bouton-blanc' }, () => confirmer('envoye',
        `Confirmer : le message a bien été envoyé ? ${nom} sera marqué comme contacté.`)),
      bouton('Non', { classe: 'bouton-blanc' }, () => confirmer('non_envoye',
        `Confirmer : rien n’a été envoyé ? ${nom} pourra être contacté à nouveau.`))));
    const confirmer = (resultat, question) => actions.replaceChildren(el('div', { classe: 'pile', role: 'alert' },
      el('strong', { texte: question }),
      el('div', { classe: 'rangee' },
        bouton('Confirmer', { classe: 'bouton-sombre' }, () => resoudre(reservation, resultat, actions)),
        bouton('Annuler', { classe: 'bouton-blanc' }, reponses))));
    reponses();
    const corps = el('div', { classe: 'pile verification-corps', hidden: true },
      el('p', {},
        el('span', { texte: 'L’envoi n’a pas été confirmé (réservation bloquée depuis plus de 10 minutes). ' }),
        lien(MESSAGERIE, 'Regardez la messagerie', true),
        el('span', { texte: ', puis répondez.' })),
      el('p', { texte: `${reservation.titre || 'Annonce'} · réservé le ${new Date(reservation.reservation_le).toLocaleString('fr-FR')}` }),
      lien(reservation.url_annonce, reservation.url_annonce, urlContactValide(reservation.url_annonce), { classe: 'lien-fiche' }),
      actions);
    const indication = el('span', { classe: 'verification-lien', texte: 'Vérifier' });
    const tete = bouton('', { classe: 'verification-tete', 'aria-expanded': 'false' }, () => {
      corps.hidden = !corps.hidden;
      ouvertes += corps.hidden ? -1 : 1;
      tete.setAttribute('aria-expanded', corps.hidden ? 'false' : 'true');
      indication.textContent = corps.hidden ? 'Vérifier' : 'Fermer';
      reponses();
    });
    tete.append(el('span', {}, el('strong', { texte: nom }), el('span', { texte: ' : message parti ?' })), indication);
    return el('li', { classe: 'carte carte-verification' }, tete, corps);
  }

  async function resoudre(reservation, resultat, actions) {
    actions.replaceChildren(el('p', { texte: 'Enregistrement…' }));
    let retour;
    try {
      const reponse = await envoyer(chrome, {
        type: 'contact-reservation-resoudre', urlAnnonce: reservation.url_annonce, resultat,
      });
      if (!reponse.ok) throw new Error(reponse.error || 'Résolution impossible.');
      if (reponse.resolue === true) {
        retour = 'Réservation résolue.';
        if (resultat === 'non_envoye') surLiberee(reservation);
        toast(`Réponse enregistrée pour ${reservation.vendeur || 'ce vendeur'}`);
      } else retour = 'La réservation n’a pas été résolue (déjà traitée ou trop récente).';
    } catch (error) { retour = error.message; }
    if (await charger()) etat.textContent = retour;
    await apresResolution();
  }

  async function charger() {
    etat.textContent = 'Chargement…';
    try {
      const reponse = await envoyer(chrome, { type: 'contact-reservations' });
      if (!reponse.ok || !Array.isArray(reponse.reservations)) {
        throw new Error(reponse.error || 'Liste des réservations invalide.');
      }
      ouvertes = 0;
      liste.replaceChildren(...reponse.reservations.map(carte));
      etat.textContent = reponse.reservations.length ? '' : 'Aucun envoi à vérifier.';
      surNombre(reponse.reservations.length);
      return true;
    } catch (error) {
      ouvertes = 0;
      liste.replaceChildren();
      etat.textContent = `Envois à vérifier illisibles : ${error.message}`;
      surNombre(null);
      return false;
    }
  }

  return { pret: charger(), charger, enConsultation: () => ouvertes > 0 };
}
