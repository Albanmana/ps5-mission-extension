import {
  CONVERSATION_ALARM,
  CONVERSATION_STATE_KEY,
  abandonPendingFailures,
  addProcessedFingerprint,
  baselinePreviews,
  createConversationState,
  ignoredPreviews,
  isConversationWindowOpen,
  markSendUncertain,
  nextConversationAlarmAt,
  nextConversationRetryAt,
  observeConversationPreview,
  recordThreadFailure,
  recoverConversationState,
  surfaceInterruptedTurns,
} from './conversation-state.js';
import { loadSettings } from '../lib/settings.js';
import { consigner } from './sent-log.js';

const INBOX_URL = 'https://www.leboncoin.fr/messages';
const MESSAGE_TAB_PATTERN = 'https://www.leboncoin.fr/messages*';
const MAX_MANUAL_BATCH = 50;
const MAX_IGNOREES = 100;
// Pannes qui ne tiennent pas à la conversation (codes du serveur local).
const PANNES_HORS_FIL = ['modele_indisponible', 'base_indisponible'];
const ICON = 'icons/icon-128.png';
const CONTINUE_BATCH = ['sent', 'handoff', 'duplicate', 'no_seller_message', 'hors_perimetre'];

class Interruption extends Error {}

function sameConversation(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

// Un aperçu marqué « provisoire » ne compte comme observé que tant que le
// réglage qui a empêché la réponse est encore actif. Sinon le fil reste connu,
// mais à traiter.
function previewsFor(observed, settings) {
  return Object.fromEntries(Object.entries(observed ?? {}).map(([url, entry]) => {
    const perime = (entry?.provisoire === 'simulation' && !settings.dryRun)
      || (entry?.provisoire === 'hors_perimetre' && settings.replyScope !== 'contacted');
    return [url, perime ? { ...entry, preview: null } : entry];
  }));
}

async function defaultHash(snapshot) {
  let sellerIndex = -1;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    if (snapshot.messages[index]?.expediteur === 'vendeur') { sellerIndex = index; break; }
  }
  const content = snapshot.messages[sellerIndex]?.contenu ?? '';
  const bytes = new TextEncoder().encode(`${snapshot.url_conversation}|${sellerIndex}|${content}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createConversationPoller({
  chrome,
  api,
  logger = { log() {}, logErreur() {} },
  random = Math.random,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hash = defaultHash,
  journalEnvois,
} = {}) {
  let current = createConversationState();
  let running = null;

  async function broadcast() {
    try { await chrome.runtime.sendMessage({ type: 'conversations-maj', etat: clone(current) }); } catch { /* panneau fermé */ }
  }

  async function save(patch = {}) {
    current = { ...current, ...patch };
    // Aucune fin de cycle, même tardive, ne peut annuler une pause.
    if (current.enabled !== true) current = { ...current, status: 'paused', nextRunAt: null };
    await chrome.storage.local.set({ [CONVERSATION_STATE_KEY]: current });
    await broadcast();
    return clone(current);
  }

  async function schedule() {
    if (!current.enabled || current.status === 'paused' || current.status === 'running') {
      await chrome.alarms.clear(CONVERSATION_ALARM);
      return;
    }
    const retrying = current.status === 'retrying' || current.status === 'blocked';
    const nextRunAt = retrying
      ? nextConversationRetryAt(now(), current.failureCount, current.status === 'blocked')
      : nextConversationAlarmAt(now(), random);
    await save({ nextRunAt });
    chrome.alarms.create(CONVERSATION_ALARM, { when: nextRunAt });
  }

  async function notify(title, message) {
    try {
      const iconUrl = chrome.runtime.getURL?.(ICON) ?? `/${ICON}`;
      await chrome.notifications.create({ type: 'basic', iconUrl, title, message });
    } catch (error) {
      logger.logErreur('conversations:notification_echec', error);
    }
  }

  async function completeHandled(urlConversation, fingerprint) {
    await api.conversationHandled({ url_conversation: urlConversation, fingerprint });
    const pendingHandled = { ...(current.pendingHandled ?? {}) };
    if (pendingHandled[urlConversation] === fingerprint) delete pendingHandled[urlConversation];
    await save({ pendingHandled });
  }

  async function recordHandoff(entry, settings) {
    const response = await api.handoff({ ...entry.payload, settings });
    // L’utilisateur a pu retirer l’entrée pendant l’appel.
    if (!current.handoffs[entry.fingerprint]) return;
    await save({
      handoffs: {
        ...current.handoffs,
        [entry.fingerprint]: { ...entry, enregistre: true, notified: response?.notified === true },
      },
      pendingHandled: { ...current.pendingHandled, [entry.url_conversation]: entry.fingerprint },
    });
  }

  // Transmet au serveur une libération de tour ou un envoi incertain en attente.
  // Un échec la garde pour plus tard.
  async function signaler(url) {
    const entry = current.aSignaler[url];
    if (!entry) return;
    try {
      await api.conversationError({ url_conversation: url, ...entry });
    } catch (error) {
      if (error.code !== 'tour_introuvable') throw error;
    }
    if (current.aSignaler[url]?.fingerprint !== entry.fingerprint) return;
    const aSignaler = { ...current.aSignaler };
    delete aSignaler[url];
    await save({ aSignaler });
  }

  const signalerSansBloquer = (url) => signaler(url).catch((error) => {
    logger.logErreur('conversations:liberation_echec', error);
  });

  async function mettreASignaler(url, fingerprint, code) {
    await save({ aSignaler: { ...current.aSignaler, [url]: { fingerprint, code } } });
    await signalerSansBloquer(url);
  }

  // Rattrapage des cycles précédents. Un échec reste en attente sans bloquer
  // les autres conversations.
  async function retryPending() {
    const waiting = Object.values(current.handoffs ?? {}).filter((entry) => !entry.dryRun && !entry.enregistre);
    if (waiting.length) {
      try {
        for (const entry of waiting) {
          const settings = await loadSettings(chrome);
          if (settings.dryRun) break;
          try { await recordHandoff(entry, settings); } catch (error) {
            logger.logErreur('conversations:handoff_echec', error);
          }
        }
      } catch (error) {
        logger.logErreur('conversations:handoff_echec', error);
      }
    }
    for (const url of Object.keys(current.aSignaler)) await signalerSansBloquer(url);
    for (const [url, fingerprint] of Object.entries(current.pendingHandled ?? {})) {
      try {
        await completeHandled(url, fingerprint);
      } catch (error) {
        logger.logErreur('conversations:handoff_finalisation_echec', error);
        // Le serveur ne connaît plus ce tour : réessayer ne servirait à rien.
        if (error.code === 'tour_introuvable') {
          const pendingHandled = { ...current.pendingHandled };
          delete pendingHandled[url];
          await save({ pendingHandled });
        }
      }
    }
  }

  async function findMessagesTab() {
    const tabs = await chrome.tabs.query({ url: [MESSAGE_TAB_PATTERN] });
    return tabs.find((tab) => /^https:\/\/www\.leboncoin\.fr\/messages(?:\/|$)/.test(tab.url || '')) ?? null;
  }

  async function pageDomReady(tabId, expectedUrl) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: (targetUrl) => {
          const target = new URL(targetUrl);
          const current = new URL(location.href);
          return current.origin === target.origin
            && globalThis.__ps5PagePerimee !== true
            && current.pathname === target.pathname
            && document.readyState !== 'loading';
        },
        args: [expectedUrl],
      });
      return results?.[0]?.result === true;
    } catch {
      return false;
    }
  }

  async function navigate(tabId, url) {
    const currentTab = await chrome.tabs.get(tabId);
    if (currentTab?.url === url && await pageDomReady(tabId, url)) return currentTab;
    let tab = await chrome.tabs.update(tabId, { url, active: true });
    for (let attempt = 0; tab?.status !== 'complete' && attempt < 150; attempt += 1) {
      if (await pageDomReady(tabId, url)) return tab;
      await sleep(100);
      tab = await chrome.tabs.get(tabId);
    }
    if (tab?.status !== 'complete' && !(await pageDomReady(tabId, url))) {
      throw new Error('Chargement de la messagerie expiré.');
    }
    return tab;
  }

  // La liste affichée peut dater : on la recharge. L’ancienne page est marquée
  // pour ne pas être prise pour la nouvelle.
  async function reloadInbox(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED',
      func: (_url) => { globalThis.__ps5PagePerimee = true; }, args: [INBOX_URL],
    });
    await chrome.tabs.reload(tabId);
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await sleep(100);
      if (await pageDomReady(tabId, INBOX_URL)) return;
      const tab = await chrome.tabs.get(tabId);
      // Redirigé (connexion…) : la lecture de la liste le signalera.
      if (tab?.status === 'complete' && tab.url !== INBOX_URL) return;
    }
    throw new Error('Chargement de la messagerie expiré.');
  }

  async function injectAndCall(tabId, file, func, args = []) {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: [file] });
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func, args,
    });
    return results?.[0]?.result;
  }

  // Rend le nombre de lignes relevées.
  async function recordBaseline(tabId, checkpoint) {
    const read = await injectAndCall(tabId, 'content/messages-list.js', async () => {
      await window.__ps5MessagesListReady;
      return window.__ps5LireApercus();
    });
    checkpoint();
    if (!Array.isArray(read?.lignes)) throw new Error('Lecture de la liste des conversations impossible.');
    // Une liste vide peut n’être qu’un affichage incomplet : à refaire.
    if (read.lignes.length) {
      // Le relevé considère les fils lus comme vus : un échec encore en attente
      // ne serait plus retenté, il est donc confié à l’humain.
      await save({
        observedPreviews: baselinePreviews(read.lignes, now()),
        echecs: surfaceInterruptedTurns(
          { ...current, echecs: abandonPendingFailures(current.echecs) }, read.lignes, now()),
        baselinePending: false,
      });
    }
    return read.lignes.length;
  }

  async function readCandidate(tabId, { excludedUrls, settings, sansDelai }) {
    return injectAndCall(tabId, 'content/messages-list.js', async (previousPreviews, excluded, ignored) => {
      await window.__ps5MessagesListReady;
      return window.__ps5ChoisirCandidate({ previousPreviews, excludedUrls: excluded, ignoredPreviews: ignored });
    }, [previewsFor(current.observedPreviews, settings), excludedUrls,
      ignoredPreviews(current, now(), { sansDelai })]);
  }

  async function readThread(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', files: ['content/messages-thread.js'],
    });
    let lastError = 'Fil de conversation vide ou introuvable.';
    let previousRead = null;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: async () => {
          try {
            await window.__ps5MessagesThreadReady;
            return { snapshot: window.__ps5LireConversation() };
          } catch (error) {
            return { snapshot: null, erreur: error?.message || String(error) };
          }
        },
      });
      const result = results?.[0]?.result;
      const snapshot = result?.snapshot ?? (result?.messages ? result : null);
      if (snapshot?.messages?.length) {
        // Les bulles peuvent arriver en plusieurs fois : deux lectures
        // identiques de suite sont exigées.
        const read = JSON.stringify(snapshot);
        if (read === previousRead) return snapshot;
        previousRead = read;
        lastError = 'Fil de conversation encore en cours de chargement.';
        await sleep(400);
        continue;
      }
      previousRead = null;
      lastError = result?.erreur || results?.[0]?.error || lastError;
      if (/accès temporairement restreint/i.test(lastError)) throw new Error(lastError);
      await sleep(100);
    }
    throw new Error(`Lecture de la conversation expirée : ${lastError}`);
  }

  // L’injection du fichier est séparée de l’appel : son échec ne peut rien avoir envoyé.
  async function loadSender(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', files: ['content/send-message.js'],
    });
  }

  async function callSender(tabId, message, options) {
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED',
      func: async (text, sendOptions) => {
        // Chrome ne propage pas fidèlement les exceptions d’un script injecté.
        // Le script ne lève qu’avant le clic.
        try {
          await window.__ps5SendMessageReady;
          return await window.__ps5EnvoyerMessage(text, sendOptions);
        } catch (error) {
          return { ok: false, clique: false, erreur: error?.message || String(error) };
        }
      },
      args: [message, options],
    });
    return results?.[0]?.result;
  }

  async function returnInbox(tabId) {
    await navigate(tabId, INBOX_URL);
  }

  async function finish(tabId, result, fingerprint, { returnToInbox = true } = {}) {
    if (returnToInbox && tabId != null) await returnInbox(tabId);
    if (fingerprint) current = addProcessedFingerprint(current, fingerprint, now());
    await save({
      ...current,
      status: 'idle',
      processingFingerprint: null,
      processingUrl: null,
      envoiTente: null,
      lastResult: result,
      lastError: null,
      failureCount: 0,
    });
    await schedule();
    return clone(current);
  }

  async function fail(code, { blocked = false, preserveFingerprint = false, consumeFingerprint = false } = {}) {
    if (consumeFingerprint && current.processingFingerprint) {
      current = addProcessedFingerprint(current, current.processingFingerprint, now());
    }
    const status = blocked ? 'blocked' : 'retrying';
    await save({
      status,
      lastError: code,
      lastResult: consumeFingerprint ? 'requires_review' : null,
      nextRunAt: null,
      failureCount: (Number(current.failureCount) || 0) + 1,
      processingFingerprint: preserveFingerprint ? current.processingFingerprint : null,
      processingUrl: preserveFingerprint ? current.processingUrl : null,
      envoiTente: null,
    });
    await schedule();
    if (current.enabled) await notify('PS5 Mission — autopilote actif', blocked
      ? 'Leboncoin a restreint l’accès. Nouvelle tentative différée.'
      : consumeFingerprint
        ? `Vérifie la conversation (${code}) : ce message ne sera pas renvoyé.`
        : `Échec du cycle (${code}). Une nouvelle tentative est planifiée.`);
    return clone(current);
  }

  async function cycle({
    allowOutsideHours = false, excludedUrls = [], onCandidate, reload = true, sansDelai = false,
  } = {}) {
    if (running) return running;
    running = (async () => {
      if (!current.enabled || current.status === 'paused') return clone(current);
      const pauseSeq = current.pauseSeq;
      // Une pause arrête ce cycle même si l’utilisateur reprend aussitôt.
      const checkpoint = () => {
        if (!current.enabled || current.pauseSeq !== pauseSeq) throw new Interruption('Cycle interrompu par une pause.');
      };
      await retryPending();
      if (!current.enabled) return clone(current);
      if (!allowOutsideHours && !isConversationWindowOpen(now())) {
        await save({ status: 'idle', lastResult: 'outside_hours', lastError: null, nextRunAt: null });
        await schedule();
        return clone(current);
      }
      await save({ status: 'running', lastRunAt: new Date(now()).toISOString(), nextRunAt: null });
      let tab;
      let clicked = false;
      // Rempli tant que le script d’envoi a pu cliquer sans qu’on en sache plus.
      let envoiPossible = null;
      let handoffCompleted = false;
      let envoiEnregistre = false;
      let candidate;
      let filLu = null;
      // Tour réservé côté serveur et pas encore envoyé : à libérer si rien ne part.
      let reservation = null;
      const releaseReservation = async () => {
        if (!reservation) return;
        const { url_conversation: url, fingerprint } = reservation;
        reservation = null;
        await mettreASignaler(url, fingerprint, 'generation_echec');
      };
      // Un tour qui n’a pas abouti reste à traiter, même si l’aperçu ne change plus.
      const restorePreview = () => {
        if (!candidate?.url_conversation) return;
        current = {
          ...current,
          observedPreviews: {
            ...current.observedPreviews,
            [candidate.url_conversation]: { preview: null, observedAt: now(), enCours: candidate.preview },
          },
        };
      };
      const oublierEchec = () => {
        if (!current.echecs[candidate.url_conversation]) return;
        const echecs = { ...current.echecs };
        delete echecs[candidate.url_conversation];
        current = { ...current, echecs };
      };
      // L’aperçu réel n’est enregistré qu’à la conclusion du tour : avant, un
      // arrêt du service worker laisse le fil à traiter.
      const noterApercu = (provisoire) => {
        if (!candidate?.url_conversation) return;
        current = observeConversationPreview(current, candidate, now());
        const entry = current.observedPreviews[candidate.url_conversation];
        if (!provisoire || !entry) return;
        current = {
          ...current,
          observedPreviews: {
            ...current.observedPreviews,
            [candidate.url_conversation]: { ...entry, provisoire },
          },
        };
      };
      const oublierIgnoree = () => {
        if (!current.ignorees[candidate.url_conversation]) return;
        const ignorees = { ...current.ignorees };
        delete ignorees[candidate.url_conversation];
        current = { ...current, ignorees };
      };
      const noterIgnoree = (snapshot) => {
        const entries = Object.entries({
          ...current.ignorees,
          [candidate.url_conversation]: {
            vendeur: snapshot.vendeur ?? null,
            annonce_titre: snapshot.annonce_titre ?? null,
            message_vendeur: snapshot.dernier_message_vendeur,
            ignore_le: now(),
          },
        }).sort((a, b) => b[1].ignore_le - a[1].ignore_le).slice(0, MAX_IGNOREES);
        current = { ...current, ignorees: Object.fromEntries(entries) };
      };
      // Le tour a abouti : les échecs passés de ce fil ne comptent plus.
      const conclure = (tabId, result, fingerprint, { provisoire, ...options } = {}) => {
        oublierEchec();
        if (result !== 'hors_perimetre') oublierIgnoree();
        noterApercu(provisoire);
        return finish(tabId, result, fingerprint, options);
      };
      const envoiIncertain = async (envoi, cause) => {
        envoiPossible = null;
        clicked = true;
        reservation = null;
        oublierEchec();
        noterApercu();
        await save(markSendUncertain(current, envoi, now()));
        await signalerSansBloquer(envoi.url_conversation);
        const blocked = /accès temporairement restreint/i.test(cause?.message ?? '');
        return fail(blocked ? 'bloque' : 'envoi_incertain', { blocked, consumeFingerprint: true });
      };
      // Rend true quand ce nouvel échec confie le fil à l’humain.
      const compterEchec = (code) => {
        if (!candidate?.url_conversation) return false;
        current = recordThreadFailure(current, candidate, {
          code,
          ouvert: filLu !== null,
          vendeur: filLu?.vendeur ?? null,
          annonce_titre: filLu?.annonce_titre ?? null,
          message_vendeur: filLu?.dernier_message_vendeur ?? null,
        }, now());
        return current.echecs[candidate.url_conversation].abandonne;
      };
      const echecDuFil = async (code) => {
        const abandonne = compterEchec(code);
        const state = await fail(code);
        if (abandonne && current.enabled) {
          await notify('PS5 Mission — reprise nécessaire',
            'Une conversation échoue à répétition : réponds-y toi-même.');
        }
        return state;
      };
      try {
        const initialSettings = await loadSettings(chrome);
        tab = await findMessagesTab();
        if (!tab) return await finish(null, 'waiting_for_tab', null, { returnToInbox: false });
        checkpoint();
        if (reload && tab.url === INBOX_URL) await reloadInbox(tab.id);
        else await navigate(tab.id, INBOX_URL);
        if (current.baselinePending && await recordBaseline(tab.id, checkpoint) === 0) {
          return await finish(tab.id, 'no_unread', null, { returnToInbox: false });
        }
        candidate = await readCandidate(tab.id, { excludedUrls, settings: initialSettings, sansDelai });
        if (!candidate?.url_conversation) return await finish(tab.id, 'no_unread', null, { returnToInbox: false });
        onCandidate?.(candidate.url_conversation);
        logger.log('conversations:candidate', {
          url: candidate.url_conversation,
          source: candidate.source,
        });
        restorePreview();
        await save({ observedPreviews: current.observedPreviews });

        await sleep(4_000 + Math.floor(random() * 6_000));
        checkpoint();
        await navigate(tab.id, candidate.url_conversation);
        const snapshot = await readThread(tab.id);
        if (!sameConversation(snapshot.url_conversation, candidate.url_conversation)) {
          throw new Error('mauvaise_conversation');
        }
        filLu = snapshot;
        const dernierMessage = snapshot?.messages?.at(-1);
        logger.log('conversations:snapshot', {
          url: snapshot?.url_conversation,
          messages: snapshot?.messages?.length ?? 0,
          dernierRole: dernierMessage?.expediteur ?? null,
        });
        if (!snapshot?.dernier_message_vendeur || dernierMessage?.expediteur !== 'vendeur') {
          return await conclure(tab.id, 'no_seller_message', null);
        }
        const fingerprint = await hash(snapshot);
        if (current.processedFingerprints?.[fingerprint]) return await conclure(tab.id, 'duplicate', fingerprint);

        const settings = await loadSettings(chrome);
        checkpoint();
        const turn = { url_conversation: snapshot.url_conversation, fingerprint };
        // Une libération en attente passe d’abord : sans elle, le serveur
        // répondrait « duplicate » et le message serait écarté à tort.
        await signaler(turn.url_conversation);
        // En simulation rien n’est réservé : il n’y a rien à reprendre au redémarrage.
        if (!settings.dryRun) {
          await save({ processingFingerprint: fingerprint, processingUrl: turn.url_conversation });
        }
        checkpoint();
        // Le serveur a pu réserver même si sa réponse se perd.
        if (!settings.dryRun) reservation = turn;
        const generated = await api.conversationNegotiate(snapshot, fingerprint, settings);
        if (generated?.ignored === true) {
          reservation = null;
          noterIgnoree(snapshot);
          return await conclure(tab.id, 'hors_perimetre', null, { provisoire: 'hors_perimetre' });
        }
        if (generated?.duplicate === true) {
          reservation = null;
          return await conclure(tab.id, 'duplicate', fingerprint);
        }
        const dryRun = settings.dryRun || generated?.dryRun === true;
        const { conversation, draft } = generated ?? {};
        const stop = draft?.arret?.doit_arreter === true;
        // Un point d’arrêt se rejoue côté serveur ; une simulation n’a rien réservé.
        if (settings.dryRun || stop) reservation = null;
        if (!conversation?.id || !draft?.arret) throw new Error('Réponse de négociation invalide.');

        // Une reprise humaine n’écrit rien au vendeur : elle est conservée même en pause.
        if (stop) {
          const previous = current.handoffs[fingerprint];
          const entry = {
            ...turn,
            dryRun,
            enregistre: false,
            vendeur: snapshot.vendeur ?? null,
            annonce_titre: snapshot.annonce_titre ?? null,
            message_vendeur: snapshot.dernier_message_vendeur,
            raison: draft.arret.raison ?? null,
            notes: draft.notes_internes ?? '',
            offre_recue_eur: draft.offre_recue_eur ?? null,
            lieu_propose: draft.lieu_propose ?? null,
            cree_le: now(),
            payload: {
              conversation_id: conversation.id,
              message_vendeur: snapshot.dernier_message_vendeur,
              handoff: draft,
            },
          };
          // Persistée avant tout appel réseau : le serveur répondrait ensuite
          // « duplicate » et la reprise serait perdue.
          noterApercu(dryRun ? 'simulation' : undefined);
          if (!dryRun) current = addProcessedFingerprint(current, fingerprint, now());
          await save({
            ...current,
            processingFingerprint: null,
            processingUrl: null,
            handoffs: { ...current.handoffs, [fingerprint]: entry },
          });
          handoffCompleted = !dryRun;
          if (!previous || (previous.dryRun && !dryRun)) {
            await notify(dryRun ? 'PS5 Mission — reprise (simulation)' : 'PS5 Mission — reprise nécessaire',
              draft.notes_internes || draft.arret.raison || 'Une conversation attend ta réponse.');
          }
          if (!dryRun) {
            let recorded = false;
            try {
              // Relu juste avant l’envoi de l’e-mail ; en simulation il reste en attente.
              const latest = await loadSettings(chrome);
              if (!latest.dryRun) {
                await recordHandoff(entry, latest);
                recorded = true;
              }
            } catch (error) {
              logger.logErreur('conversations:handoff_echec', error);
            }
            if (recorded && current.pendingHandled[turn.url_conversation] === fingerprint) {
              await completeHandled(turn.url_conversation, fingerprint);
            }
          }
          return await conclure(tab.id, 'handoff', null, { provisoire: dryRun ? 'simulation' : undefined });
        }

        if (typeof draft.message !== 'string' || !draft.message.trim()) throw new Error('Brouillon de négociation vide.');
        checkpoint();
        const sendDryRun = dryRun || (await loadSettings(chrome)).dryRun;
        checkpoint();
        await loadSender(tab.id);
        checkpoint();
        const envoi = {
          ...turn,
          vendeur: snapshot.vendeur ?? null,
          annonce_titre: snapshot.annonce_titre ?? null,
          message_vendeur: snapshot.dernier_message_vendeur,
          brouillon: draft.message,
          cree_le: now(),
        };
        // Marque persistée avant l’appel : seul un « pas de clic » explicite l’efface.
        if (!sendDryRun) {
          await save({ envoiTente: envoi });
          // Pause pendant l’écriture : le script n’a pas été appelé.
          checkpoint();
          envoiPossible = envoi;
        }
        const sent = await callSender(tab.id, draft.message, {
          expectedUrl: snapshot.url_conversation, dryRun: sendDryRun, pauseSeq,
        });
        const confirme = sent?.confirme === true;
        const pasDeClic = !confirme && sent?.clique !== true
          && (sent?.clique === false || sent?.dryRun === true);
        if (pasDeClic) {
          envoiPossible = null;
          await save({ envoiTente: null });
        }
        if (!confirme && (envoiPossible || sent?.clique === true)) return await envoiIncertain(envoi);
        const journalise = {
          kind: 'reponse', vendeur: snapshot.vendeur ?? null, message: draft.message, url: snapshot.url_conversation,
        };
        if (!confirme) {
          if (sent?.dryRun === true) {
            if (sent.ok === true) consigner(journalEnvois, { ...journalise, simulated: true });
            await releaseReservation();
            // Le texte tapé reste visible : pas de retour à la liste.
            return await conclure(tab.id, 'dry_run', null,
              { returnToInbox: false, provisoire: 'simulation' });
          }
          if (sent?.erreurCode === 'interrompu') throw new Interruption('Envoi interrompu par une pause.');
          if (sent?.erreur) throw new Error(sent.erreur);
          if (sent?.erreurCode === 'mauvaise_conversation') throw new Error('mauvaise_conversation');
          throw new Error(`Envoi non déclenché : ${sent?.erreurCode || 'formulaire_absent'}`);
        }
        envoiPossible = null;
        clicked = true;
        reservation = null;
        oublierEchec();
        consigner(journalEnvois, { ...journalise, simulated: false });
        try {
          await api.conversationSent({
            ...turn,
            message: draft.message,
            offre_proposee_eur: draft.offre_proposee_eur ?? null,
          });
        } catch (error) {
          noterApercu();
          await mettreASignaler(turn.url_conversation, fingerprint, 'persistance_echec');
          return await fail('persistance_echec', { preserveFingerprint: false, consumeFingerprint: true });
        }
        // Consommé et démarqué avant le retour à la liste, qui peut échouer.
        current = addProcessedFingerprint(current, fingerprint, now());
        noterApercu();
        await save({ ...current, envoiTente: null, processingUrl: null });
        envoiEnregistre = true;
        await notify('PS5 Mission', `Réponse envoyée à ${snapshot.vendeur || 'un vendeur'}.`);
        return await conclure(tab.id, 'sent', fingerprint);
      } catch (error) {
        if (envoiPossible) {
          logger.logErreur('conversations:cycle_echec', error);
          return envoiIncertain(envoiPossible, error);
        }
        if (!clicked && !handoffCompleted) restorePreview();
        if (!clicked) {
          // La marque d’un envoi jamais tenté ne doit pas survivre à ce cycle.
          current = { ...current, envoiTente: null };
          await releaseReservation().catch((releaseError) => {
            logger.logErreur('conversations:liberation_echec', releaseError);
          });
        }
        if (error instanceof Interruption) {
          return finish(null, 'interrompu', null, { returnToInbox: false });
        }
        logger.logErreur('conversations:cycle_echec', error);
        if (handoffCompleted) return fail('persistance_echec');
        if (envoiEnregistre) return fail('retour_liste_echec');
        if (/accès temporairement restreint/i.test(error.message)) return fail('bloque', { blocked: true });
        if (/connexion/i.test(error.message)) return fail('connexion_requise');
        if (clicked) return fail('envoi_incertain', { preserveFingerprint: false, consumeFingerprint: true });
        // Serveur arrêté, base ou modèle indisponible : la panne ne tient pas à ce fil.
        if (error.name === 'ServerUnreachableError' || PANNES_HORS_FIL.includes(error.code)) {
          return fail('generation_echec');
        }
        return echecDuFil(error.message === 'mauvaise_conversation' ? 'mauvaise_conversation' : 'generation_echec');
      }
    })();
    try { return await running; } finally { running = null; }
  }

  return {
    async initialize() {
      const stored = (await chrome.storage.local.get(CONVERSATION_STATE_KEY))[CONVERSATION_STATE_KEY];
      current = recoverConversationState(stored);
      await save(current);
      if (current.enabled && current.status !== 'paused') {
        const restoredWhen = Number(current.nextRunAt);
        if (current.nextRunAt != null && Number.isFinite(restoredWhen)) {
          const existing = await chrome.alarms.get?.(CONVERSATION_ALARM);
          if (!existing || Number(existing.scheduledTime) !== restoredWhen) {
            chrome.alarms.create(CONVERSATION_ALARM, { when: restoredWhen });
          }
        } else await schedule();
      } else await chrome.alarms.clear(CONVERSATION_ALARM);
      return clone(current);
    },
    async state() { return clone(current); },
    async enable(enabled = true) {
      if (!enabled) return this.pause();
      return this.resume();
    },
    async pause() {
      await save({ enabled: false, status: 'paused', nextRunAt: null, pauseSeq: current.pauseSeq + 1 });
      await chrome.alarms.clear(CONVERSATION_ALARM);
      return clone(current);
    },
    async resume() {
      if (current.processingFingerprint && !running) throw new Error('Un résultat incertain doit être vérifié manuellement.');
      // Chaque (ré)activation repart d’un relevé : les fils déjà lus ne reçoivent rien.
      await save({
        enabled: true, status: 'idle', lastError: null,
        ...(current.enabled === true ? {} : { baselinePending: true }),
      });
      await schedule();
      return clone(current);
    },
    async acknowledge() {
      if (!current.processingFingerprint) throw new Error('Aucun résultat incertain à acquitter.');
      current = addProcessedFingerprint(current, current.processingFingerprint, now());
      await save({
        ...current,
        status: 'idle',
        lastError: null,
        lastResult: 'acknowledged',
      });
      await schedule();
      return clone(current);
    },
    async runNow(options) {
      // « Vérifier maintenant » : même choix que l’autopilote (non-lus et
      // changements), même hors horaires, enchaîné tant qu’il en reste.
      if (options?.manual !== true) return cycle(options);
      let state;
      let processed = 0;
      const visitedUrls = new Set();
      const pauseSeq = current.pauseSeq;
      const stopped = () => !current.enabled || current.pauseSeq !== pauseSeq;
      for (let index = 0; index < MAX_MANUAL_BATCH; index += 1) {
        if (index > 0) await sleep(500);
        if (stopped()) break;
        state = await cycle({
          reload: index === 0,
          allowOutsideHours: true,
          sansDelai: true,
          excludedUrls: [...visitedUrls],
          onCandidate: (url) => visitedUrls.add(url),
        });
        logger.log('conversations:batch_cycle', {
          index,
          result: state.lastResult,
          visited: visitedUrls.size,
          processed,
        });
        if (state.lastResult === 'sent' || state.lastResult === 'handoff') processed += 1;
        if (!CONTINUE_BATCH.includes(state.lastResult)) break;
      }
      if (processed > 0 && state?.lastResult === 'no_unread') {
        await save({ lastResult: 'batch_complete', lastBatchProcessed: processed });
      }
      return clone(current);
    },
    async dismissHandoff(fingerprint) {
      const entry = current.handoffs[fingerprint];
      if (!entry) return clone(current);
      const handoffs = { ...current.handoffs };
      delete handoffs[fingerprint];
      const pendingHandled = { ...current.pendingHandled };
      // Traitée avant l’enregistrement : le serveur doit quand même clore le tour.
      if (!entry.dryRun && !entry.enregistre) pendingHandled[entry.url_conversation] = fingerprint;
      return save({ handoffs, pendingHandled });
    },
    // Pris en main : la carte disparaît, le message en échec reste écarté.
    async dismissFailure(urlConversation) {
      const entry = current.echecs[urlConversation];
      if (!entry) return clone(current);
      return save({ echecs: { ...current.echecs, [urlConversation]: { ...entry, traite: true } } });
    },
    async onAlarm(alarm) {
      if (alarm?.name !== CONVERSATION_ALARM) return clone(current);
      const scheduledTime = Number(alarm.scheduledTime);
      if (Number.isFinite(scheduledTime)
        && (current.nextRunAt == null || scheduledTime !== Number(current.nextRunAt))) {
        return clone(current);
      }
      return cycle();
    },
  };
}
