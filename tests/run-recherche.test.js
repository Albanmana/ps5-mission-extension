import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRecherche } from '../extension/sw/run-recherche.js';
import { creerEtatRun as creerEtatRunMulti, compteurs } from '../extension/sw/run-state.js';

// Les scénarios historiques de reprise exercent la migration d'un état sans recherches[].
function creerEtatRun(options) {
  const etat = creerEtatRunMulti(options);
  delete etat.recherches;
  delete etat.urlsRecherche;
  delete etat.recherche_index;
  return etat;
}

const A = 'https://www.leboncoin.fr/ad/consoles/1';
const B = 'https://www.leboncoin.fr/ad/consoles/2';
const options = { urlRecherche: 'https://www.leboncoin.fr/recherche?text=ps5', maxPages: 3, maxResultats: 100, force: false };
const multiOptions = { ...options, urlsRecherche: [options.urlRecherche, 'https://www.leboncoin.fr/recherche?text=playstation'] };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('Événement attendu absent'); }
function detailBrut(url) {
  return {
    href: url,
    nextData: JSON.stringify({ props: { pageProps: { ad: {
      url, subject: 'PS5 complète', body: 'Description complète', attributes: [], status: 'active', price: [300],
    } } } }),
    livraison: null,
  };
}

function fixture({ pages = [{ annonces: [{ url_annonce: A, titre: 'PS5' }], terminee: true }], deja = false, retenue = false, saved, classify, classification, pageHook, sleepHook,
  stayLoading = false, probe, readinessWait = tick, searchTimeoutMs,
  detailError, detailInjectionError, detailFileResultLost = false, settings, detailPrice, markUnavailable = async () => ({ marquee: true }),
  contactResult = { ok: true, envoye: true, suivi: true, tabId: 99 } } = {}) {
  let stored = saved ? structuredClone(saved) : null;
  let id = 0;
  const tabs = new Map();
  const listeners = new Set();
  const log = [], sleeps = [], upserts = [], classifications = [], removed = [], envois = [], introuvables = [];
  const autres = settings ? { ps5_settings: settings } : {};
  const chrome = {
    storage: { local: {
      get: async (cle) => (cle === 'run_recherche' || cle === undefined
        ? { run_recherche: structuredClone(stored) } : { [cle]: structuredClone(autres[cle]) }),
      set: async (valeurs) => {
        await tick();
        if ('run_recherche' in valeurs) stored = structuredClone(valeurs.run_recherche);
        else Object.assign(autres, structuredClone(valeurs));
      },
    } },
    runtime: { sendMessage: async () => { throw new Error('Panel fermé'); } },
    tabs: {
      onUpdated: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
      create: async ({ url, active }) => {
        assert.equal(active, false);
        const tab = { id: ++id, url, status: 'loading' };
        tabs.set(id, tab); log.push(['navigation', url]);
        if (!stayLoading) setImmediate(() => { tab.status = 'complete'; for (const fn of listeners) fn(tab.id, { status: 'complete' }, tab); });
        return { ...tab };
      },
      get: async (tabId) => { if (!tabs.has(tabId)) throw new Error('Onglet fermé'); return { ...tabs.get(tabId) }; },
      remove: async (tabId) => { tabs.delete(tabId); removed.push(tabId); },
    },
    scripting: { executeScript: async ({ target, files, func, args = [] }) => {
      const tab = tabs.get(target.tabId);
      if (func?.name === 'sonderPageRecherche') return [{ result: probe ? await probe(tab) : { href: tab.url, ready: true, blocked: false } }];
      if (files?.[0] === 'content/extract.js') {
        tab.window = { __ps5ExtractReady: tick().then(() => { tab.ready = true; }) };
        tab.window.__ps5Extraire = async ({ page, maxPages, maxResultats }) => {
          assert.equal(tab.ready, true, 'attendre le module de parsing');
          log.push(['page', page, maxPages, maxResultats]);
          await pageHook?.(page, target.tabId);
          return { page, total: page, ...(typeof pages === 'function' ? pages(tab.url, page) : pages[page - 1]) };
        };
        return [{}];
      }
      if (files?.[0] === 'content/extract-detail.js') {
        log.push(['detail', tab.url]);
        if (detailError) throw detailError;
        const result = { url_annonce: tab.url, titre: 'PS5 complète', description: 'Description complète' };
        if (detailFileResultLost) return [{ result: null }];
        return [{ result }];
      }
      if (func?.name === 'collecterDetailDepuisDocument') {
        log.push(['detail', tab.url]);
        if (detailError) throw detailError;
        if (detailInjectionError) return [{ result: null, error: { message: detailInjectionError } }];
        const brut = detailBrut(tab.url);
        if (detailPrice !== undefined) {
          const data = JSON.parse(brut.nextData);
          data.props.pageProps.ad.price = detailPrice;
          brut.nextData = JSON.stringify(data);
        }
        return [{ result: brut }];
      }
      return [{ result: await vm.runInNewContext(`(${func.toString()})(...args)`, { window: tab.window, args }) }];
    } },
  };
  const api = {
    upsertAnnonce: async (annonce) => { upserts.push(structuredClone(annonce)); await tick(); return { created: !deja, deja_analysee: deja }; },
    classifyAnnonce: async (url, opts) => {
      classifications.push([url, opts]);
      await classify?.(url, opts);
      const valeur = typeof classification === 'function' ? classification(url) : classification;
      if (valeur && typeof valeur === 'object') return valeur;
      if (valeur) return { classification: valeur, disqualifiee: valeur === 'disqualifiee' };
      return { classification: retenue ? 'saint_graal' : 'disqualifiee', disqualifiee: !retenue };
    },
    marquerIntrouvable: async (url) => { introuvables.push(url); return markUnavailable(url); },
  };
  const contact = { envoyerContact: async (url, texte, { signal } = {}) => {
    envois.push([url, texte]);
    return typeof contactResult === 'function' ? contactResult(url, envois.length, signal) : contactResult;
  } };
  const run = createRecherche({ chrome, api, contact, readinessWait, searchTimeoutMs, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); await sleepHook?.(ms); } });
  return { run, chrome, api, contact, log, sleeps, upserts, classifications, removed, envois, introuvables, tabs, autres, stored: () => stored };
}

test('une page exploitable avance même si Chrome la laisse loading', async () => {
  const f = fixture({ stayLoading: true });
  const { termine } = await f.run.demarrer(options);
  try { await until(() => f.stored()?.statut === 'termine'); }
  finally {
    await f.run.arreter();
    for (const tab of f.tabs.values()) tab.status = 'complete';
  }
  await termine;
  assert.equal(f.classifications.length, 1);
});

test('les injections de recherche immédiates progressent même si document_idle n’arrive jamais', async () => {
  const f = fixture({ stayLoading: true });
  const execute = f.chrome.scripting.executeScript;
  const pending = [];
  f.chrome.scripting.executeScript = (options) => options.injectImmediately
    ? execute(options)
    : new Promise((resolve) => { pending.push(() => resolve(execute(options))); });
  const { termine } = await f.run.demarrer(options);
  try {
    await until(() => f.stored()?.statut === 'termine');
    assert.equal(f.classifications.length, 1);
  } finally {
    await f.run.arreter();
    for (const resolve of pending) resolve();
    await termine;
  }
});

for (const phase of ['sonde', 'fichier', 'extraction']) {
  test(`Stop termine malgré une injection ${phase} qui ne répond jamais`, async () => {
    const f = fixture();
    const execute = f.chrome.scripting.executeScript;
    const pending = deferred();
    let entered = false;
    f.chrome.scripting.executeScript = (options) => {
      const match = phase === 'sonde' ? options.func?.name === 'sonderPageRecherche'
        : phase === 'fichier' ? Boolean(options.files)
        : Boolean(options.args);
      if (match) { entered = true; return pending.promise; }
      return execute(options);
    };
    const { termine } = await f.run.demarrer(multiOptions);
    let settled = false;
    termine.finally(() => { settled = true; });
    await until(() => entered);
    await f.run.arreter();
    try {
      await until(() => settled);
      assert.equal(f.tabs.size, 0);
      assert.equal(f.log.filter(([type]) => type === 'navigation').length, 1);
    } finally {
      pending.resolve([{ result: { ready: true, href: options.urlRecherche, terminee: true } }]);
      await termine;
    }
  });
}

