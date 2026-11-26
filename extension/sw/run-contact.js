import { urlAnnonceValide } from './run-state.js';
import { loadSettings } from '../lib/settings.js';
import { consigner } from './sent-log.js';

const ORIGIN = 'https://www.leboncoin.fr';
const RESERVATION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLE_ONGLET_SIMULATION = 'ps5_onglet_simulation';
const sleepReel = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const journalMuet = { log() {}, logErreur() {} };

export function urlContactValide(url) {
  return typeof url === 'string'
    && /^https:\/\/www\.leboncoin\.fr\/ad\/[^/?#\\\s]+\/\d+(?:[?#]\S*)?$/.test(url)
    && urlAnnonceValide(url);
}

export function urlReplyPourAnnonce(url) {
  if (!urlContactValide(url)) return null;
  const match = new URL(url).pathname.match(/^\/ad\/[^/]+\/(\d+)$/);
  return match ? `${ORIGIN}/reply/${match[1]}` : null;
}

function estReplyAttendue(url, listId) {
  try {
    const parsed = new URL(url);
    return parsed.origin === ORIGIN && parsed.pathname === `/reply/${listId}`;
  } catch {
    return false;
  }
}

function estSuccesAttendu(url, listId) {
  try {
    const parsed = new URL(url);
    return parsed.origin === ORIGIN
      && parsed.pathname === '/reply/success/conversations'
      && parsed.searchParams.get('adId') === listId;
  } catch {
    return false;
  }
}

function redirectionConnexion(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === ORIGIN
      && (/connexion|login/i.test(parsed.pathname) || parsed.searchParams.get('error') === 'login_required');
  } catch {
    return false;
  }
}

class Annulation extends Error {}
// Le texte « leboncoin … restreint » est ce que le run reconnaît comme blocage.
class Blocage extends Error {
  constructor() { super('leboncoin a restreint l’accès pendant le contact : rien n’a été envoyé.'); }
}

function hoteAntiRobot(url) {
  try { return /(^|\.)(captcha-delivery\.com|datadome\.co)$/.test(new URL(url).hostname); }
  catch { return false; }
}

// Injectée : doit rester autonome. innerText ignore le code des scripts.
function sonderAntiRobot() {
  if (document.querySelector('iframe[src*="captcha-delivery.com"]')) return { antiRobot: true };
  const texte = `${document.title ?? ''} ${document.body?.innerText ?? document.body?.textContent ?? ''}`;
  return {
    antiRobot: /accès temporairement restreint/i.test(texte)
      || (!document.querySelector('textarea#body')
        && /datadome|device check|please enable js and disable any ad blocker/i.test(texte)),
  };
}

