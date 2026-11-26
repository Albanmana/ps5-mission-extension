// Script classique injecté dans le monde isolé Chrome. Aucune API native
// modifiée ; la file du service worker appelle UNE page par tâche et cadence
// les appels. Attendre __ps5ExtractReady avant __ps5Extraire(options).
(() => {
  // Réinjecter le fichier ne doit pas effacer la déduplication du parcours.
  if (window.__ps5ExtractReady) return;
  window.__ps5ExtractReady = import(chrome.runtime.getURL('lib/parse-annonce.js'))
    .then(({ parseArticleFields, normalizeImageUrl }) => {
      const blocage = /datadome|device check|accès temporairement restreint|please enable js and disable any ad blocker|captcha-delivery/i;
      // Page courante : des annonces utilisables excluent un blocage, et seul
      // le texte visible compte (innerText ignore les scripts).
      const pageCouranteBloquee = () => {
        const utilisable = Array.from(document.querySelectorAll('article'))
          .some((article) => /\/ad\//.test(article.querySelector('a[href]')?.getAttribute('href') ?? ''));
        if (utilisable) return false;
        return Boolean(document.querySelector?.('iframe[src*="captcha-delivery.com"]'))
          || blocage.test(`${document.title ?? ''} ${document.body?.innerText ?? document.body?.textContent ?? ''}`);
      };
      const vues = new Map();
      let pages = 0;
      const envoyer = (message) => chrome.runtime.sendMessage(message);
      const completeness = (entry) => Object.values(entry)
        .filter((value) => value !== null && value !== undefined && value !== false && value !== '').length;

      function parseArticle(article, baseUrl) {
        const lien = article.querySelector('a[href]');
        const href = lien?.getAttribute('href') || lien?.href;
        if (!href) return null;
        const clone = article.cloneNode(true);
        clone.querySelectorAll('style,script').forEach((node) => node.remove());
        const text = clone.textContent.replace(/\s+/g, ' ').trim();
        const imgs = Array.from(article.querySelectorAll('img'))
          .map((img) => img.currentSrc || img.getAttribute('src'))
          .filter(Boolean).map(normalizeImageUrl);
        return {
          url_annonce: new URL(href, baseUrl).href,
          vendeur: article.querySelector('[aria-label="Détails du vendeur."] span')?.textContent.trim() || null,
          titre: article.getAttribute('aria-label') || null,
          image_url: imgs.find((url) => url.includes('/images/') && !url.includes('/profile/pictures/'))
            || imgs[1] || imgs[0] || null,
          ...parseArticleFields(text),
        };
      }

      window.__ps5Extraire = async function extraire({
        page = 1, maxPages = 1, maxResultats = Infinity, reset = page === 1,
      } = {}) {
        if (!Number.isInteger(page) || page < 1 || !Number.isInteger(maxPages) || maxPages < page
          || !(maxResultats === Infinity || Number.isInteger(maxResultats) && maxResultats > 0)) {
          throw new Error('Limites d’extraction invalides.');
        }
        if (reset) { vues.clear(); pages = 0; }
        const etat = (extras) => ({ page, annonces: [], total: vues.size, terminee: true, ...extras });
        const signalerBlocage = async () => {
          await envoyer({ type: 'leboncoin-bloque' });
          return etat({ bloque: true });
        };
        if (pageCouranteBloquee()) return signalerBlocage();

        const baseUrl = new URL(location.href);
        let doc = document;
        const pageCourante = Number(baseUrl.searchParams.get('page') || 1);
        if (page !== pageCourante) {
          baseUrl.searchParams.set('page', String(page));
          try {
            const res = await fetch(baseUrl.href, { credentials: 'include' });
            const html = await res.text();
            // Les pages saines citent DataDome dans leurs scripts ; le vrai
            // défi se charge depuis captcha-delivery.com.
            const htmlBloque = /captcha-delivery\.com/i.test(html)
              || blocage.test(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' '));
            if (!res.ok) {
              if (htmlBloque) return signalerBlocage();
              await envoyer({ type: 'extraction-erreur', page, statut: res.status });
              return etat({ erreur: { statut: res.status } });
            }
            doc = new DOMParser().parseFromString(html, 'text/html');
            const pageExploitable = Boolean(doc?.getElementById?.('__NEXT_DATA__')
              || doc?.querySelectorAll?.('article')?.length);
            if (htmlBloque && !pageExploitable) return signalerBlocage();
          } catch (error) {
            await envoyer({ type: 'extraction-erreur', page, message: error.message });
            return etat({ erreur: { message: error.message } });
          }
        }

        // D'abord résoudre les doublons de cette page : ne jamais envoyer le
        // squelette si une carte complète de la même annonce est déjà présente.
        const uniques = new Map();
        for (const article of doc.querySelectorAll('article')) {
          const entry = parseArticle(article, baseUrl);
          if (!entry) continue;
          const existing = uniques.get(entry.url_annonce);
          if (!existing || completeness(entry) > completeness(existing)) uniques.set(entry.url_annonce, entry);
        }
        const annonces = [];
        for (const entry of uniques.values()) {
          const existing = vues.get(entry.url_annonce);
          if ((!existing && vues.size < maxResultats)
            || (existing && completeness(entry) > completeness(existing))) {
            vues.set(entry.url_annonce, entry);
            annonces.push(entry); // Les améliorations doivent aussi être ré-upsertées.
          }
        }
        if (uniques.size || page === 1) {
          pages++;
          await envoyer({ type: 'annonces-page', page, annonces });
        }
        const terminee = !uniques.size || page >= maxPages || vues.size >= maxResultats;
        if (terminee) await envoyer({ type: 'extraction-terminee', pages });
        return etat({ annonces, terminee });
      };
    });
})();