test('une sonde sans réponse expire puis passe à la recherche suivante', async () => {
  // Assez large pour que la seconde recherche n’expire pas sur une machine chargée.
  const f = fixture({ searchTimeoutMs: 100 });
  const execute = f.chrome.scripting.executeScript;
  const pending = deferred();
  f.chrome.scripting.executeScript = (options) => options.func?.name === 'sonderPageRecherche'
    && f.tabs.get(options.target.tabId)?.url === multiOptions.urlsRecherche[0]
    ? pending.promise : execute(options);
  const { termine } = await f.run.demarrer(multiOptions);
  const timeout = deferred();
  const timer = setTimeout(() => timeout.resolve(false), 1000);
  try {
    assert.equal(await Promise.race([termine.then(() => true), timeout.promise]), true);
    assert.deepEqual(f.stored().recherches.map((r) => r.statut), ['erreur', 'terminee']);
    assert.match(f.stored().recherches[0].erreur, /expiré/);
  } finally {
    clearTimeout(timer);
    await f.run.arreter();
    pending.resolve([{ result: { ready: true, href: options.urlRecherche } }]);
    await termine;
  }
});

for (const status of [200, 403]) {
  for (const challenge of ['DataDome', 'Device Check']) {
    test(`la pagination HTTP ${status} ${challenge} bloque le cycle avant la deuxième URL`, async () => {
      const f = fixture();
      const execute = f.chrome.scripting.executeScript;
      const documents = new Map();
      const article = {
        querySelector: (selector) => selector === 'a[href]' ? { getAttribute: () => A } : null,
        querySelectorAll: () => [], getAttribute: () => 'PS5',
        cloneNode: () => ({ textContent: 'PS5', querySelectorAll: () => [] }),
      };
      const source = readFileSync(new URL('../extension/content/extract.js', import.meta.url), 'utf8');
      const script = new vm.Script(source, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      f.chrome.scripting.executeScript = async (injection) => {
        const id = injection.target.tabId;
        if (injection.files) {
          const context = vm.createContext({
            window: {}, location: { href: f.tabs.get(id).url }, URL,
            document: { body: { textContent: '' }, querySelectorAll: () => [article] },
            DOMParser: class { parseFromString() { return { querySelectorAll: () => [] }; } },
            chrome: { runtime: {
              getURL: (path) => new URL(`../extension/${path}`, import.meta.url).href,
              sendMessage: (message) => f.run.recevoirMessage(message, { tab: { id } }),
            } },
            fetch: async () => ({ ok: status === 200, status, text: async () => `<html><title>${challenge}</title></html>` }),
          });
          script.runInContext(context);
          documents.set(id, context);
          return [{}];
        }
        if (injection.args) {
          const context = documents.get(id);
          context.args = injection.args;
          return [{ result: await vm.runInContext(`(${injection.func.toString()})(...args)`, context) }];
        }
        return execute(injection);
      };
      await (await f.run.demarrer(multiOptions)).termine;
      assert.equal(f.stored().statut, 'bloque');
      assert.deepEqual(f.log.filter(([type]) => type === 'navigation').map(([, url]) => url), [multiOptions.urlsRecherche[0]]);
      assert.equal(f.stored().recherches[1].statut, 'en_attente');
    });
  }
}

test('les URLs sont exécutées dans l’ordre avec des limites séparées', async () => {
  const f = fixture({ retenue: true, pages: (url, page) => ({
    annonces: [{ url_annonce: `https://www.leboncoin.fr/ad/consoles/${url.includes('playstation') ? page + 10 : page}` }], terminee: false,
  }) });
  await (await f.run.demarrer({ ...multiOptions, maxPages: 2, maxResultats: 2, maxFiches: 1 })).termine;
  assert.deepEqual(f.log.filter(([type]) => type === 'page').map(([, page]) => page), [1, 2, 1, 2]);
  assert.equal(Object.keys(f.stored().annonces).length, 4);
  assert.deepEqual(f.stored().recherches.map((r) => [r.statut, r.annonces_recues.length, r.details_utilises]), [['terminee', 2, 1], ['terminee', 2, 1]]);
  assert.deepEqual(f.log.filter(([type]) => type === 'detail').map(([, url]) => url), [A, 'https://www.leboncoin.fr/ad/consoles/11']);
  const navigations = f.log.filter(([type]) => type === 'navigation').map(([, url]) => url);
  assert.ok(navigations.indexOf(multiOptions.urlsRecherche[1]) > navigations.indexOf(A));
});

test('une erreur ordinaire marque une recherche puis passe à la suivante', async () => {
  const f = fixture({ pages: (url) => url.includes('playstation')
    ? { annonces: [{ url_annonce: B }], terminee: true }
    : { erreur: { message: 'Page indisponible' } } });
  const { termine } = await f.run.demarrer(multiOptions, { automatic: true });
  await termine.catch(() => {});
  assert.equal(f.stored().statut, 'termine');
  assert.deepEqual(f.stored().recherches.map((r) => r.statut), ['erreur', 'terminee']);
  assert.equal(f.stored().recherches[0].erreur, 'Page indisponible');
  assert.equal(f.stored().annonces[B].analysee, true);
});

test('une restriction sur une recherche bloque tout le cycle', async () => {
  const f = fixture({ pages: [{ bloque: true }] });
  await (await f.run.demarrer(multiOptions)).termine;
  assert.equal(f.stored().statut, 'bloque');
  assert.deepEqual(f.log.filter(([type]) => type === 'navigation').map(([, url]) => url), [multiOptions.urlsRecherche[0]]);
  assert.equal(f.stored().recherches[1].statut, 'en_attente');
});

test('un doublon entre deux recherches est analysé et contacté au plus une fois', async () => {
  const f = fixture({ retenue: true });
  await (await f.run.demarrer({ ...multiOptions, contactAuto: true })).termine;
  assert.deepEqual(f.stored().recherches.map((r) => r.annonces_recues), [[A], [A]]);
  assert.equal(f.classifications.length, 2, 'une analyse carte et une analyse enrichie globales');
  assert.equal(f.envois.length, 1);
});

test('une reprise repart de la recherche et de la page persistées', async () => {
  const saved = creerEtatRunMulti(multiOptions);
  saved.recherche_index = 1;
  saved.recherches[0].statut = 'terminee';
  saved.recherches[1].statut = 'en_cours';
  saved.recherches[1].page_suivante = 2;
  const f = fixture({ saved, pages: [null, { annonces: [{ url_annonce: B }], terminee: true }] });
  await f.run.lireEtat();
  await (await f.run.reprendre()).termine;
  assert.deepEqual(f.log.filter(([type]) => type === 'page').map(([, page]) => page), [2]);
  assert.equal(f.log[0][1], `${multiOptions.urlsRecherche[1]}&page=2`);
  assert.equal(f.stored().recherches[1].statut, 'terminee');
  assert.deepEqual(f.sleeps, [4500], 'la reprise conserve la cadence malgré un curseur global périmé');
});

test('chaque URL applique son plafond aux cartes reçues sans plafond global', async () => {
  const f = fixture({ pages: (url) => ({ annonces: url.includes('playstation')
    ? [{ url_annonce: B }, { url_annonce: A }]
    : [{ url_annonce: A }, { url_annonce: B }], terminee: false }) });
  await (await f.run.demarrer({ ...multiOptions, maxResultats: 1 })).termine;
  assert.deepEqual(f.stored().recherches.map((r) => r.annonces_recues), [[A], [B]]);
  assert.equal(f.classifications.length, 2);
  assert.deepEqual(f.log.filter(([type]) => type === 'page').map(([, page]) => page), [1, 1]);
});

test('deux recherches du même vendeur gardent une seule réservation de contact globale', async () => {
  const f = fixture({ retenue: true, pages: (url) => ({ annonces: [{
    url_annonce: url.includes('playstation') ? B : A, vendeur: 'Console Shop',
  }], terminee: true }) });
  await (await f.run.demarrer({ ...multiOptions, contactAuto: true })).termine;
  assert.equal(f.envois.length, 1);
  assert.equal(f.stored().recherches[1].details_utilises, 1);
});

test('une attente de contenu bornée échoue localement sans utiliser la cadence réseau', async () => {
  let probes = 0;
  const f = fixture({ probe: (tab) => {
    probes++;
    return { href: tab.url, ready: false, blocked: false };
  } });
  await (await f.run.demarrer(options)).termine;
  assert.equal(probes, 60);
  assert.equal(f.stored().recherches[0].statut, 'erreur');
  assert.match(f.stored().recherches[0].erreur, /expiré/);
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.tabs.size, 0);
});

test('Pause suspend les sondes puis Reprendre continue dans le même onglet', async () => {
  const wait = deferred();
  let probes = 0;
  const f = fixture({ probe: (tab) => ({ href: tab.url, ready: ++probes > 1 }), readinessWait: () => wait.promise });
  const { termine } = await f.run.demarrer(options);
  await until(() => probes === 1);
  await f.run.pause();
  wait.resolve();
  await tick(); await tick();
  assert.equal(probes, 1);
  await f.run.reprendre();
  await termine;
  assert.equal(probes, 2);
  assert.equal(f.log.filter(([type]) => type === 'navigation').length, 1);
});

