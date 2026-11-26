// Derniers messages confirmés envoyés, ou seulement tapés en mode test. Rien
// n'est affiché tant que le journal est vide.
import { urlAnnonceValide } from '../sw/run-state.js';
import { urlContactValide } from '../sw/run-contact.js';
import { commander, conversationValide, formaterHeure } from './dom.js';

const AFFICHES = 3;
const MAXIMUM = 50;

export function monterEnvois(emplacement, { chrome, dom, maintenant = Date.now }) {
  const { el, lien } = dom;
  const titre = el('h2', { id: 'envois-titre' });
  const compte = el('span', { id: 'envois-compte', classe: 'discret' });
  const liste = el('ul', { id: 'envois-liste', classe: 'liste-nue pile' });
  const section = el('section', { id: 'envois', classe: 'carte', 'aria-label': 'Derniers messages envoyés', hidden: true },
    el('div', { classe: 'envois-tete' }, titre, compte), liste);
  emplacement.replaceChildren(section);
  let recu = false;

  const jour = (date) => new Date(date).toDateString();

  function rendre(envois) {
    const valides = (Array.isArray(envois) ? envois : []).filter((e) => e && Number.isFinite(e.date));
    section.hidden = valides.length === 0;
    const essaisSeuls = valides.slice(0, AFFICHES).every((e) => e.simulated !== false);
    titre.textContent = essaisSeuls ? 'Derniers essais (non envoyés)' : 'Derniers messages envoyés';
    const aujourdhui = jour(maintenant());
    const duJour = valides.filter((e) => jour(e.date) === aujourdhui
      && (e.simulated !== false) === essaisSeuls).length;
    // Le journal est borné : au-delà, le compte du jour est un minimum.
    const sature = valides.length >= MAXIMUM && jour(valides.at(-1).date) === aujourdhui;
    compte.textContent = `${duJour}${sature ? '+' : ''} aujourd’hui`;
    liste.replaceChildren(...valides.slice(0, AFFICHES).map((envoi) => {
      const nom = envoi.vendeur || 'Vendeur inconnu';
      const sur = conversationValide(envoi.url) || urlAnnonceValide(envoi.url) || urlContactValide(envoi.url);
      return el('li', { classe: 'envoi' },
        el('span', { classe: 'envoi-texte' },
          lien(envoi.url, nom, sur, { classe: 'fort' }),
          el('span', { texte: envoi.kind === 'premier_contact' ? ' Premier message' : ` « ${envoi.debut ?? ''}${envoi.tronque === true ? '…' : ''} »` }),
          !essaisSeuls && envoi.simulated !== false && el('span', { classe: 'marque ton-ambre', texte: ' Essai, non envoyé' })),
        el('span', { classe: 'discret envoi-heure', texte: jour(envoi.date) === aujourdhui
          ? formaterHeure(envoi.date)
          : new Date(envoi.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) }));
    }));
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'envois-maj') { recu = true; rendre(message.envois); }
  });
  const pret = commander(chrome, { type: 'envois-liste' })
    // Une diffusion reçue pendant la lecture est plus récente qu'elle.
    .then((reponse) => { if (!recu) rendre(reponse.envois); })
    .catch(() => {});
  return { pret };
}
