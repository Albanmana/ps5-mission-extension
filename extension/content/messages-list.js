// Script classique injecté sur /messages. Il ne lit que le DOM rendu et ne
// patche aucune API native de la page.
(() => {
  const SCRIPT_VERSION = 7;
  if (window.__ps5MessagesListVersion === SCRIPT_VERSION
    && window.__ps5PremiereNonLue
    && window.__ps5ChoisirCandidate
    && window.__ps5LireApercus) return;

  const UNREAD = '[data-spark-component="chip"][value="unread"]';
  const ALL = '[data-spark-component="chip"][value="all"]';
  const LINKS = 'a[href^="/messages/id/"]';
  // Seuls ces chemins sont des conversations, les seules lues et ouvertes.
  const CONVERSATION_PATH = /^\/messages\/id\/[0-9a-f-]{16,}$/i;
  // Un mot court sans chiffre (« santa ») est une ligne promotionnelle, pas un
  // identifiant.
  const PROMO_PATH = /^\/messages\/id\/[a-z_-]{1,15}$/;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const blocked = () => /accès temporairement restreint/i.test(document.body?.textContent || '');
  const login = () => /auth\.leboncoin\.fr|\/login(?:[/?#]|$)/i.test(location.href);

  function previewFromLink(link) {
    const content = [...link.querySelectorAll('p')]
      .map((node) => node.innerText || node.textContent || '')
      .map((value) => value.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const meta = link.querySelector('span');
    const seller = (meta?.innerText || meta?.textContent || '')
      .replace(/\s+-\s+(?:il y a\b.*|hier\b.*|avant-hier\b.*)$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (content.length) return [...content, seller].filter(Boolean).join(' ');
    return (link.innerText || link.textContent || '')
      .replace(/\s+-\s+(?:il y a\b.*|hier\b.*|avant-hier\b.*)$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Les autres lignes sont ignorées. `formatInconnu` : aucune conversation
  // reconnue, mais des liens qui ne sont pas des promotions.
  function lireListe(source) {
    const lignes = [];
    let inconnu = false;
    for (const link of document.querySelectorAll(LINKS)) {
      const url = new URL(link.getAttribute('href'), location.origin);
      if (url.origin === 'https://www.leboncoin.fr' && CONVERSATION_PATH.test(url.pathname)) {
        lignes.push({ url_conversation: url.href, preview: previewFromLink(link), source });
      } else if (!PROMO_PATH.test(url.pathname)) inconnu = true;
    }
    return { lignes, formatInconnu: inconnu && !lignes.length };
  }

  // Leboncoin a pu changer ses URL : mieux vaut une erreur qu’un « rien à faire ».
  // Seul « Tous » en juge : une promotion inconnue sous « Non lus » ne dit rien.
  function conversations({ lignes, formatInconnu }, inconnuSousNonLus = false) {
    if ((formatInconnu || inconnuSousNonLus) && !lignes.length) {
      throw new Error('Aucune conversation reconnue dans la liste.');
    }
    return lignes;
  }

  // La liste est triée par activité : sous un fil resté inchangé, un fil jamais
  // observé est ancien (rendu plus tard), pas nouveau.
  function candidateFromChangedLink(lignes, previousPreviews, ecarte) {
    let unchangedAbove = false;
    for (const candidate of lignes) {
      if (ecarte(candidate)) continue;
      const previous = previousPreviews?.[candidate.url_conversation];
      if (previous && previous.preview === candidate.preview) unchangedAbove = true;
      else if (previous || !unchangedAbove) return candidate;
    }
    return null;
  }

  async function selectChip(selector, timeoutMs) {
    const debut = Date.now();
    let chip = document.querySelector(selector);
    // Après un rechargement, les filtres peuvent tarder à s’afficher.
    while (!chip && Date.now() - debut < timeoutMs) {
      await wait(50);
      chip = document.querySelector(selector);
    }
    if (!chip) throw new Error('Filtre de messagerie introuvable.');
    if (chip.getAttribute('aria-pressed') === 'true') return chip;
    const list = document.querySelector('[aria-label="Liste des conversations"]');
    if (!list) throw new Error('Liste des conversations introuvable.');
    let observer;
    let timer;
    const rerendered = new Promise((resolve, reject) => {
      observer = new MutationObserver(() => {
        clearTimeout(timer);
        observer.disconnect();
        resolve(true);
      });
      observer.observe(list, { childList: true, subtree: true });
      timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Mise à jour du filtre de messagerie expirée.'));
      }, timeoutMs);
    });
    chip.click();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (chip.getAttribute('aria-pressed') === 'true') {
        await rerendered;
        return chip;
      }
      await wait(50);
    }
    clearTimeout(timer);
    observer.disconnect();
    throw new Error('Activation du filtre de messagerie expirée.');
  }

  window.__ps5PremiereNonLue = async function premiereNonLue({ timeoutMs = 3000 } = {}) {
    if (blocked()) throw new Error('Accès temporairement restreint par leboncoin.');
    if (login()) throw new Error('La session Leboncoin exige une nouvelle connexion.');
    await selectChip(UNREAD, timeoutMs);
    const nonLus = lireListe('unread');
    const candidate = nonLus.lignes[0];
    if (!candidate) {
      if (nonLus.formatInconnu) {
        await selectChip(ALL, timeoutMs);
        conversations(lireListe('tous'), true);
      } else window.__ps5RetablirTousLesMessages();
      return null;
    }
    return { url_conversation: candidate.url_conversation };
  };

  // ignoredPreviews : fils en échec, sautés tant que leur aperçu ne change pas.
  // L’ouverture marque un fil comme lu : ouvert puis de nouveau non lu, il porte
  // un nouveau message, même si l’aperçu est identique.
  window.__ps5ChoisirCandidate = async function choisirCandidate({
    previousPreviews = {}, excludedUrls = [], ignoredPreviews = {}, timeoutMs = 3000,
  } = {}) {
    if (blocked()) throw new Error('Accès temporairement restreint par leboncoin.');
    if (login()) throw new Error('La session Leboncoin exige une nouvelle connexion.');
    await selectChip(UNREAD, timeoutMs);
    const excluded = new Set(excludedUrls);
    const enEchec = ({ url_conversation: url, preview }) => ignoredPreviews[url]?.preview === preview;
    const nonLus = lireListe('unread');
    const unread = nonLus.lignes.find((candidate) => !excluded.has(candidate.url_conversation)
      && !(enEchec(candidate) && !ignoredPreviews[candidate.url_conversation].ouvert));
    if (unread) return unread;

    await selectChip(ALL, timeoutMs);
    return candidateFromChangedLink(
      conversations(lireListe('first_changed'), nonLus.formatInconnu), previousPreviews,
      (candidate) => excluded.has(candidate.url_conversation) || enEchec(candidate));
  };

  // Relevé fait à l’activation de l’autopilote : rien n’est ouvert. Deux
  // lectures identiques sont exigées, les lignes arrivant parfois en plusieurs fois.
  window.__ps5LireApercus = async function lireApercus({ timeoutMs = 15_000, stableMs = 500 } = {}) {
    if (blocked()) throw new Error('Accès temporairement restreint par leboncoin.');
    if (login()) throw new Error('La session Leboncoin exige une nouvelle connexion.');
    await selectChip(UNREAD, timeoutMs);
    const nonLus = new Set(lireListe('releve').lignes.map((ligne) => ligne.url_conversation));
    await selectChip(ALL, timeoutMs);
    const start = Date.now();
    let precedente = null;
    let lecture = { lignes: [], formatInconnu: false };
    while (Date.now() - start < timeoutMs) {
      lecture = lireListe('releve');
      const signature = JSON.stringify(lecture.lignes);
      if (lecture.lignes.length && signature === precedente) break;
      precedente = signature;
      await wait(stableMs);
    }
    return { lignes: conversations(lecture).map(({ url_conversation, preview }) => (
      { url_conversation, preview, non_lu: nonLus.has(url_conversation) })) };
  };

  window.__ps5RetablirTousLesMessages = function retablirTous() {
    const chip = document.querySelector(ALL);
    if (chip && chip.getAttribute('aria-pressed') !== 'true') chip.click();
  };

  window.__ps5MessagesListVersion = SCRIPT_VERSION;
  window.__ps5MessagesListReady = Promise.resolve(true);
})();