test('Stop pendant une attente de contenu empêche toute extraction et ferme l’onglet', async () => {
  const wait = deferred();
  let probes = 0;
  const f = fixture({ probe: (tab) => { probes++; return { href: tab.url, ready: false }; }, readinessWait: () => wait.promise });
  const { termine } = await f.run.demarrer(options);
  await until(() => probes === 1);
  await f.run.arreter();
  wait.resolve();
  await termine;
  assert.equal(probes, 1);
  assert.equal(f.log.some(([type]) => type === 'page'), false);
  assert.equal(f.tabs.size, 0);
});

test('une restriction détectée dans le DOM interdit même une page prête et bloque les URLs suivantes', async () => {
  const f = fixture({ probe: (tab) => ({ href: tab.url, ready: true, blocked: true }) });
  await (await f.run.demarrer(multiOptions)).termine;
  assert.equal(f.stored().statut, 'bloque');
  assert.equal(f.log.filter(([type]) => type === 'navigation').length, 1);
  assert.equal(f.log.some(([type]) => type === 'page'), false);
});

test('une redirection hors recherche échoue localement avant toute extraction', async () => {
  const f = fixture({ probe: (tab) => ({ href: tab.url.includes('playstation') ? tab.url : 'https://www.leboncoin.fr/login', ready: true }) });
  await (await f.run.demarrer(multiOptions)).termine;
  assert.deepEqual(f.stored().recherches.map((r) => r.statut), ['erreur', 'terminee']);
  assert.match(f.stored().recherches[0].erreur, /inattendue/);
  assert.equal(f.log.filter(([type]) => type === 'page').length, 1);
});

test('une panne partagée du serveur suspend le cycle sans ouvrir la deuxième recherche', async () => {
  const f = fixture({ classify: async () => {
    const error = new Error('Serveur indisponible');
    error.name = 'ServerUnreachableError';
    throw error;
  } });
  await assert.rejects((await f.run.demarrer(multiOptions, { automatic: true })).termine, /Serveur indisponible/);
  assert.equal(f.stored().statut, 'pause');
  assert.equal(f.stored().recherches[1].statut, 'en_attente');
  assert.equal(f.log.some(([type, url]) => type === 'navigation' && url === multiOptions.urlsRecherche[1]), false);
});

test('une panne de persistance suspend le cycle au lieu de sauter à la recherche suivante', async () => {
  const f = fixture();
  const set = f.chrome.storage.local.set;
  let failed = false;
  f.chrome.storage.local.set = async (payload) => {
    if (!failed && payload.run_recherche.page_suivante === 2) {
      failed = true;
      throw new Error('Stockage indisponible');
    }
    return set(payload);
  };
  const { termine } = await f.run.demarrer(multiOptions, { automatic: true });
  let settled = false;
  termine.then(() => { settled = true; }, () => { settled = true; });
  await until(() => f.stored()?.statut === 'pause');
  try { await until(() => settled); }
  finally { if (!settled) await f.run.arreter(); }
  await assert.rejects(termine, /Stockage indisponible/);
  assert.equal(f.stored().statut, 'pause');
  assert.equal(f.stored().recherches[1].statut, 'en_attente');
  assert.equal(f.log.some(([type, url]) => type === 'navigation' && url === multiOptions.urlsRecherche[1]), false);
});

test('toutes les recherches en erreur rejettent la tentative automatique après la dernière URL', async () => {
  const f = fixture({ pages: [{ erreur: { message: 'Page indisponible' } }] });
  await assert.rejects((await f.run.demarrer(multiOptions, { automatic: true })).termine, /recherche|indisponible/i);
  assert.deepEqual(f.stored().recherches.map((r) => r.statut), ['erreur', 'erreur']);
  assert.equal(f.tabs.size, 0);
});

test('les pages et détails utilisent une seule file avec un seul délai adapté et une classification enrichie forcée', async () => {
  const f = fixture({ retenue: true, pages: [
    { annonces: [{ url_annonce: A }], terminee: false },
    { annonces: [{ url_annonce: B }], terminee: true },
  ] });
  const { termine } = await f.run.demarrer(options);
  await termine;
  const requetes = f.log.filter(([type]) => type !== 'navigation');
  assert.deepEqual(requetes.filter(([type]) => type === 'page').map(([, page]) => page), [1, 2]);
  assert.deepEqual(requetes.filter(([type]) => type === 'detail').map(([, url]) => url).sort(), [A, B]);
  assert.deepEqual(f.sleeps, requetes.slice(1).map(([type]) => type === 'detail' ? 15000 : 4500));
  for (const url of [A, B]) assert.deepEqual(f.classifications.filter(([annonce]) => annonce === url).map(([, opts]) => opts.force), [false, true]);
  assert.equal(f.tabs.size, 0);
  assert.equal(f.stored().statut, 'termine');
  assert.deepEqual(compteurs(f.stored()), { recues: 2, en_base: 2, analysees: 2, retenues: 2, erreurs: 0 });
});

test('extrait la fiche en un seul appel même si une injection par fichier perdrait son résultat', async () => {
  const f = fixture({ retenue: true, detailFileResultLost: true });
  await (await f.run.demarrer(options)).termine;
  assert.equal(f.stored().annonces[A].detail_donnees.description, 'Description complète');
  assert.equal(f.stored().annonces[A].erreur, null);
});

test('conserve l’erreur réelle renvoyée dans InjectionResult au lieu de la masquer', async () => {
  const f = fixture({ retenue: true, detailInjectionError: 'Erreur réelle du document.' });
  await (await f.run.demarrer(options)).termine;
  assert.equal(f.stored().annonces[A].erreur, 'Erreur réelle du document.');
});

test('les émissions et le retour de page se dédupliquent, les données plus riches sont ré-upsertées', async () => {
  const f = fixture({ pages: [
    { annonces: [{ url_annonce: A, titre: 'PS5' }], terminee: false },
    { annonces: [{ url_annonce: A, titre: 'PS5', prix_eur: 300 }], terminee: true },
  ], pageHook: async (page, tabId) => {
    if (page === 1) await f.run.recevoirMessage({ type: 'annonces-page', page, annonces: [{ url_annonce: A, titre: 'PS5' }] }, { tab: { id: tabId } });
  } });
  await (await f.run.demarrer(options)).termine;
  assert.equal(f.upserts.length, 2);
  assert.equal(f.upserts[1].prix_eur, 300);
  assert.equal(compteurs(f.stored()).recues, 1);
  assert.equal(f.classifications.length, 1);
});

test('force est lu du run ; une annonce déjà analysée est uniquement upsertée par défaut', async () => {
  for (const force of [false, true]) {
    const f = fixture({ deja: true });
    await (await f.run.demarrer({ ...options, force })).termine;
    assert.equal(f.upserts.length, 1);
    assert.equal(f.classifications.length, force ? 1 : 0);
    if (force) assert.equal(f.classifications[0][1].force, true);
  }
});

test('stop pendant le délai empêche la requête suivante et ferme tous les onglets', async () => {
  const attente = deferred();
  const f = fixture({ pages: [{ annonces: [], terminee: false }, { annonces: [], terminee: true }], sleepHook: () => attente.promise });
  const { termine } = await f.run.demarrer(options);
  await until(() => f.sleeps.length > 0);
  await f.run.arreter();
  attente.resolve();
  await termine;
  assert.equal(f.log.filter(([type]) => type === 'page').length, 1);
  assert.equal(f.tabs.size, 0);
  assert.equal(f.stored().statut, 'termine');
});

test('pause gèle les prochaines opérations et reprise reprend sans doubler le délai', async () => {
  const attente = deferred();
  const f = fixture({ pages: [{ annonces: [], terminee: false }, { annonces: [], terminee: true }], sleepHook: () => attente.promise });
  const { termine } = await f.run.demarrer(options);
  await until(() => f.sleeps.length > 0);
  await f.run.pause(); attente.resolve(); await tick(); await tick();
  assert.equal(f.log.filter(([type]) => type === 'page').length, 1);
  await f.run.reprendre(); await termine;
  assert.deepEqual(f.sleeps, [4500]);
  assert.equal(f.stored().statut, 'termine');
});

test('un blocage arrête les requêtes et ne peut pas être repris automatiquement', async () => {
  const f = fixture({ pages: [{ annonces: [], terminee: true, bloque: true }] });
  await (await f.run.demarrer(options)).termine;
  assert.equal(f.stored().statut, 'bloque');
  assert.equal(f.tabs.size, 0);
  await assert.rejects(f.run.reprendre(), /bloqu|nouveau/i);
});

test('les messages provenant d’un autre onglet sont ignorés', async () => {
  const f = fixture();
  await (await f.run.demarrer(options)).termine;
  await f.run.recevoirMessage({ type: 'annonces-page', page: 1, annonces: [{ url_annonce: B }] }, { tab: { id: 999 } });
  await f.run.recevoirMessage({ type: 'leboncoin-bloque' }, { tab: { id: 999 } });
  assert.equal(f.stored().statut, 'termine');
  assert.equal(compteurs(f.stored()).recues, 1);
});