export function createContact({
  chrome,
  api,
  timeoutMs = 30000,
  pollIntervalMs = 250,
  sleep = sleepReel,
  logger = journalMuet,
  journalEnvois,
}) {
  let enCours = false;

  async function formulaireDisponible(tabId) {
    const resultats = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => Boolean(document.querySelector('textarea#body')),
    });
    return resultats?.[0]?.result === true;
  }

  function verifierAnnulation(signal) {
    if (signal?.aborted) throw new Annulation();
  }

  async function attendreFormulaire(tabId, listId, signal) {
    const expiration = Date.now() + timeoutMs;
    let courant;
    let sondeReussie = false;
    let derniereErreurSonde;
    for (;;) {
      verifierAnnulation(signal);
      courant = await chrome.tabs.get(tabId);
      if (courant?.url && !estReplyAttendue(courant.url, listId)) {
        return { courant, formulaire: false };
      }
      if (estReplyAttendue(courant?.url, listId)) {
        try {
          const formulaire = await formulaireDisponible(tabId);
          sondeReussie = true;
          derniereErreurSonde = undefined;
          if (formulaire) return { courant, formulaire: true };
        } catch (error) {
          derniereErreurSonde = error;
          logger.logErreur('contact:sonde_echec', error, { tabId, listId });
        }
      }
      const restant = expiration - Date.now();
      if (restant <= 0) {
        if (courant?.status === 'complete' && estReplyAttendue(courant?.url, listId) && sondeReussie) {
          return { courant, formulaire: false };
        }
        if (derniereErreurSonde) throw derniereErreurSonde;
        throw new Error('Chargement de la page de réponse expiré.');
      }
      await sleep(Math.min(pollIntervalMs, restant));
    }
  }

  async function pageAntiRobot(tabId) {
    try {
      if (hoteAntiRobot((await chrome.tabs.get(tabId))?.url)) return true;
      const resultats = await chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: sonderAntiRobot,
      });
      return resultats?.[0]?.result?.antiRobot === true;
    } catch {
      return false;
    }
  }

  function observerConfirmation(tabId, listId) {
    let termine = false;
    let resultat;
    let timer = null;
    let resolveOutcome;
    const promise = new Promise((resolve) => { resolveOutcome = resolve; });
    const finir = (outcome) => {
      if (termine) return;
      termine = true;
      resultat = outcome;
      if (timer !== null) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(surMaj);
      chrome.tabs.onRemoved.removeListener(surFermeture);
      resolveOutcome(outcome);
    };
    const verifier = (url) => {
      if (!url) return;
      if (estSuccesAttendu(url, listId)) finir({ ok: true, url });
      else {
        try {
          const parsed = new URL(url);
          if (parsed.origin !== ORIGIN || parsed.pathname !== `/reply/${listId}`) {
            finir({ ok: false, raison: 'redirection', url });
          }
        } catch {
          finir({ ok: false, raison: 'redirection', url });
        }
      }
    };
    const surMaj = (id, info, tab) => {
      if (id === tabId) verifier(info.url ?? tab?.url);
    };
    const surFermeture = (id) => {
      if (id === tabId) finir({ ok: false, raison: 'onglet_ferme' });
    };
    chrome.tabs.onUpdated.addListener(surMaj);
    chrome.tabs.onRemoved.addListener(surFermeture);
    return {
      promise,
      verifier,
      resultat: () => resultat,
      demarrerExpiration() {
        if (!termine && timer === null) {
          timer = setTimeout(() => finir({ ok: false, raison: 'expiration' }), timeoutMs);
        }
      },
      annuler() { finir({ ok: false, raison: 'annule' }); },
    };
  }

  async function fermer(tabId) {
    try { await chrome.tabs.remove(tabId); } catch { /* Déjà fermé par l’utilisateur. */ }
  }

  async function finaliserConfirme(urlAnnonce, tabId, token, envoi) {
    // Confirmé par leboncoin : consigné même si le suivi échoue ensuite.
    consigner(journalEnvois, { ...envoi, simulated: false });
    try {
      const suivi = await api.finaliserContact(urlAnnonce, token, 'confirme');
      if (typeof suivi?.contacte_le !== 'string' || !Number.isFinite(Date.parse(suivi.contacte_le))) {
        throw new Error('Confirmation du marquage absente.');
      }
    } catch (error) {
      return { ok: false, envoye: true, suivi: false, tabId,
        error: `Message envoyé, mais le suivi a échoué : ${error.message} Ne renvoie pas ce message.` };
    }
    await fermer(tabId);
    return { ok: true, envoye: true, suivi: true, tabId };
  }

  async function marquerTerminal(urlAnnonce, erreurCode, tabId, token, { garderOnglet = false } = {}) {
    const error = erreurCode === 'envoi_incertain'
      ? 'L’envoi a pu avoir lieu, mais Leboncoin ne l’a pas confirmé. Ne réessaie pas automatiquement.'
      : 'Cette annonce ne permet pas l’envoi d’un message.';
    try {
      const suivi = erreurCode === 'envoi_incertain'
        ? await api.finaliserContact(urlAnnonce, token, 'incertain')
        : await api.marquerErreurContact(urlAnnonce, erreurCode, token);
      if (suivi?.contact_erreur_code !== erreurCode
        || typeof suivi?.contact_erreur_le !== 'string'
        || !Number.isFinite(Date.parse(suivi.contact_erreur_le))) {
        throw new Error('Confirmation du marquage absente.');
      }
      if (!garderOnglet) await fermer(tabId);
      return { ok: false, envoye: false, skip: true, suivi: true, erreurCode, tabId, error };
    } catch (cause) {
      if (!garderOnglet) await fermer(tabId);
      return { ok: false, envoye: false, skip: false, suivi: false, terminal: true,
        erreurCode, tabId, error: `${error} Le suivi en base a échoué : ${cause.message}` };
    }
  }

  async function incertain(urlAnnonce, tabId, token) {
    const bloque = await pageAntiRobot(tabId);
    const resultat = await marquerTerminal(urlAnnonce, 'envoi_incertain', tabId, token, { garderOnglet: true });
    return bloque ? { ...resultat, bloque: true } : resultat;
  }

  // Un seul onglet de simulation à la fois. Le précédent n'est fermé que s'il
  // affiche toujours sa page de réponse : sinon l'utilisateur s'en sert.
  async function remplacerOngletSimulation(tabId, listId) {
    try {
      const ancien = (await chrome.storage.local.get(CLE_ONGLET_SIMULATION))[CLE_ONGLET_SIMULATION];
      if (ancien && ancien.tabId !== tabId
        && estReplyAttendue((await chrome.tabs.get(ancien.tabId).catch(() => null))?.url, ancien.listId)) {
        await fermer(ancien.tabId);
      }
      await chrome.storage.local.set({ [CLE_ONGLET_SIMULATION]: { tabId, listId } });
    } catch (error) {
      logger.logErreur('contact:onglet_simulation_echec', error, { tabId, listId });
    }
  }

  // Mode test : la réservation est rendue et rien n'est enregistré.
  async function terminerSimulation(urlAnnonce, tabId, token, { erreurCode } = {}) {
    const listId = urlReplyPourAnnonce(urlAnnonce).split('/').at(-1);
    if (erreurCode) await fermer(tabId);
    else await remplacerOngletSimulation(tabId, listId);
    const base = { envoye: false, dryRun: true, tabId,
      ...(erreurCode ? { skip: true, erreurCode } : {}) };
    try {
      await api.libererContact(urlAnnonce, token);
    } catch (cause) {
      return { ok: false, ...base,
        error: `Simulation sans envoi, mais la réservation est conservée car sa libération a échoué : ${cause.message}` };
    }
    return erreurCode
      ? { ok: false, ...base, error: 'Cette annonce ne permet pas l’envoi d’un message.' }
      : { ok: true, ...base };
  }

  return {
    // `vendeur` ne sert qu'au journal des envois affiché par le panneau.
    async envoyerContact(urlAnnonce, texte, { signal, vendeur = null } = {}) {
      const urlReply = urlReplyPourAnnonce(urlAnnonce);
      if (!urlReply) throw new Error('URL d’annonce leboncoin HTTPS invalide.');
      if (typeof texte !== 'string' || !texte.trim()) throw new Error('Le message doit être un texte non vide.');
      if (enCours) throw new Error('Un envoi est déjà en cours.');
      enCours = true;
      let tabId;
      let envoiDeclenche = false;
      let reservationToken;
      let confirmation;
      let surAnnulation;
      const envoi = { kind: 'premier_contact', vendeur, message: texte, url: urlAnnonce };
      const annulee = { ok: false, envoye: false, annule: true,
        error: 'Envoi annulé : rien n’a été envoyé.' };
      try {
        if (signal?.aborted) return annulee;
        // Réglages illisibles : l'exception interrompt avant toute action.
        let simulation = (await loadSettings(chrome)).dryRun;
        verifierAnnulation(signal);
        const reservation = await api.reserverContact(urlAnnonce);
        if (reservation?.reservee === false) {
          return { ok: false, envoye: false, skip: true, dedoublonne: true, raison: reservation.raison };
        }
        if (reservation?.reservee !== true
          || typeof reservation.reservation_token !== 'string'
          || !RESERVATION_TOKEN.test(reservation.reservation_token)
          || typeof reservation.reservation_le !== 'string'
          || !Number.isFinite(Date.parse(reservation.reservation_le))) {
          throw new Error('Confirmation de réservation invalide.');
        }
        reservationToken = reservation.reservation_token;
        const listId = new URL(urlReply).pathname.split('/').at(-1);
        verifierAnnulation(signal);
        const tab = await chrome.tabs.create({ url: urlReply, active: true });
        tabId = tab.id;
        logger.log('contact:onglet_ouvert', { tabId, listId });
        const { courant, formulaire } = await attendreFormulaire(tabId, listId, signal);
        // Toujours écarter un anti-robot avant de classer une annonce.
        const terminal = async (erreurCode) => {
          if (await pageAntiRobot(tabId)) throw new Blocage();
          return simulation
            ? terminerSimulation(urlAnnonce, tabId, reservationToken, { erreurCode })
            : marquerTerminal(urlAnnonce, erreurCode, tabId, reservationToken);
        };
        if (!estReplyAttendue(courant?.url, listId)) {
          if (redirectionConnexion(courant?.url)) {
            throw new Error('La session Leboncoin exige une nouvelle connexion.');
          }
          return await terminal('reply_indisponible');
        }
        if (!formulaire) return await terminal('formulaire_absent');
        logger.log('contact:formulaire_pret', { tabId, listId, status: courant.status });

        await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['content/contact.js'] });
        confirmation = observerConfirmation(tabId, listId);
        surAnnulation = () => {
          void Promise.resolve().then(() => chrome.scripting.executeScript({
            target: { tabId }, world: 'ISOLATED',
            func: function annulerEnvoiContact() { window.__ps5ContactAnnule = true; },
          })).catch((error) => logger.logErreur('contact:annulation_echec', error, { tabId, listId }));
        };
        signal?.addEventListener('abort', surAnnulation, { once: true });
        verifierAnnulation(signal);
        // Un accusé perdu ne prouve pas l’absence de clic : dès cet appel,
        // seule une réponse explicite peut établir un échec pré-clic. En mode
        // test, le script reçoit dryRun et ne peut pas cliquer.
        envoiDeclenche = !simulation;
        const resultats = await chrome.scripting.executeScript({
          target: { tabId }, world: 'ISOLATED',
          func: async (message, options) => {
            await window.__ps5ContactReady;
            return window.__ps5EnvoyerContact(message, options);
          },
          args: [texte, { dryRun: simulation, listId }],
        });
        const result = resultats?.[0]?.result;
        // La navigation peut confirmer le clic avant l’accusé du script.
        if (!confirmation.resultat()?.ok) {
          if (result?.ok === false && result.terminal === true && result.clique !== true
            && ['reply_indisponible', 'formulaire_absent'].includes(result.erreurCode)) {
            confirmation.annuler();
            envoiDeclenche = false;
            return await terminal(result.erreurCode);
          }
          if (result?.ok === false && result.clique === false) {
            envoiDeclenche = false;
            if (result.annule) throw new Annulation();
            if (result.bloque) throw new Blocage();
            throw new Error(result.error || 'Envoi impossible : rien n’a été envoyé.');
          }
          if (result?.ok === true && result.clique === false && result.dryRun === true) {
            envoiDeclenche = false;
            simulation = true;
            logger.log('contact:simulation', { tabId, listId });
            consigner(journalEnvois, { ...envoi, simulated: true });
            return await terminerSimulation(urlAnnonce, tabId, reservationToken);
          }
          if (result?.ok !== true || result?.clique !== true) {
            throw new Error(result?.error || 'Accusé du script d’envoi absent ou invalide.');
          }
        }
        logger.log('contact:clic', { tabId, listId });
        confirmation.demarrerExpiration();
        if (!confirmation.resultat()?.ok) {
          const courantApresClic = await chrome.tabs.get(tabId);
          confirmation.verifier(courantApresClic?.url);
        }
        const confirme = await confirmation.promise;
        if (!confirme.ok) return await incertain(urlAnnonce, tabId, reservationToken);
        logger.log('contact:confirmation', { tabId, listId });

        return await finaliserConfirme(urlAnnonce, tabId, reservationToken, envoi);
      } catch (error) {
        if (confirmation?.resultat()?.ok) {
          return await finaliserConfirme(urlAnnonce, tabId, reservationToken, envoi);
        }
        if (envoiDeclenche) return await incertain(urlAnnonce, tabId, reservationToken);
        let echec = error;
        if (!(echec instanceof Annulation) && !(echec instanceof Blocage)
          && tabId != null && await pageAntiRobot(tabId)) echec = new Blocage();
        if (reservationToken) {
          try {
            await api.libererContact(urlAnnonce, reservationToken);
          } catch (cause) {
            echec = new Error(`${echec instanceof Annulation ? 'Envoi annulé.' : echec.message} `
              + `La réservation est conservée car sa libération a échoué : ${cause.message}`, { cause: error });
          }
        }
        // La page de vérification reste visible pour l'utilisateur.
        if (tabId != null && !(echec instanceof Blocage) && !/leboncoin a restreint/.test(echec.message)) {
          await fermer(tabId);
        }
        if (echec instanceof Annulation) return annulee;
        throw echec;
      } finally {
        signal?.removeEventListener('abort', surAnnulation);
        confirmation?.annuler();
        enCours = false;
      }
    },
  };
}
