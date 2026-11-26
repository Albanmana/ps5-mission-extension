import { createSerialQueue, createParallelQueue, jitteredDelay } from './queues.js';
import {
  creerEtatRun, appliquerEvenement, recoverRunState, recherchesReussies, pauseParUtilisateur,
} from './run-state.js';
import { MESSAGE_CONTACT_PAR_DEFAUT } from '../lib/templates.js';
import { loadSettings } from '../lib/settings.js';
import { collecterDetailDepuisDocument, extraireDetailDepuisDonneesBrutes } from './extract-detail.js';

const CLE_ETAT = 'run_recherche';
// Annonces déjà simulées, tous runs confondus (mode test seulement).
const CLE_SIMULEES = 'ps5_annonces_simulees';
const MAX_SIMULEES = 500;
const cleAnnonce = (url) => new URL(url).pathname.match(/\/(\d+)\/?$/)?.[1] ?? url;

// Le budget de fiches est limité et chaque visite coûte 10 à 20 s : mieux vaut
// le dépenser sur les annonces les plus prometteuses que sur les premières
// arrivées. La file leboncoin étant déjà sérielle, cet ordre ne coûte aucun
// parallélisme — il choisit seulement qui y entre.
const RANG = { saint_graal: 0, interessant: 1, a_verifier: 2 };
const CLASSIFICATIONS_CONTACT_AUTO = new Set(['saint_graal', 'interessant']);
const TENTATIVES_STABILISATION_DETAIL = 5;
const DELAI_STABILISATION_DETAIL_MS = 1500;

function cleContactAnnonce(annonce) {
  const vendeur = annonce?.detail_donnees?.vendeur ?? annonce?.donnees?.vendeur ?? annonce?.vendeur;
  const normalise = typeof vendeur === 'string'
    ? vendeur.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR')
    : '';
  return normalise ? `vendeur:${normalise}` : `annonce:${annonce?.url_annonce ?? ''}`;
}

function vendeurConsomme(etat, url) {
  const cle = cleContactAnnonce(etat?.annonces?.[url]);
  return Object.values(etat?.annonces ?? {}).some((annonce) => cleContactAnnonce(annonce) === cle
    && (annonce.contact_envoye === true || annonce.contact_skip === 'envoi_incertain'));
}