test('les appels IA ont une concurrence au plus trois et le plafond de résultats est appliqué', async () => {
  let active = 0, peak = 0;
  const attente = deferred();
  const f = fixture({ pages: [{ annonces: Array.from({ length: 8 }, (_, i) => ({ url_annonce: `https://www.leboncoin.fr/ad/consoles/${i + 1}` })), terminee: true }], classify: async () => {
    active++; peak = Math.max(peak, active); await attente.promise; active--;
  } });
  const { termine } = await f.run.demarrer({ ...options, maxResultats: 5 });
  await until(() => peak === 3); attente.resolve(); await termine;
  assert.equal(peak, 3);
  assert.equal(f.classifications.length, 5);
  assert.equal(compteurs(f.stored()).recues, 5);
});

test('le plafond de cinquante détails persiste dans le run', async () => {
  const f = fixture({ retenue: true, pages: [{ annonces: Array.from({ length: 52 }, (_, i) => ({ url_annonce: `https://www.leboncoin.fr/ad/consoles/${i + 1}` })), terminee: true }] });
  await (await f.run.demarrer(options)).termine;
  assert.equal(f.log.filter(([type]) => type === 'detail').length, 50);
  assert.equal(f.stored().details_utilises, 50);
});

test('un service worker redémarré récupère l’état en pause et reprend les lignes en attente', async () => {
  const saved = creerEtatRun(options);
  saved.page_suivante = 2; saved.onglets = [77];
  saved.annonces[A] = { url_annonce: A, titre: 'PS5', donnees: { url_annonce: A, titre: 'PS5' }, revision: 1, revision_traitee: 0, etat: 'recue' };
  const f = fixture({ saved, pages: [null, { annonces: [], terminee: true }] });
  assert.equal((await f.run.lireEtat()).statut, 'pause');
  assert.deepEqual(f.removed, [77]);
  await (await f.run.reprendre()).termine;
  assert.equal(f.upserts.length, 1);
  assert.deepEqual(f.log.filter(([type]) => type === 'page').map(([, page]) => page), [2]);
  assert.equal(f.stored().statut, 'termine');
});

test('pause puis reprise réveillent tous les traitements IA suspendus', async () => {
  const f = fixture({ pages: [{ annonces: [1, 2, 3].map((i) => ({ url_annonce: `https://www.leboncoin.fr/ad/consoles/${i}` })), terminee: true }] });
  const attente = deferred();
  const upsert = f.api.upsertAnnonce;
  f.api.upsertAnnonce = async (a) => { const resultat = await upsert(a); await attente.promise; return resultat; };
  const { termine } = await f.run.demarrer(options);
  await until(() => f.upserts.length === 3);
  await f.run.pause(); attente.resolve();
  await tick(); await tick(); await tick(); await tick();
  await f.run.reprendre();
  await until(() => f.stored().statut === 'termine');
  await termine;
  assert.equal(f.classifications.length, 3);
});

test('stop attend les appels déjà partis avant d’autoriser un nouveau run et ignore leurs résultats tardifs', async () => {
  const attente = deferred();
  const f = fixture({ classify: () => attente.promise });
  const { termine } = await f.run.demarrer(options);
  await until(() => f.classifications.length === 1);
  await f.run.arreter();
  await assert.rejects(f.run.demarrer(options), /actuel/);
  attente.resolve(); await termine;
  assert.equal(f.stored().annonces[A].analysee, false);
});

test('une panne du serveur pendant le détail reprend l’enrichissement sans nouvelle navigation', async () => {
  const f = fixture({ retenue: true });
  const upsert = f.api.upsertAnnonce;
  let echec = true;
  f.api.upsertAnnonce = async (annonce) => {
    if (annonce.description && echec) { echec = false; const error = new Error('Serveur indisponible'); error.name = 'ServerUnreachableError'; throw error; }
    return upsert(annonce);
  };
  const { termine } = await f.run.demarrer(options);
  await until(() => f.stored().statut === 'pause');
  await f.run.reprendre(); await termine;
  assert.equal(f.stored().annonces[A].etat, 'enrichie');
  assert.equal(f.log.filter(([type]) => type === 'detail').length, 1);
});

test('une panne automatique termine la tentative au lieu d’attendre une reprise manuelle', async () => {
  const f = fixture({ classify: async () => {
    const error = new Error('Serveur indisponible');
    error.name = 'ServerUnreachableError';
    throw error;
  } });
  const { termine } = await f.run.demarrer(options, { automatic: true });
  await assert.rejects(termine, /Serveur indisponible/);
  assert.equal(f.stored().statut, 'pause');
  assert.equal(f.tabs.size, 0);
});

// Les erreurs ordinaires de page sont désormais propres à une recherche.

test('un blocage lors de la fiche détail ferme les onglets et arrête les détails restants', async () => {
  const f = fixture({ retenue: true, pages: [{ annonces: [{ url_annonce: A }, { url_annonce: B }], terminee: true }] });
  const execute = f.chrome.scripting.executeScript;
  let details = 0;
  f.chrome.scripting.executeScript = async (args) => {
    if (args.func?.name === 'collecterDetailDepuisDocument') { details++; throw new Error('leboncoin a restreint l’accès.'); }
    return execute(args);
  };
  await (await f.run.demarrer(options)).termine;
  assert.equal(f.stored().statut, 'bloque');
  assert.equal(f.tabs.size, 0);
  assert.equal(details, 1);
});

test('une fiche DataDome transitoire se stabilise dans le même onglet avant extraction', async () => {
  const f = fixture({ retenue: true });
  const execute = f.chrome.scripting.executeScript;
  let details = 0;
  let probeAttendu = false;
  f.chrome.scripting.executeScript = async (args) => {
    if (args.func?.name === 'collecterDetailDepuisDocument') {
      details++;
      if (details === 1) {
        probeAttendu = true;
        throw new Error('__NEXT_DATA__ absent : ce n’est pas une page annonce.');
      }
    } else if (args.func && probeAttendu) {
      probeAttendu = false;
      return [{ result: { deviceCheck: true, missingNextData: true } }];
    }
    return execute(args);
  };

  await (await f.run.demarrer(options)).termine;

  assert.equal(details, 2);
  assert.equal(f.log.filter(([type, url]) => type === 'navigation' && url === A).length, 1);
  assert.equal(f.stored().annonces[A].detail, 'fait');
  assert.equal(f.stored().annonces[A].erreur, null);
  assert.equal(f.stored().statut, 'termine');
  assert.equal(f.tabs.size, 0);
});

test('une fiche DataDome se stabilise même si son erreur initiale vient de données annonce absentes', async () => {
  const f = fixture({ retenue: true });
  const execute = f.chrome.scripting.executeScript;
  let details = 0;
  let probeAttendu = false;
  f.chrome.scripting.executeScript = async (args) => {
    if (args.func?.name === 'collecterDetailDepuisDocument') {
      details++;
      if (details === 1) {
        probeAttendu = true;
        throw new Error('props.pageProps.ad absent de __NEXT_DATA__.');
      }
    } else if (args.func && probeAttendu) {
      probeAttendu = false;
      return [{ result: { deviceCheck: true, missingNextData: false } }];
    }
    return execute(args);
  };

  await (await f.run.demarrer(options)).termine;

  assert.equal(details, 2);
  assert.equal(f.stored().annonces[A].detail, 'fait');
  assert.equal(f.stored().statut, 'termine');
  assert.equal(f.tabs.size, 0);
});

test('un challenge DataDome persistant bloque le run après des tentatives bornées', async () => {
  const f = fixture({ retenue: true });
  const execute = f.chrome.scripting.executeScript;
  let details = 0;
  let probeAttendu = false;
  f.chrome.scripting.executeScript = async (args) => {
    if (args.func?.name === 'collecterDetailDepuisDocument') {
      details++;
      probeAttendu = true;
      throw new Error('__NEXT_DATA__ absent : ce n’est pas une page annonce.');
    }
    if (args.func && probeAttendu) {
      probeAttendu = false;
      return [{ result: { deviceCheck: true, missingNextData: true } }];
    }
    return execute(args);
  };

  await (await f.run.demarrer(options)).termine;

  assert.ok(details > 1);
  assert.ok(details <= 6);
  assert.equal(f.stored().statut, 'bloque');
  assert.match(f.stored().erreur, /restreint/i);
  assert.equal(f.tabs.size, 0);
});

