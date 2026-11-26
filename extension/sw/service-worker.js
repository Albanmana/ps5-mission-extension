import { api as apiParDefaut, createApi } from './api.js';
import { loadSettings } from '../lib/settings.js';
import { createLogger, createNullLogger } from '../lib/log.js';
import { createRecherche } from './run-recherche.js';
import { createContact } from './run-contact.js';
import { createConversationPoller } from './conversation-poller.js';
import { createSentLog } from './sent-log.js';
import { CONVERSATION_ALARM } from './conversation-state.js';
import { createSearchAutopilot } from './search-autopilot.js';
import { SEARCH_AUTOPILOT_ALARM } from './search-autopilot-state.js';

export function installerServiceWorker({
  chrome,
  api = apiParDefaut,
  logger = createNullLogger(),
  conversationPoller,
  searchAutopilot,
}) {
  let navigateurDisponible = Promise.resolve();
  const avecNavigateurExclusif = (operation) => {
    const execution = navigateurDisponible.then(operation, operation);
    navigateurDisponible = execution.catch(() => {});
    return execution;
  };
  const journalEnvois = createSentLog({ chrome, logger });
  const contactBrut = createContact({ chrome, api, logger, journalEnvois });
  const contact = {
    envoyerContact: (...args) => avecNavigateurExclusif(() => contactBrut.envoyerContact(...args)),
  };
  const run = createRecherche({ chrome, api, contact });
  const poller = conversationPoller ?? createConversationPoller({ chrome, api, logger, journalEnvois });
  const rechercheAuto = searchAutopilot ?? createSearchAutopilot({ chrome, run, logger });

  const initialisation = Promise.resolve().then(() => poller.initialize()).catch((error) => {
    logger.logErreur('conversations:initialisation_echec', error);
    throw error;
  });
  const initialisationRecherche = Promise.resolve().then(() => rechercheAuto.initialiser()).catch((error) => {
    logger.logErreur('recherche-auto:initialisation_echec', error);
    throw error;
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === SEARCH_AUTOPILOT_ALARM) {
      initialisationRecherche.then(() => rechercheAuto.onAlarm(alarm)).catch((error) => {
        logger.logErreur('recherche-auto:alarme_echec', error, { nom: alarm?.name });
      });
    } else if (alarm?.name === CONVERSATION_ALARM) {
      initialisation.then(() => avecNavigateurExclusif(() => poller.onAlarm(alarm))).catch((error) => {
        logger.logErreur('conversations:alarme_echec', error, { nom: alarm?.name });
      });
    }
  });

  chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message?.type;
    // `sender.tab` distingue une page injectée d'une commande du panneau.
    logger.log('message:recu', { type, depuis: sender?.tab ? 'page' : 'panneau' });
    const repondre = (operation) => {
      const debut = Date.now();
      Promise.resolve().then(operation).then(
        (resultat) => {
          logger.log('message:repondu', { type, duree_ms: Date.now() - debut });
          sendResponse(resultat);
        },
        (error) => {
          logger.logErreur('message:echec', error, { type, duree_ms: Date.now() - debut });
          sendResponse({ ok: false, error: error.message });
        },
      );
      return true;
    };
    if (['annonces-page', 'leboncoin-bloque', 'extraction-erreur', 'extraction-terminee'].includes(message?.type)) {
      return repondre(async () => { await run.recevoirMessage(message, sender); return { ok: true }; });
    }
    // Les commandes du panneau ne sont pas une interface pour les pages injectées.
    if (sender.tab) return false;
    switch (message?.type) {
      case 'ping-serveur': return repondre(async () => ({ ok: await api.ping() }));
      case 'contact-shortlist': return repondre(async () => {
        const { maxPrice } = await loadSettings(chrome);
        return { ok: true, annonces: (await api.shortlist({ limite: 50, prixMax: maxPrice })).annonces };
      });
      case 'contact-envoyer': return repondre(() => contact.envoyerContact(
        message.urlAnnonce, message.texte, { vendeur: message.vendeur }));
      case 'envois-liste': return repondre(async () => ({ ok: true, envois: await journalEnvois.list() }));
      case 'contact-reservations': return repondre(async () => ({
        ok: true, reservations: (await api.reservationsBloquees()).reservations,
      }));
      case 'contact-reservation-resoudre': return repondre(async () => ({
        ok: true, resolue: (await api.resoudreReservation(message.urlAnnonce, message.resultat)).resolue,
      }));
      case 'run-etat': return repondre(async () => ({ etat: await run.lireEtat() }));
      case 'run-demarrer': return repondre(async () => {
        await initialisationRecherche;
        return { ok: true, etat: (await rechercheAuto.demarrerManuellement(message.options)).etat };
      });
      case 'run-pause': return repondre(async () => {
        await run.pause();
        await initialisationRecherche;
        await rechercheAuto.planifierApresPause();
        return { ok: true };
      });
      case 'run-reprendre': return repondre(async () => {
        await run.reprendre();
        await initialisationRecherche;
        await rechercheAuto.relancerApresDecision();
        return { ok: true };
      });
      case 'run-arreter': return repondre(async () => {
        await run.arreter({ utilisateur: true });
        await initialisationRecherche;
        await rechercheAuto.relancerApresDecision();
        return { ok: true };
      });
      case 'recherche-auto-etat': return repondre(async () => {
        await initialisationRecherche;
        return { etat: await rechercheAuto.lireEtat() };
      });
      case 'recherche-auto-activer': return repondre(async () => {
        await initialisationRecherche;
        return { etat: await rechercheAuto.activer(message.enabled !== false, message.options) };
      });
      case 'recherche-auto-configurer': return repondre(async () => {
        await initialisationRecherche;
        return { etat: await rechercheAuto.configurer(message.options) };
      });
      case 'conversations-etat': return repondre(async () => { await initialisation; return { etat: await poller.state() }; });
      case 'conversations-activer': return repondre(async () => { await initialisation; return { etat: await poller.enable(message.enabled !== false) }; });
      case 'conversations-pause': return repondre(async () => { await initialisation; return { etat: await poller.pause() }; });
      case 'conversations-reprendre': return repondre(async () => { await initialisation; return { etat: await poller.resume() }; });
      case 'conversations-acquitter': return repondre(async () => { await initialisation; return { etat: await poller.acknowledge() }; });
      case 'conversations-verifier': return repondre(async () => {
        await initialisation;
        return { etat: await avecNavigateurExclusif(() => poller.runNow({ manual: true })) };
      });
      case 'conversations-handoff-traite': return repondre(async () => {
        await initialisation;
        return { etat: await poller.dismissHandoff(message.fingerprint) };
      });
      case 'conversations-echec-traite': return repondre(async () => {
        await initialisation;
        return { etat: await poller.dismissFailure(message.url_conversation) };
      });
      case 'conversations-liste': return repondre(async () => { await initialisation; return api.conversations(); });
      default: return false;
    }
  });
}

// Câblage de production : c'est le seul endroit où la journalisation est
// réellement active. Les tests injectent ce qu'ils veulent et restent muets.
if (globalThis.chrome) {
  const journal = createLogger({ scope: 'sw' });
  installerServiceWorker({
    chrome: globalThis.chrome,
    api: createApi({ logger: journal }),
    logger: journal,
  });
}