export function meilleureCandidateDetail(etat) {
  let meilleure = null;
  let meilleurRang = [Infinity, Infinity, ''];
  for (const annonce of Object.values(etat?.annonces ?? {})) {
    const recherche = etat.recherches?.[etat.recherche_index];
    if (recherche && !recherche.annonces_recues.includes(annonce.url_annonce)) continue;
    if (!annonce.analysee || !annonce.classification || annonce.classification === 'disqualifiee') continue;
    if (annonce.disqualifiee || annonce.detail) continue;
    const prix = Number.isFinite(annonce.prix_eur) ? annonce.prix_eur : Infinity;
    const rang = [RANG[annonce.classification] ?? 3, prix, annonce.url_annonce];
    if (rang[0] < meilleurRang[0]
      || (rang[0] === meilleurRang[0] && rang[1] < meilleurRang[1])
      || (rang[0] === meilleurRang[0] && rang[1] === meilleurRang[1] && rang[2] < meilleurRang[2])) {
      meilleurRang = rang;
      meilleure = annonce.url_annonce;
    }
  }
  return meilleure;
}
class Annule extends Error {}
class ResultatAbsent extends Error {}
class EchecAutomatique extends Error {}
class StockageIndisponible extends Error {}
class RechercheExpiree extends Error {}
const sleepReel = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Les dépendances externes sont injectables ; les tests exercent les mêmes
// files, transitions et promesses que le service worker Chrome.
export function createRecherche({ chrome, api, contact, sleep = sleepReel, readinessWait = sleepReel,
  searchTimeoutMs = 30000, random = Math.random }) {
  // La cadence dépend de la prochaine requête. Aucun délai supplémentaire
  // dans la file : un seul sleep réel de 3–6 s ou de 10–20 s dans requete().
  const leboncoin = createSerialQueue({ minDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });
  const locale = createParallelQueue({ concurrency: 3 });
  let etat = null, initialisation, ecritures = Promise.resolve(), execution = null;
  let controles = Promise.resolve(), ongletRecherche = null, pageEnCours = null;
  const reveils = new Set();
  const interruptionsRecherche = new Set();
  const travaux = new Set();
  const annoncesEnCours = new Set();
  let contactsReserves = new Set();
  let erreurTravail = null;
  let requeteEffectuee = false;
  let executionAutomatique = false;
  let contactInterruptible = null;

  function enregistrer(evenement) {
    const resultat = ecritures.then(async () => {
      etat = appliquerEvenement(etat, evenement);
      // Pause, Stop, blocage et coupure des envois retirent immédiatement le droit de cliquer.
      if (etat.statut !== 'en_cours' || !etat.contactAuto) contactInterruptible?.abort();
      try { await chrome.storage.local.set({ [CLE_ETAT]: etat }); }
      catch (error) { throw new StockageIndisponible(error.message, { cause: error }); }
      // Fermer le panneau n'interrompt pas le run.
      await chrome.runtime.sendMessage({ type: 'run-maj', etat }).catch(() => {});
      return etat;
    });
    ecritures = resultat.catch(() => {});
    return resultat;
  }

  async function fermerOnglet(id) {
    try { await chrome.tabs.remove(id); } catch { /* Déjà fermé par l’utilisateur. */ }
    await enregistrer({ type: 'onglet_ferme', id });
  }

  async function fermerTous() {
    for (const id of [...(etat?.onglets ?? [])]) await fermerOnglet(id);
    ongletRecherche = null;
  }

  function initialiser() {
    initialisation ??= (async () => {
      etat = recoverRunState((await chrome.storage.local.get(CLE_ETAT))[CLE_ETAT] ?? null);
      if (!etat) return;
      await fermerTous();
      for (const annonce of Object.values(etat.annonces)) {
        if (annonce.detail === 'en_cours') await enregistrer({ type: 'detail', url_annonce: annonce.url_annonce, statut: null });
      }
      if (etat.statut === 'en_cours') {
        await enregistrer({ type: 'pause', message: 'Service worker interrompu. Reprendre pour continuer.' });
      }
    })();
    return initialisation;
  }

  function controler(fn) {
    const resultat = controles.then(async () => { await initialiser(); return fn(); });
    controles = resultat.catch(() => {});
    return resultat;
  }

  async function lireReglages() {
    try { return await loadSettings(chrome); }
    catch (error) { throw new StockageIndisponible(`Réglages illisibles : ${error.message}`, { cause: error }); }
  }

  async function attendreActif() {
    while (etat.statut === 'pause') {
      if (executionAutomatique && etat.erreur && !pauseParUtilisateur(etat)) throw new EchecAutomatique(etat.erreur);
      await new Promise((resolve) => { reveils.add(resolve); });
    }
    if (etat.statut !== 'en_cours') throw new Annule();
  }

  function signaler() {
    for (const resolve of reveils) resolve();
    reveils.clear();
    for (const interrompre of interruptionsRecherche) interrompre();
  }

  function verifierNonArrete() {
    if (!['en_cours', 'pause'].includes(etat.statut)) throw new Annule();
  }

  async function extraireDetailStabilise(tabId, url) {
    for (let tentative = 1; tentative <= TENTATIVES_STABILISATION_DETAIL; tentative++) {
      let result;
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId }, func: collecterDetailDepuisDocument,
        });
        if (injection?.error) {
          throw new Error(injection.error.message ?? String(injection.error));
        }
        result = extraireDetailDepuisDonneesBrutes(injection?.result);
      } catch (error) {
        const message = error?.message ?? '';
        if (/leboncoin.*restreint|annonce leboncoin désactivée/i.test(message)) throw error;
        let transition;
        try {
          [{ result: transition }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: function observerTransitionDetail() {
              const missingNextData = !document.getElementById('__NEXT_DATA__');
              const texte = `${document.title ?? ''} ${document.body?.innerText ?? document.body?.textContent ?? ''}`;
              return {
                deviceCheck: Boolean(document.querySelector?.('iframe[src*="captcha-delivery.com"]'))
                  || (missingNextData && /datadome|device check/i.test(texte)),
                missingNextData,
              };
            },
          });
        } catch {
          throw error;
        }
        const challengeActif = transition?.deviceCheck === true;
        const donneesEnTransition = transition?.missingNextData === true
          && /__NEXT_DATA__ absent/i.test(message);
        if (!challengeActif && !donneesEnTransition) throw error;
        if (tentative === TENTATIVES_STABILISATION_DETAIL) {
          if (challengeActif) throw new Error('leboncoin a restreint l’accès.');
          throw error;
        }
        await attendreActif();
        await sleep(DELAI_STABILISATION_DETAIL_MS);
        await attendreActif();
        continue;
      }
      if (!result || typeof result.url_annonce !== 'string'
        || result.url_annonce.split('?')[0] !== url.split('?')[0]) {
        throw new Error('Fiche détail absente ou annonce inattendue.');
      }
      return { ...result, url_annonce: url };
    }
    throw new Error('Fiche détail absente ou annonce inattendue.');
  }

  // Chrome peut garder une injection ou tabs.get en attente sans jamais
  // résoudre sa promesse. Le délai et Stop doivent pouvoir libérer la file.
  async function operationRecherche(operation, deadline) {
    await attendreActif();
    const restant = deadline - Date.now();
    if (restant <= 0) throw new RechercheExpiree('Chargement leboncoin expiré.');
    return new Promise((resolve, reject) => {
      let terminee = false;
      const terminer = (error, value) => {
        if (terminee) return;
        terminee = true;
        clearTimeout(timer);
        interruptionsRecherche.delete(interrompre);
        if (error) reject(error); else resolve(value);
      };
      const interrompre = () => {
        if (!['en_cours', 'pause'].includes(etat.statut)) terminer(new Annule());
        else if (executionAutomatique && etat.statut === 'pause' && etat.erreur && !pauseParUtilisateur(etat)) {
          terminer(new EchecAutomatique(etat.erreur));
        }
      };
      const timer = setTimeout(() => terminer(new RechercheExpiree('Chargement leboncoin expiré.')), restant);
      interruptionsRecherche.add(interrompre);
      interrompre();
      Promise.resolve().then(async () => {
        await attendreActif();
        if (!terminee) return operation();
      }).then((value) => terminer(null, value), (error) => terminer(error));
    });
  }

  async function attendrePageRecherche(tabId) {
    const deadline = Date.now() + searchTimeoutMs;
    for (let tentative = 0; tentative < 60; tentative++) {
      await attendreActif();
      const tab = await operationRecherche(() => chrome.tabs.get(tabId), deadline);
      let sonde;
      try {
        const [injection] = await operationRecherche(() => chrome.scripting.executeScript({
          target: { tabId }, injectImmediately: true,
          func: function sonderPageRecherche() {
            // Des annonces utilisables prouvent que la page n'est pas bloquée.
            // innerText ignore les scripts, qui mentionnent DataDome partout.
            const annonces = Array.from(document.querySelectorAll?.('article') ?? [])
              .some((article) => /\/ad\//.test(article.querySelector('a[href]')?.getAttribute('href') ?? ''));
            const text = `${document.title ?? ''} ${document.body?.innerText ?? document.body?.textContent ?? ''}`;
            return {
              href: location.href,
              readyState: document.readyState,
              blocked: !annonces && (Boolean(document.querySelector('iframe[src*="captcha-delivery.com"]'))
                || /datadome|device check|accès temporairement restreint|please enable js and disable any ad blocker/i.test(text)),
              ready: Boolean(document.getElementById('__NEXT_DATA__') || document.querySelector('article')),
            };
          },
        }), deadline);
        sonde = injection?.result;
      } catch (error) {
        if (error instanceof Annule || error instanceof EchecAutomatique || error instanceof RechercheExpiree) throw error;
        // Une navigation peut momentanément détruire le contexte.
      }
      await attendreActif();
      if (sonde?.blocked) throw new Error('leboncoin a restreint l’accès.');
      const href = sonde?.href || tab.url;
      if (href) {
        const courant = new URL(href);
        if (courant.origin !== 'https://www.leboncoin.fr' || !/^\/recherche\/?$/.test(courant.pathname)) {
          throw new Error('Page de recherche inattendue.');
        }
      }
      if (sonde?.ready) return;
      if (Date.now() >= deadline) break;
      await operationRecherche(() => readinessWait(500), deadline);
    }
    throw new Error('Chargement leboncoin expiré.');
  }

  async function chargerOnglet(url, { recherche = false } = {}) {
    // La réservation du budget comporte des écritures asynchrones. Relire la
    // transition effectivement persistée juste avant la navigation réelle.
    await ecritures;
    await attendreActif();
    const tab = await chrome.tabs.create({ url, active: false });
    await enregistrer({ type: 'onglet_ouvert', id: tab.id });
    // S’abonner avant tabs.get ferme la course entre la création et complete.
    try {
      if (recherche) await attendrePageRecherche(tab.id);
      else await new Promise((resolve, reject) => {
        let timer;
        const terminer = (error) => {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          if (error) reject(error); else resolve();
        };
        const listener = (id, info) => { if (id === tab.id && info.status === 'complete') terminer(); };
        chrome.tabs.onUpdated.addListener(listener);
        timer = setTimeout(() => terminer(new Error('Chargement leboncoin expiré.')), 30000);
        chrome.tabs.get(tab.id).then((courant) => { if (courant.status === 'complete') terminer(); }, terminer);
      });
      await attendreActif();
      return tab.id;
    } catch (error) {
      await fermerOnglet(tab.id);
      throw error;
    }
  }

  function requete(type, operation, admissible = () => true) {
    return leboncoin.push(async () => {
      await attendreActif();
      if (!admissible()) return null;
      if (type === 'detail' || requeteEffectuee) {
        const [min, max] = type === 'detail' ? [10000, 20000] : [3000, 6000];
        await sleep(jitteredDelay(min, max, random));
        await attendreActif();
      }
      requeteEffectuee = true;
      return operation();
    });
  }

  async function recevoirAnnonces(annonces) {
    for (const annonce of annonces ?? []) {
      if (etat.statut !== 'en_cours' && etat.statut !== 'pause') return;
      await enregistrer({ type: 'recue', annonce });
      planifierAnnonce(annonce.url_annonce);
    }
  }

  async function gererErreur(error, url, { suspendre = false } = {}) {
    if (error instanceof EchecAutomatique) throw error;
    if (error instanceof Annule || etat.statut === 'termine' || etat.statut === 'bloque') return;
    if (url) await enregistrer({ type: 'erreur', url_annonce: url, message: error.message });
    if (/leboncoin.*restreint/i.test(error.message)) {
      await enregistrer({ type: 'bloque', message: error.message }); signaler();
      if (executionAutomatique) throw new EchecAutomatique(error.message);
    } else if (suspendre || !url || error.name === 'ServerUnreachableError' || error instanceof ResultatAbsent || error instanceof StockageIndisponible) {
      await enregistrer({ type: 'pause', message: error.message });
      // Mis en pause par l’utilisateur : l’exécution attend Reprendre ou Stop.
      if (executionAutomatique && !pauseParUtilisateur(etat)) { signaler(); throw new EchecAutomatique(error.message); }
    }
  }

  async function traiterAnnonce(url) {
    await attendreActif();
    const annonce = etat.annonces[url];
    try {
      const { deja_analysee } = await api.upsertAnnonce(annonce.donnees);
      verifierNonArrete();
      await enregistrer({ type: 'upsertee', url_annonce: url, deja_analysee });
      await attendreActif();
      // Un ancien état (avant analyse_demandee) conserve la décision initiale
      // via l’upsert réussi qui avait constaté l’absence d’analyse en base.
      const analyseDeCeRun = annonce.analyse_demandee || annonce.en_base && annonce.deja_analysee === false;
      if (!annonce.analysee && (analyseDeCeRun || !deja_analysee || etat.force)) {
        const force = annonce.analyse_demandee ? annonce.analyse_force === true : etat.force;
        await enregistrer({ type: 'analyse_demandee', url_annonce: url, force });
        await attendreActif();
        const analyse = await api.classifyAnnonce(url, { force, settings: await lireReglages() });
        verifierNonArrete();
        if (!analyse.classification) throw new ResultatAbsent('Résultat de classification absent : mettez à jour le serveur local.');
        await enregistrer({ ...analyse, type: 'classifiee', url_annonce: url });
      }
      await enregistrer({ type: 'traitee', url_annonce: url, revision: annonce.revision });
    } catch (error) {
      await gererErreur(error, url);
      if (error.name !== 'ServerUnreachableError' && !(error instanceof Annule) && !(error instanceof ResultatAbsent)
        && !(error instanceof StockageIndisponible)) {
        await enregistrer({ type: 'traitee', url_annonce: url, revision: annonce.revision });
      }
    }
  }

  // En mode test, un seul essai par run et jamais deux fois la même annonce.
  let simulationFaite = false;
  async function lireSimulees() {
    try {
      const liste = (await chrome.storage.local.get(CLE_SIMULEES))[CLE_SIMULEES];
      return Array.isArray(liste) ? liste : [];
    } catch (error) { throw new StockageIndisponible(error.message, { cause: error }); }
  }
  async function memoriserSimulee(url) {
    const liste = [...(await lireSimulees()).filter((cle) => cle !== cleAnnonce(url)), cleAnnonce(url)];
    try { await chrome.storage.local.set({ [CLE_SIMULEES]: liste.slice(-MAX_SIMULEES) }); }
    catch (error) { throw new StockageIndisponible(error.message, { cause: error }); }
  }
  async function simulationEpuisee(url) {
    const dejaFaite = simulationFaite || Object.values(etat.annonces).some((annonce) => annonce.contact_simule);
    if (!(await lireReglages()).dryRun) return false;
    return dejaFaite || (await lireSimulees()).includes(cleAnnonce(url));
  }

  // Le classement peut dater d’anciens réglages : le maximum actuel fait foi.
  // Sans prix connu, rien ne part.
  async function prixHorsLimite(url) {
    const annonce = etat.annonces[url];
    const prix = annonce?.detail_donnees?.prix_eur ?? annonce?.prix_eur;
    const { maxPrice } = await lireReglages();
    return !(Number.isFinite(prix) && prix <= maxPrice);
  }

  async function tenterContact(url) {
    if (await prixHorsLimite(url)) return { horsPrix: true };
    if (await simulationEpuisee(url)) return { simulationIgnoree: true };
    return requete('detail', async () => {
      // Les réglages ont pu changer pendant l’attente.
      if (await prixHorsLimite(url)) return { horsPrix: true };
      if (await simulationEpuisee(url)) return { simulationIgnoree: true };
      const cle = cleContactAnnonce(etat.annonces[url]);
      if (!etat.contactAuto) return null;
      if (contactsReserves.has(cle) || vendeurConsomme(etat, url)) return { dedoublonne: true };
      contactsReserves.add(cle);
      const controleur = new AbortController();
      contactInterruptible = controleur;
      // Une pause a pu arriver pendant les lectures précédentes.
      if (etat.statut !== 'en_cours' || !etat.contactAuto) controleur.abort();
      try {
        const fiche = etat.annonces[url];
        const envoi = await contact.envoyerContact(url, MESSAGE_CONTACT_PAR_DEFAUT, {
          signal: controleur.signal, vendeur: fiche?.detail_donnees?.vendeur ?? fiche?.donnees?.vendeur ?? null,
        });
        if (envoi?.envoye !== true && envoi?.erreurCode !== 'envoi_incertain') contactsReserves.delete(cle);
        if (envoi?.dryRun === true && envoi.skip !== true) {
          simulationFaite = true;
          await memoriserSimulee(url);
        }
        return envoi;
      } catch (error) {
        contactsReserves.delete(cle);
        throw error;
      } finally {
        contactInterruptible = null;
      }
    });
  }

  async function contacterAutomatiquement(url) {
    if (!contact?.envoyerContact) throw new Error('Orchestrateur de contact indisponible.');
    let resultat;
    // Un envoi annulé par Pause est retenté à la reprise ; Stop lève Annule.
    do {
      await attendreActif();
      if (!etat.contactAuto) return;
      resultat = await tenterContact(url);
    } while (resultat?.annule === true);
    if (!resultat || resultat.dedoublonne) return;
    // Blocage après le clic : il prime sur le résultat du suivi en base.
    if (resultat.bloque) {
      await enregistrer({ type: 'contact_skip', url_annonce: url, erreurCode: resultat.erreurCode });
      throw new Error('leboncoin a restreint l’accès pendant le contact.');
    }
    if (resultat.horsPrix) {
      await enregistrer({ type: 'contact_skip', url_annonce: url, erreurCode: 'prix_hors_limite' });
    } else if (resultat.simulationIgnoree) {
      await enregistrer({ type: 'contact_skip', url_annonce: url, erreurCode: 'simulation' });
    } else if (resultat.envoye === true) {
      await enregistrer({ type: 'contact_envoye', url_annonce: url });
      if (resultat.suivi !== true) throw new ResultatAbsent(resultat.error || 'Suivi du contact impossible.');
    } else if (resultat.dryRun === true && resultat.skip !== true) {
      await enregistrer({ type: 'contact_skip', url_annonce: url, erreurCode: 'simulation', simule: true });
      if (resultat.ok !== true) throw new ResultatAbsent(resultat.error);
    } else if (resultat.skip === true) {
      await enregistrer({ type: 'contact_skip', url_annonce: url, erreurCode: resultat.erreurCode });
    } else {
      throw new ResultatAbsent(resultat.error || 'Résultat de contact absent.');
    }
  }

  async function traiterDetail(url) {
    try {
      const detail = await requete('detail', async () => {
        // Réserver le budget avant la navigation : il survit à une interruption.
        await enregistrer({ type: 'avance', changements: { details_utilises: etat.details_utilises + 1 } });
        await enregistrer({ type: 'detail', url_annonce: url, statut: 'en_cours' });
        let id;
        try {
          id = await chargerOnglet(url);
          return await extraireDetailStabilise(id, url);
        } finally {
          if (id != null) await fermerOnglet(id);
        }
      }, () => etat.details_utilises < etat.maxFiches);
      if (!detail) return;
      verifierNonArrete();
      await enregistrer({ type: 'detail', url_annonce: url, statut: 'a_analyser', donnees: detail });
      await enrichirDetail(url);
      const annonceQualifiee = etat.annonces[url];
      if (etat.contactAuto && annonceQualifiee?.disqualifiee !== true
        && CLASSIFICATIONS_CONTACT_AUTO.has(annonceQualifiee?.classification)) {
        await contacterAutomatiquement(url);
      }
    } catch (error) {
      if (error?.message === 'Annonce leboncoin désactivée.') {
        await enregistrer({ type: 'detail', url_annonce: url, statut: 'introuvable_a_marquer' });
        await marquerAnnonceIntrouvable(url);
        return;
      }
      await gererErreur(error, url);
      await enregistrer({ type: 'detail', url_annonce: url, statut: 'erreur' });
    } finally { /* Les onglets de détail sont fermés dans la requête. */ }
  }

  async function marquerAnnonceIntrouvable(url) {
    for (;;) {
      try {
        const resultat = await api.marquerIntrouvable(url);
        if (resultat?.marquee !== true) {
          throw new ResultatAbsent('Annonce désactivée absente de la base locale.');
        }
        await enregistrer({
          type: 'classifiee', url_annonce: url,
          classification: 'disqualifiee', disqualifiee: true,
        });
        await enregistrer({ type: 'detail_enrichi', url_annonce: url });
        return;
      } catch (error) {
        await gererErreur(error, url, { suspendre: true });
        await attendreActif();
      }
    }
  }

  async function enrichirDetail(url) {
    for (;;) {
      try {
        await locale.push(async () => {
          await attendreActif();
          await api.upsertAnnonce(etat.annonces[url].detail_donnees);
          await attendreActif();
          const analyse = await api.classifyAnnonce(url, { force: true, settings: await lireReglages() });
          verifierNonArrete();
          await enregistrer({ ...analyse, type: 'classifiee', url_annonce: url });
          await enregistrer({ type: 'detail_enrichi', url_annonce: url });
        });
        return;
      } catch (error) {
        if (error instanceof Annule) throw error;
        // Les données de la fiche sont déjà persistées. Toute erreur serveur
        // garde ce travail en attente de reprise, y compris après récupération
        // du worker ; le drain final ne doit pas le déclarer terminé.
        await gererErreur(error, url, { suspendre: true });
        await attendreActif();
      }
    }
  }

  function aTraiter(annonce) {
    return annonce && (annonce.revision > annonce.revision_traitee
      || annonce.detail === 'a_analyser'
      || annonce.detail === 'introuvable_a_marquer'
      || (annonce.analysee && annonce.classification && annonce.classification !== 'disqualifiee'
        && !annonce.disqualifiee && !annonce.detail && etat.details_utilises < etat.maxFiches
        // Une seule annonce à la fois est admise à la file : la mieux placée.
        && meilleureCandidateDetail(etat) === annonce.url_annonce));
  }

  // Les travailleurs dont la candidature a été refusée sont sortis de la file ;
  // il faut les rappeler quand la place se libère.
  function replanifier() {
    for (const url of Object.keys(etat?.annonces ?? {})) planifierAnnonce(url);
  }

  function planifierAnnonce(url) {
    if (annoncesEnCours.has(url) || !aTraiter(etat.annonces[url])
      || !['en_cours', 'pause'].includes(etat.statut)) return;
    annoncesEnCours.add(url);
    // Un seul propriétaire par URL évite qu'un upsert de carte plus riche
    // écrase une fiche pendant son analyse. Les slots IA sont libérés pendant
    // l'attente Leboncoin ; ils ne portent jamais le cycle complet d'une URL.
    const travail = (async () => {
      while (aTraiter(etat.annonces[url])) {
        await attendreActif();
        const annonce = etat.annonces[url];
        if (annonce.revision > annonce.revision_traitee) {
          await locale.push(() => traiterAnnonce(url));
        } else if (annonce.detail === 'a_analyser') {
          await enrichirDetail(url);
          replanifier();
        } else if (annonce.detail === 'introuvable_a_marquer') {
          await marquerAnnonceIntrouvable(url);
          replanifier();
        } else {
          await traiterDetail(url);
          // Cette annonce n'est plus candidate : la suivante peut postuler.
          replanifier();
        }
      }
    })().catch(async (error) => {
      if (!(error instanceof Annule)) {
        try { await gererErreur(error, url); } catch (echec) { erreurTravail ??= echec; }
      }
    }).finally(() => {
      annoncesEnCours.delete(url);
      travaux.delete(travail);
    });
    travaux.add(travail);
    travail.catch((error) => { erreurTravail ??= error; });
  }

  async function attendreTravaux() {
    // Des émissions peuvent ajouter une révision pendant un travail en cours.
    // Le propriétaire de l'URL boucle sur cette révision avant de se libérer.
    while (travaux.size) await Promise.allSettled([...travaux]);
    if (erreurTravail) throw erreurTravail;
  }

  async function executer() {
    try {
      for (let index = etat.recherche_index; index < etat.recherches.length; index++) {
        await attendreActif();
        if (['terminee', 'termine', 'erreur'].includes(etat.recherches[index].statut)) continue;
        await enregistrer({ type: 'recherche_selectionnee', index });
        replanifier();
        let erreurRecherche = null;
        while (!etat.extraction_terminee) {
          await attendreActif();
          try {
            const page = etat.page_suivante;
            const resultat = await requete('page', async () => {
              const injecter = ongletRecherche == null;
              if (injecter) {
                const url = new URL(etat.urlRecherche);
                if (page > 1) url.searchParams.set('page', String(page));
                ongletRecherche = await chargerOnglet(url.href, { recherche: true });
              }
              const deadline = Date.now() + searchTimeoutMs;
              if (injecter) await operationRecherche(() => chrome.scripting.executeScript({
                target: { tabId: ongletRecherche }, files: ['content/extract.js'], injectImmediately: true,
              }), deadline);
              pageEnCours = page;
              const [{ result }] = await operationRecherche(() => chrome.scripting.executeScript({
                target: { tabId: ongletRecherche }, injectImmediately: true,
                func: async (options) => {
                  await window.__ps5ExtractReady;
                  return window.__ps5Extraire(options);
                },
                args: [{ page, maxPages: etat.maxPages, maxResultats: etat.maxResultats, reset: page === 1 }],
              }), deadline);
              return result;
            });
            pageEnCours = null;
            if (resultat?.bloque) throw new Error('leboncoin a restreint l’accès.');
            await attendreActif();
            if (!resultat || resultat.erreur) {
              throw new Error(resultat?.erreur?.message ?? `Extraction impossible (HTTP ${resultat?.erreur?.statut ?? '?'}).`);
            }
            await recevoirAnnonces(resultat.annonces);
            await enregistrer({ type: 'avance', changements: {
              page_suivante: page + 1,
              extraction_terminee: resultat.terminee || page >= etat.maxPages
                || etat.recherches[index].annonces_recues.length >= etat.maxResultats,
            } });
          } catch (error) {
            pageEnCours = null;
            if (error instanceof Annule || error instanceof EchecAutomatique) throw error;
            if (/leboncoin.*restreint/i.test(error.message) || error.name === 'ServerUnreachableError'
              || error instanceof StockageIndisponible || error instanceof ResultatAbsent) {
              await gererErreur(error);
            } else {
              erreurRecherche = error.message;
            }
            if (ongletRecherche != null) await fermerOnglet(ongletRecherche);
            ongletRecherche = null;
            await attendreActif();
            if (erreurRecherche) break;
          }
        }
        await attendreTravaux();
        await attendreActif();
        await enregistrer({ type: 'recherche_fin', erreur: erreurRecherche });
        if (ongletRecherche != null) await fermerOnglet(ongletRecherche);
        ongletRecherche = null;
      }
      await attendreActif();
      const message = recherchesReussies(etat) ? null : 'Toutes les recherches ont échoué.';
      await enregistrer({ type: 'termine', message });
      if (message && executionAutomatique) throw new EchecAutomatique(message);
    } catch (error) {
      await gererErreur(error);
    } finally {
      pageEnCours = null;
      try { await attendreTravaux(); } finally { await fermerTous(); }
    }
  }

  function lancer() {
    // Observer même une erreur de stockage/cleanup pour ne jamais produire une
    // promesse rejetée non gérée quand le panneau a déjà reçu son accusé.
    erreurTravail = null;
    execution = executer().finally(() => { execution = null; executionAutomatique = false; });
    execution.catch(() => {});
    return { etat, termine: execution };
  }

  return {
    async lireEtat() { await initialiser(); await ecritures; return etat; },
    demarrer(options, { automatic = false } = {}) {
      return controler(async () => {
        if (execution || etat?.statut === 'pause') throw new Error('Arrêtez le run actuel avant une nouvelle recherche.');
        etat = { ...creerEtatRun(options), automatique: automatic === true };
        executionAutomatique = automatic === true;
        contactsReserves = new Set();
        simulationFaite = false;
        requeteEffectuee = false;
        await enregistrer({ type: 'avance', changements: {} });
        return lancer();
      });
    },
    // Commande de l’utilisateur (les pauses sur erreur passent par gererErreur).
    pause() { return controler(async () => {
      if (['en_cours', 'pause'].includes(etat?.statut)) {
        await enregistrer({ type: 'pause', utilisateur: true, message: etat.erreur });
      }
    }); },
    // Autopilote décoché : un run qu’il a lancé n’envoie plus rien.
    couperContactAutomatique() { return controler(async () => {
      if (etat && etat.automatique !== false && etat.contactAuto) await enregistrer({ type: 'sans_contact' });
    }); },
    reprendre() { return controler(async () => {
      if (etat?.statut !== 'pause') throw new Error('Run non reprenable ; après un blocage, lancez un nouveau run.');
      await enregistrer({ type: 'reprise' }); signaler();
      if (execution) return { etat, termine: execution };
      const recherche = etat.recherches[etat.recherche_index];
      requeteEffectuee = etat.recherche_index > 0 || recherche.page_suivante > 1 || recherche.details_utilises > 0;
      return lancer();
    }); },
    arreter({ utilisateur = false } = {}) { return controler(async () => {
      if (etat) await enregistrer({ type: 'termine', utilisateur });
      signaler();
    }); },
    async recevoirMessage(message, sender) {
      await initialiser();
      if (sender?.tab?.id !== ongletRecherche || ongletRecherche == null || pageEnCours == null
        || !['en_cours', 'pause'].includes(etat.statut)) return;
      if (message.type === 'annonces-page' && message.page === pageEnCours) await recevoirAnnonces(message.annonces);
      if (message.type === 'leboncoin-bloque') { await enregistrer({ type: 'bloque' }); signaler(); }
      // L’erreur et la fin figurent aussi dans le résultat de la page ; le
      // retour executeScript clôt la requête avant le prochain travail.
    },
  };
}