test('un ancien challenge résolu ne transforme pas une page ordinaire malformée en blocage', async () => {
  const f = fixture({ retenue: true });
  const execute = f.chrome.scripting.executeScript;
  let details = 0;
  let probeAttendu = false;
  f.chrome.scripting.executeScript = async (args) => {
    if (args.func?.name === 'collecterDetailDepuisDocument') {
      details++;
      probeAttendu = true;
      throw new Error('__NEXT_DATA__ absent : ce n’est pas une page annonce.');
    }
    if (args.func && probeAttendu) {
      probeAttendu = false;
      return [{ result: { deviceCheck: details === 1, missingNextData: true } }];
    }
    return execute(args);
  };

  await (await f.run.demarrer(options)).termine;

  assert.ok(details > 1);
  assert.equal(f.stored().statut, 'termine');
  assert.equal(f.stored().annonces[A].detail, 'erreur');
  assert.match(f.stored().annonces[A].erreur, /__NEXT_DATA__/i);
  assert.equal(f.tabs.size, 0);
});

test('une fiche canonique inattendue échoue immédiatement sans être réessayée', async () => {
  const f = fixture({ retenue: true });
  const execute = f.chrome.scripting.executeScript;
  let details = 0;
  f.chrome.scripting.executeScript = async (args) => {
    if (args.func?.name === 'collecterDetailDepuisDocument') {
      details++;
      return [{ result: detailBrut(B) }];
    }
    return execute(args);
  };

  await (await f.run.demarrer(options)).termine;

  assert.equal(details, 1);
  assert.equal(f.stored().annonces[A].detail, 'erreur');
  assert.match(f.stored().annonces[A].erreur, /inattendue/i);
  assert.equal(f.stored().statut, 'termine');
  assert.equal(f.tabs.size, 0);
});

test('une fiche canonique inattendue reste terminale même si le DOM mentionne device check', async () => {
  const f = fixture({ retenue: true });
  const execute = f.chrome.scripting.executeScript;
  let details = 0;
  let probeAttendu = false;
  f.chrome.scripting.executeScript = async (args) => {
    if (args.func?.name === 'collecterDetailDepuisDocument') {
      details++;
      probeAttendu = true;
      return [{ result: detailBrut(details === 1 ? B : A) }];
    }
    if (args.func && probeAttendu) {
      probeAttendu = false;
      return [{ result: { deviceCheck: true, missingNextData: false } }];
    }
    return execute(args);
  };

  await (await f.run.demarrer(options)).termine;

  assert.equal(details, 1);
  assert.equal(f.stored().annonces[A].detail, 'erreur');
  assert.match(f.stored().annonces[A].erreur, /inattendue/i);
  assert.equal(f.stored().statut, 'termine');
  assert.equal(f.tabs.size, 0);
});

test('Stop pendant la stabilisation interdit toute nouvelle tentative détail', async () => {
  let f;
  f = fixture({ retenue: true, sleepHook: async (ms) => {
    if (ms === 1500) await f.run.arreter();
  } });
  const execute = f.chrome.scripting.executeScript;
  let details = 0;
  let probeAttendu = false;
  f.chrome.scripting.executeScript = async (args) => {
    if (args.func?.name === 'collecterDetailDepuisDocument') {
      details++;
      probeAttendu = true;
      throw new Error('__NEXT_DATA__ absent : ce n’est pas une page annonce.');
    }
    if (args.func && probeAttendu) {
      probeAttendu = false;
      return [{ result: { deviceCheck: true, missingNextData: true } }];
    }
    return execute(args);
  };

  await (await f.run.demarrer(options)).termine;

  assert.equal(details, 1);
  assert.equal(f.stored().statut, 'termine');
  assert.equal(f.tabs.size, 0);
});

test('Pause suspend la stabilisation puis Reprendre continue dans le même onglet', async () => {
  let f;
  let pauseDemandee = false;
  f = fixture({ retenue: true, sleepHook: async (ms) => {
    if (ms === 1500 && !pauseDemandee) {
      pauseDemandee = true;
      await f.run.pause();
    }
  } });
  const execute = f.chrome.scripting.executeScript;
  let details = 0;
  let probeAttendu = false;
  f.chrome.scripting.executeScript = async (args) => {
    if (args.func?.name === 'collecterDetailDepuisDocument') {
      details++;
      if (details === 1) {
        probeAttendu = true;
        throw new Error('__NEXT_DATA__ absent : ce n’est pas une page annonce.');
      }
    } else if (args.func && probeAttendu) {
      probeAttendu = false;
      return [{ result: { deviceCheck: true, missingNextData: true } }];
    }
    return execute(args);
  };

  const { termine } = await f.run.demarrer(options);
  await until(() => f.stored().statut === 'pause');
  assert.equal(details, 1);
  assert.equal(f.tabs.size, 2);
  await f.run.reprendre();
  await termine;

  assert.equal(details, 2);
  assert.equal(f.log.filter(([type, url]) => type === 'navigation' && url === A).length, 1);
  assert.equal(f.stored().annonces[A].detail, 'fait');
  assert.equal(f.stored().statut, 'termine');
  assert.equal(f.tabs.size, 0);
});

test('une fiche explicitement désactivée est retirée de la shortlist sans devenir une erreur du run', async () => {
  const f = fixture({
    retenue: true,
    detailError: new Error('Annonce leboncoin désactivée.'),
  });
  await (await f.run.demarrer({ ...options, contactAuto: true })).termine;
  assert.deepEqual(f.introuvables, [A]);
  assert.equal(f.envois.length, 0);
  assert.equal(f.stored().annonces[A].classification, 'disqualifiee');
  assert.equal(f.stored().annonces[A].disqualifiee, true);
  assert.equal(f.stored().annonces[A].detail, 'fait');
  assert.equal(f.stored().annonces[A].erreur, null);
  assert.equal(f.stored().statut, 'termine');
});

test('le marquage introuvable absent ou en panne reste reprenable sans revisiter la fiche', async () => {
  let tentatives = 0;
  const f = fixture({
    retenue: true,
    detailError: new Error('Annonce leboncoin désactivée.'),
    markUnavailable: async () => (++tentatives === 1 ? { marquee: false } : { marquee: true }),
  });
  const { termine } = await f.run.demarrer(options);
  await until(() => f.stored().statut === 'pause');
  assert.equal(f.stored().annonces[A].detail, 'introuvable_a_marquer');
  assert.equal(f.log.filter(([type]) => type === 'detail').length, 1);
  await f.run.reprendre();
  await termine;
  assert.equal(tentatives, 2);
  assert.equal(f.log.filter(([type]) => type === 'detail').length, 1);
  assert.equal(f.stored().annonces[A].detail, 'fait');
  assert.equal(f.stored().annonces[A].erreur, null);
});

test('un redémarrage du worker réconcilie le marquage introuvable malgré le budget épuisé', async () => {
  const premier = fixture({
    retenue: true,
    detailError: new Error('Annonce leboncoin désactivée.'),
    markUnavailable: async () => ({ marquee: false }),
  });
  await premier.run.demarrer({ ...options, maxFiches: 1 });
  await until(() => premier.stored().statut === 'pause');
  const saved = structuredClone(premier.stored());
  assert.equal(saved.details_utilises, saved.maxFiches);
  assert.equal(saved.annonces[A].detail, 'introuvable_a_marquer');

  const reprise = fixture({ saved, retenue: true });
  assert.equal((await reprise.run.lireEtat()).statut, 'pause');
  await (await reprise.run.reprendre()).termine;
  assert.deepEqual(reprise.introuvables, [A]);
  assert.equal(reprise.log.filter(([type]) => type === 'detail').length, 0);
  assert.equal(reprise.stored().annonces[A].detail, 'fait');
  assert.equal(reprise.stored().annonces[A].disqualifiee, true);
  assert.equal(reprise.stored().statut, 'termine');
});

test('Stop reste terminal quand une erreur serveur attend sa persistance', async () => {
  const entre = deferred(), liberer = deferred();
  const f = fixture({ classify: async () => { const error = new Error('Serveur indisponible'); error.name = 'ServerUnreachableError'; throw error; } });
  const set = f.chrome.storage.local.set;
  let retenu = false;
  f.chrome.storage.local.set = async (payload) => {
    if (!retenu && payload.run_recherche.annonces[A]?.erreur) { retenu = true; entre.resolve(); await liberer.promise; }
    return set(payload);
  };
  const { termine } = await f.run.demarrer(options);
  await entre.promise;
  const stop = f.run.arreter(); await tick(); liberer.resolve(); await stop;
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(f.stored().statut, 'termine');
  await termine;
  assert.equal(f.tabs.size, 0);
});

test('Stop interdit une navigation détail après la réservation persistée du budget', async () => {
  const entre = deferred(), liberer = deferred();
  const f = fixture({ retenue: true });
  const set = f.chrome.storage.local.set;
  let retenu = false;
  f.chrome.storage.local.set = async (payload) => {
    if (!retenu && payload.run_recherche.details_utilises === 1) { retenu = true; entre.resolve(); await liberer.promise; }
    return set(payload);
  };
  const { termine } = await f.run.demarrer(options);
  await entre.promise;
  const stop = f.run.arreter(); await tick(); liberer.resolve(); await stop; await termine;
  assert.equal(f.log.filter(([type, url]) => type === 'navigation' && url === A).length, 0);
  assert.equal(f.tabs.size, 0);
});

test('Pause suspend la navigation détail si elle arrive pendant la réservation persistée', async () => {
  const entre = deferred(), liberer = deferred();
  const f = fixture({ retenue: true });
  const set = f.chrome.storage.local.set;
  let retenu = false;
  f.chrome.storage.local.set = async (payload) => {
    if (!retenu && payload.run_recherche.details_utilises === 1) { retenu = true; entre.resolve(); await liberer.promise; }
    return set(payload);
  };
  const { termine } = await f.run.demarrer(options);
  await entre.promise;
  const pause = f.run.pause(); await tick(); liberer.resolve(); await pause;
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(f.log.filter(([type, url]) => type === 'navigation' && url === A).length, 0);
  await f.run.reprendre(); await termine;
  assert.equal(f.log.filter(([type, url]) => type === 'navigation' && url === A).length, 1);
});

test('la page suivante continue pendant une classification lente et le run attend tous les résultats avant de terminer', async () => {
  const attente = deferred();
  const f = fixture({ pages: [
    { annonces: [{ url_annonce: A }], terminee: false },
    { annonces: [{ url_annonce: B }], terminee: true },
  ], classify: async (url) => { if (url === A) await attente.promise; } });
  const { termine } = await f.run.demarrer(options);
  try {
    await until(() => f.classifications.some(([url]) => url === A));
    await until(() => f.log.some(([type, page]) => type === 'page' && page === 2));
    assert.equal(f.stored().statut, 'en_cours');
  } finally { attente.resolve(); await termine; }
  assert.equal(compteurs(f.stored()).analysees, 2);
  assert.equal(f.tabs.size, 0);
});

test('la reprise réconcilie l’analyse de ce run déjà écrite au serveur avant son accusé local', async () => {
  const saved = creerEtatRun(options);
  saved.extraction_terminee = true;
  saved.page_suivante = 2;
  saved.annonces[A] = {
    url_annonce: A, titre: 'PS5', donnees: { url_annonce: A, titre: 'PS5' },
    revision: 1, revision_traitee: 0, etat: 'en_base', en_base: true, analysee: false,
    analyse_demandee: true, analyse_force: false, detail: null,
  };
  const f = fixture({ saved, deja: true, retenue: true });
  const classify = f.api.classifyAnnonce;
  f.api.classifyAnnonce = async (url, opts) => ({ ...(await classify(url, opts)), saute: !opts.force });
  assert.equal((await f.run.lireEtat()).statut, 'pause');
  await (await f.run.reprendre()).termine;
  assert.deepEqual(f.classifications.map(([, opts]) => opts.force), [false, true]);
  assert.equal(f.stored().annonces[A].etat, 'enrichie');
  assert.equal(f.stored().annonces[A].revision_traitee, 1);
  assert.equal(compteurs(f.stored()).retenues, 1);
});

test('l’intention de classification de ce run est persistée avant l’appel serveur', async () => {
  const f = fixture({ classify: async () => {
    assert.equal(f.stored().annonces[A].analyse_demandee, true);
    assert.equal(f.stored().annonces[A].analyse_force, false);
  } });
  await (await f.run.demarrer(options)).termine;
  assert.equal(compteurs(f.stored()).analysees, 1);
});

test('la pagination continue pendant l’analyse enrichie d’un détail avec toutes les requêtes leboncoin sérialisées', async () => {
  const attente = deferred();
  const f = fixture({ retenue: true, pages: [
    { annonces: [{ url_annonce: A }], terminee: false },
    { annonces: [], terminee: true },
  ], pageHook: async (page, tabId) => {
    if (page === 1) {
      await f.run.recevoirMessage({ type: 'annonces-page', page, annonces: [{ url_annonce: A }] }, { tab: { id: tabId } });
      await until(() => f.stored().annonces[A].revision_traitee === 1);
      for (let i = 0; i < 5; i++) await tick();
    }
  }, classify: async (_, { force }) => { if (force) await attente.promise; } });
  let requetesActives = 0, maximum = 0;
  const execute = f.chrome.scripting.executeScript;
  f.chrome.scripting.executeScript = async (args) => {
    if (args.func?.name !== 'collecterDetailDepuisDocument' && !args.func) return execute(args);
    requetesActives++; maximum = Math.max(maximum, requetesActives);
    try { return await execute(args); } finally { requetesActives--; }
  };
  const { termine } = await f.run.demarrer(options);
  try {
    await until(() => f.classifications.some(([, opts]) => opts.force));
    await until(() => f.log.some(([type, page]) => type === 'page' && page === 2));
    assert.equal(f.stored().statut, 'en_cours');
    assert.equal(maximum, 1);
  } finally { attente.resolve(); await termine; }
  assert.equal(f.stored().annonces[A].etat, 'enrichie');
});

test('une ancienne réponse sautée sans résultat ne peut pas valider la révision en cours de reprise', async () => {
  const saved = creerEtatRun(options);
  saved.extraction_terminee = true;
  saved.annonces[A] = { url_annonce: A, donnees: { url_annonce: A }, revision: 1,
    revision_traitee: 0, en_base: true, analysee: false, analyse_demandee: true, analyse_force: false };
  const f = fixture({ saved, deja: true });
  const classify = f.api.classifyAnnonce;
  f.api.classifyAnnonce = async () => ({ url_annonce: A, saute: true });
  await f.run.lireEtat();
  const { termine } = await f.run.reprendre();
  await until(() => f.stored().statut !== 'en_cours');
  assert.equal(f.stored().statut, 'pause');
  assert.equal(f.stored().annonces[A].revision_traitee, 0);
  f.api.classifyAnnonce = classify;
  await f.run.reprendre(); await termine;
  assert.equal(f.stored().annonces[A].analysee, true);
});

test('les onglets créés avant Stop mais rendus après Stop sont encore fermés', async () => {
  const entre = deferred(), liberer = deferred();
  const f = fixture();
  const create = f.chrome.tabs.create;
  f.chrome.tabs.create = async (options) => {
    const tab = await create(options); entre.resolve(); await liberer.promise; return tab;
  };
  const { termine } = await f.run.demarrer(options);
  await entre.promise; await f.run.arreter(); liberer.resolve(); await termine;
  assert.equal(f.tabs.size, 0);
  assert.deepEqual(f.stored().onglets, []);
});

test('la reprise d’un ancien état en base conserve la décision initiale d’analyser cette annonce', async () => {
  const saved = creerEtatRun(options);
  saved.extraction_terminee = true;
  saved.annonces[A] = { url_annonce: A, donnees: { url_annonce: A }, revision: 1,
    revision_traitee: 0, etat: 'en_base', en_base: true, analysee: false, deja_analysee: false };
  const f = fixture({ saved, deja: true });
  await f.run.lireEtat();
  await (await f.run.reprendre()).termine;
  assert.equal(f.classifications.length, 1);
  assert.equal(f.stored().annonces[A].analysee, true);
});

test('un détail récupéré reste reprenable après HTTP 502 et sa reprise n’ouvre aucune nouvelle fiche', async () => {
  const saved = creerEtatRun(options);
  saved.extraction_terminee = true;
  saved.page_suivante = 2;
  saved.details_utilises = 1;
  saved.annonces[A] = {
    url_annonce: A, donnees: { url_annonce: A }, revision: 1, revision_traitee: 1,
    etat: 'classifiee', en_base: true, analysee: true, classification: 'saint_graal',
    disqualifiee: false, detail: 'a_analyser',
    detail_donnees: { url_annonce: A, description: 'Description déjà récupérée' },
  };
  let echec = true;
  const f = fixture({ saved, retenue: true, classify: async () => {
    if (echec) { echec = false; throw new Error('Serveur local: HTTP 502'); }
  } });
  assert.equal((await f.run.lireEtat()).statut, 'pause');
  const { termine } = await f.run.reprendre();
  await until(() => f.stored().statut !== 'en_cours');
  assert.equal(f.stored().statut, 'pause');
  assert.equal(f.stored().annonces[A].detail, 'a_analyser');
  assert.match(f.stored().annonces[A].erreur, /502/);
  assert.equal(f.stored().details_utilises, 1);
  await f.run.reprendre(); await termine;
  assert.equal(f.stored().annonces[A].etat, 'enrichie');
  assert.equal(f.stored().statut, 'termine');
  assert.equal(f.classifications.length, 2);
  assert.equal(f.log.filter(([type]) => type === 'navigation').length, 0);
});

// --- Envoi automatique du contact ------------------------------------------

const MESSAGE = 'Bonjour vous allez bien ? Est-ce que la PS5 est toujours disponible svp?';
const avecContact = { ...options, contactAuto: true };

test('un saint_graal voit son message envoyé par l’orchestrateur partagé', async () => {
  const f = fixture({ retenue: true });
  const { termine } = await f.run.demarrer(avecContact);
  await termine;

  assert.deepEqual(f.envois, [[A, MESSAGE]]);
  assert.equal(f.log.filter(([type, url]) => type === 'navigation' && url === A).length, 1);
  assert.equal(f.stored().annonces[A].contact_envoye, true);
});

test('une annonce interessante déclenche le message par défaut exact', async () => {
  const f = fixture({ classification: 'interessant' });
  await (await f.run.demarrer(avecContact)).termine;

  assert.deepEqual(f.envois, [[A, 'Bonjour vous allez bien ? Est-ce que la PS5 est toujours disponible svp?']]);
});

test('l’onglet de détail du saint_graal est fermé après extraction', async () => {
  const f = fixture({ retenue: true });
  const { termine } = await f.run.demarrer(avecContact);
  await termine;

  const ongletFiche = [...f.tabs.values()].find((tab) => tab.url === A);
  assert.equal(ongletFiche, undefined);
});

test('une annonce disqualifiée ne déclenche aucun contact et son onglet se ferme', async () => {
  const f = fixture({ retenue: false });
  const { termine } = await f.run.demarrer(avecContact);
  await termine;

  assert.deepEqual(f.envois, []);
  assert.equal([...f.tabs.values()].some((tab) => tab.url === A), false);
});

test('sans l’option, un saint_graal n’envoie rien et son onglet se ferme', async () => {
  const f = fixture({ retenue: true });
  const { termine } = await f.run.demarrer(options);
  await termine;

  assert.deepEqual(f.envois, []);
  assert.equal([...f.tabs.values()].some((tab) => tab.url === A), false);
});

test('une annonce non contactable est marquée comme skippée dans le run', async () => {
  const f = fixture({ retenue: true, contactResult: {
    ok: false, envoye: false, skip: true, suivi: true, erreurCode: 'reply_indisponible',
  } });
  const { termine } = await f.run.demarrer(avecContact);
  await termine;
  assert.deepEqual(f.envois, [[A, MESSAGE]]);
  assert.equal(f.stored().annonces[A].contact_skip, 'reply_indisponible');
  assert.equal(f.stored().annonces[A].contact_envoye, undefined);
});

test('une annonce a_verifier ne déclenche jamais de message automatique', async () => {
  const f = fixture({ classification: 'a_verifier' });
  await (await f.run.demarrer(avecContact)).termine;
  assert.deepEqual(f.envois, []);
});

test('un refus de réservation passe à l’annonce suivante sans contourner l’orchestrateur', async () => {
  const f = fixture({ retenue: true, pages: [{ annonces: [
    { url_annonce: A, vendeur: 'Alice' }, { url_annonce: B, vendeur: 'Bob' },
  ], terminee: true }], contactResult: (url) => url === A
    ? { ok: false, envoye: false, skip: true, dedoublonne: true, raison: 'reservation_existante' }
    : { ok: true, envoye: true, suivi: true, tabId: 99 } });
  const bypasses = [];
  for (const name of ['reserverContact', 'finaliserContact', 'libererContact', 'marquerContactee', 'marquerErreurContact']) {
    f.api[name] = async (...args) => { bypasses.push([name, ...args]); throw new Error('Persistance hors orchestrateur'); };
  }
  await (await f.run.demarrer(avecContact)).termine;
  assert.equal(f.stored().statut, 'termine');
  assert.equal(compteurs(f.stored()).erreurs, 0);
  assert.equal(f.stored().annonces[A].contact_envoye, undefined);
  assert.equal(f.stored().annonces[A].detail, 'fait');
  assert.equal(f.stored().annonces[B].contact_envoye, true);
  assert.deepEqual(f.envois, [[A, MESSAGE], [B, MESSAGE]]);
  assert.deepEqual(bypasses, []);
});

test('une annonce explicitement disqualifiée ne part pas malgré une classification intéressante', async () => {
  let appel = 0;
  const f = fixture({ classification: () => (++appel === 1
    ? { classification: 'saint_graal', disqualifiee: false }
    : { classification: 'interessant', disqualifiee: true }) });
  await (await f.run.demarrer(avecContact)).termine;
  assert.deepEqual(f.envois, []);
});

test('deux annonces qualifiées du même vendeur produisent un seul envoi confirmé', async () => {
  const f = fixture({ retenue: true, pages: [{ annonces: [
    { url_annonce: A, vendeur: ' Alice ' },
    { url_annonce: B, vendeur: 'alice' },
  ], terminee: true }] });
  await (await f.run.demarrer(avecContact)).termine;
  assert.equal(f.envois.length, 1);
});

test('un envoi incertain consomme le vendeur et empêche un second clic', async () => {
  const f = fixture({ retenue: true, pages: [{ annonces: [
    { url_annonce: A, vendeur: 'Alice' },
    { url_annonce: B, vendeur: ' alice ' },
  ], terminee: true }], contactResult: {
    ok: false, envoye: false, skip: true, suivi: true, erreurCode: 'envoi_incertain',
  } });
  await (await f.run.demarrer(avecContact)).termine;
  assert.equal(f.envois.length, 1);
});

test('une page de réponse indisponible avant le clic ne consomme pas le vendeur', async () => {
  for (const erreurCode of ['formulaire_absent', 'reply_indisponible']) {
    const f = fixture({ retenue: true, pages: [{ annonces: [
      { url_annonce: A, vendeur: 'Alice' },
      { url_annonce: B, vendeur: ' alice ' },
    ], terminee: true }], contactResult: (_url, appel) => appel === 1
      ? { ok: false, envoye: false, skip: true, suivi: true, erreurCode }
      : { ok: true, envoye: true, suivi: true, tabId: 99 } });
    await (await f.run.demarrer(avecContact)).termine;
    assert.equal(f.envois.length, 2, erreurCode);
  }
});

test('deux annonces sans vendeur restent deux contacts indépendants', async () => {
  const f = fixture({ retenue: true, pages: [{ annonces: [
    { url_annonce: A }, { url_annonce: B },
  ], terminee: true }] });
  await (await f.run.demarrer(avecContact)).termine;
  assert.deepEqual(f.envois.map(([url]) => url).sort(), [A, B]);
});

test('la reprise déduit du run persisté que le vendeur est déjà contacté', async () => {
  const saved = creerEtatRun(avecContact);
  saved.extraction_terminee = true;
  saved.details_utilises = 1;
  saved.annonces[A] = {
    url_annonce: A, donnees: { url_annonce: A, vendeur: 'Alice' }, revision: 1,
    revision_traitee: 1, etat: 'enrichie', en_base: true, analysee: true,
    classification: 'saint_graal', disqualifiee: false, detail: 'fait', contact_envoye: true,
  };
  saved.annonces[B] = {
    url_annonce: B, donnees: { url_annonce: B, vendeur: ' alice ' }, revision: 1,
    revision_traitee: 1, etat: 'classifiee', en_base: true, analysee: true,
    classification: 'interessant', disqualifiee: false, detail: null,
  };
  const f = fixture({ saved, classification: 'interessant' });
  await f.run.lireEtat();
  await (await f.run.reprendre()).termine;
  assert.deepEqual(f.envois, []);
});

const deuxVendeurs = [{ annonces: [
  { url_annonce: A, vendeur: 'Alice' }, { url_annonce: B, vendeur: 'Bob' },
], terminee: true }];

test('en mode test un seul contact est simulé par run, les autres sont ignorés', async () => {
  const f = fixture({ retenue: true, pages: deuxVendeurs, settings: { dryRun: true },
    contactResult: { ok: true, envoye: false, dryRun: true, tabId: 99 } });
  await (await f.run.demarrer(avecContact)).termine;
  assert.equal(f.envois.length, 1);
  assert.equal(f.stored().statut, 'termine');
  assert.deepEqual([A, B].map((url) => f.stored().annonces[url].contact_skip), ['simulation', 'simulation']);
  assert.deepEqual([A, B].map((url) => f.stored().annonces[url].contact_simule === true), [true, false]);
  assert.equal(f.stored().annonces[A].contact_envoye, undefined);
  assert.equal(f.removed.includes(99), false, 'l’onglet simulé reste ouvert');
});

test('un prix au-dessus du maximum actuel ou inconnu n’est jamais contacté', async () => {
  for (const [detailPrice, settings] of [[[300], { maxPrice: 280, goodPrice: 250 }], [[400], undefined], [null, undefined]]) {
    const f = fixture({ retenue: true, detailPrice, settings });
    await (await f.run.demarrer(avecContact)).termine;
    assert.deepEqual(f.envois, []);
    assert.equal(f.stored().annonces[A].contact_skip, 'prix_hors_limite');
    assert.equal(f.stored().statut, 'termine');
  }
});

test('en mode test une annonce déjà simulée ne l’est pas de nouveau au run suivant', async () => {
  const f = fixture({ retenue: true, pages: deuxVendeurs, settings: { dryRun: true },
    contactResult: { ok: true, envoye: false, dryRun: true, tabId: 99 } });
  const relancer = async () => (await f.run.demarrer({ ...avecContact, force: true })).termine;
  await relancer();
  await relancer();
  assert.deepEqual(f.envois.map(([url]) => url), [A, B], 'une nouvelle annonce par run');
  await relancer();
  assert.equal(f.envois.length, 2);
  assert.deepEqual([A, B].map((url) => f.stored().annonces[url].contact_skip), ['simulation', 'simulation']);
  f.autres.ps5_settings = { dryRun: false };
  await relancer();
  assert.ok(f.envois.length > 2, 'la mémoire de simulation ne bloque pas un envoi réel');
});

test('un blocage pendant le contact arrête le run comme bloqué', async () => {
  for (const contactResult of [
    () => { throw new Error('leboncoin a restreint l’accès pendant le contact : rien n’a été envoyé.'); },
    { ok: false, envoye: false, skip: true, suivi: true, erreurCode: 'envoi_incertain', bloque: true },
  ]) {
    const f = fixture({ retenue: true, pages: deuxVendeurs, contactResult });
    await (await f.run.demarrer(avecContact)).termine;
    assert.equal(f.stored().statut, 'bloque');
    assert.equal(f.envois.length, 1);
  }
});

test('Stop pendant un contact signale l’annulation à l’orchestrateur', async () => {
  const entre = deferred();
  let signal;
  const f = fixture({ retenue: true, contactResult: (_url, _n, recu) => {
    signal = recu;
    return new Promise((resolve) => {
      recu.addEventListener('abort', () => resolve({ ok: false, envoye: false, annule: true }));
      entre.resolve();
    });
  } });
  const { termine } = await f.run.demarrer(avecContact);
  await entre.promise;
  await f.run.arreter();
  await termine;
  assert.equal(signal.aborted, true);
  assert.equal(f.envois.length, 1);
});

test('Pause annule le contact non cliqué puis Reprendre le retente', async () => {
  const entre = deferred();
  const f = fixture({ retenue: true, contactResult: (_url, appel, signal) => appel > 1
    ? { ok: true, envoye: true, suivi: true, tabId: 99 }
    : new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, envoye: false, annule: true }));
      entre.resolve();
    }) });
  const { termine } = await f.run.demarrer(avecContact);
  await entre.promise;
  await f.run.pause();
  await tick(); await tick();
  assert.equal(f.envois.length, 1);
  await f.run.reprendre();
  await termine;
  assert.equal(f.envois.length, 2);
  assert.equal(f.stored().annonces[A].contact_envoye, true);
});

test('chaque analyse transmet les réglages normalisés au serveur', async () => {
  const f = fixture({ retenue: true });
  await (await f.run.demarrer(options)).termine;
  assert.equal(f.classifications.length, 2);
  for (const [, opts] of f.classifications) {
    assert.equal(opts.settings.dryRun, false);
    assert.equal(opts.settings.goodPrice, 350);
  }
});

function sonderAvec(document) {
  let sonde;
  const f = fixture();
  const execute = f.chrome.scripting.executeScript;
  f.chrome.scripting.executeScript = async (injection) => {
    if (injection.func?.name !== 'sonderPageRecherche') return execute(injection);
    sonde = vm.runInNewContext(`(${injection.func.toString()})()`,
      { document, location: { href: f.tabs.get(injection.target.tabId).url } });
    return [{ result: sonde }];
  };
  return f.run.demarrer(options).then(({ termine }) => termine).then(() => ({ f, sonde }));
}

const annonceDom = { querySelector: () => ({ getAttribute: () => '/ad/consoles/1' }) };
const domRecherche = ({ texte = '', visible, articles = [], iframe = false, title = '' }) => ({
  title, readyState: 'complete',
  body: { textContent: texte, ...(visible === undefined ? {} : { innerText: visible }) },
  getElementById: () => null,
  querySelector: (selector) => selector === 'article' ? articles[0] ?? null
    : iframe && selector.includes('captcha-delivery') ? {} : null,
  querySelectorAll: () => articles,
});

test('la sonde réelle ne bloque pas une page avec des annonces utilisables', async () => {
  const { f, sonde } = await sonderAvec(domRecherche({ texte: 'datadome device check', articles: [annonceDom] }));
  assert.equal(sonde.blocked, false);
  assert.equal(f.stored().statut, 'termine');
});

test('la sonde réelle bloque une vraie page de vérification', async () => {
  for (const page of [{ visible: 'Accès temporairement restreint' }, { title: 'Device Check' },
    { visible: 'Please enable JS and disable any ad blocker' }, { iframe: true }]) {
    const { f, sonde } = await sonderAvec(domRecherche(page));
    assert.equal(sonde.blocked, true);
    assert.equal(f.stored().statut, 'bloque');
  }
});

test('un blocage après le clic arrête le run même si le suivi en base a échoué', async () => {
  const f = fixture({ retenue: true, pages: deuxVendeurs, contactResult: { ok: false, envoye: false,
    skip: false, suivi: false, terminal: true, erreurCode: 'envoi_incertain', bloque: true, error: 'base indisponible' } });
  await (await f.run.demarrer(avecContact)).termine;
  assert.equal(f.stored().statut, 'bloque');
  assert.equal(f.stored().annonces[A].contact_skip, 'envoi_incertain');
  assert.equal(f.envois.length, 1);
});

test('un run enregistré avant la mise à jour perd ses automatismes', async () => {
  const saved = creerEtatRunMulti({ ...avecContact, force: true });
  delete saved.activationVersion;
  saved.statut = 'pause';
  const f = fixture({ saved });
  const etat = await f.run.lireEtat();
  assert.deepEqual([etat.contactAuto, etat.force], [false, false]);
  const recent = fixture({ saved: { ...creerEtatRunMulti(avecContact), statut: 'pause' } });
  assert.equal((await recent.run.lireEtat()).contactAuto, true);
});

test('la pause de l’utilisateur est marquée et résiste à une panne tardive', async () => {
  const entre = deferred(); const liberer = deferred();
  const f = fixture({ retenue: true, classify: async () => {
    entre.resolve(); await liberer.promise;
    throw Object.assign(new Error('Serveur indisponible'), { name: 'ServerUnreachableError' });
  } });
  const { termine } = await f.run.demarrer(avecContact, { automatic: true });
  let fini = false;
  termine.then(() => { fini = true; }, () => { fini = true; });
  await entre.promise;
  await f.run.pause();
  liberer.resolve();
  await until(() => f.stored().erreur === 'Serveur indisponible');
  for (let index = 0; index < 10; index += 1) await tick();
  assert.equal(f.stored().statut, 'pause');
  assert.equal(f.stored().pauseUtilisateur, true);
  assert.equal(fini, false, 'l’exécution attend Reprendre ou Stop au lieu d’échouer');
  await f.run.arreter({ utilisateur: true });
  await termine;
  assert.equal(f.stored().arretUtilisateur, true);
  assert.deepEqual(f.envois, []);
});

test('une pause sur erreur n’est pas une pause de l’utilisateur', async () => {
  const f = fixture({ classify: async () => {
    throw Object.assign(new Error('Serveur indisponible'), { name: 'ServerUnreachableError' });
  } });
  await assert.rejects((await f.run.demarrer(options, { automatic: true })).termine, /indisponible/);
  assert.equal(f.stored().pauseUtilisateur, false);
});

test('couper les envois interrompt le contact en attente d’un run automatique et n’en lance plus', async () => {
  const entre = deferred();
  let signal;
  const f = fixture({ retenue: true, pages: [{ annonces: [
    { url_annonce: A, vendeur: 'Alice' }, { url_annonce: B, vendeur: 'Bob' },
  ], terminee: true }], contactResult: (_url, _appel, recu) => new Promise((resolve) => {
    signal = recu;
    recu.addEventListener('abort', () => resolve({ ok: false, envoye: false, annule: true }));
    entre.resolve();
  }) });
  const { termine } = await f.run.demarrer(avecContact, { automatic: true });
  await entre.promise;
  await f.run.couperContactAutomatique();
  await termine;
  assert.equal(signal.aborted, true);
  assert.equal(f.envois.length, 1);
  assert.equal(f.stored().contactAuto, false);
  assert.equal(f.stored().statut, 'termine');
});

test('couper les envois ne change pas un run lancé à la main', async () => {
  const f = fixture({ retenue: true });
  const { termine } = await f.run.demarrer(avecContact);
  await f.run.couperContactAutomatique();
  await termine;
  assert.equal(f.envois.length, 1);
});
