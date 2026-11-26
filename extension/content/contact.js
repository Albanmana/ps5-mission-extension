// Script classique injecté dans le monde isolé Chrome sur /reply/<list_id>.
// Attendre __ps5ContactReady avant d'appeler __ps5EnvoyerContact(texte).
// Les sélecteurs aria/ID ont été vérifiés le 2026-09-26 sur une page réelle.
(() => {
  if (window.__ps5ContactReady) return;

  const FIELD_SELECTOR = 'textarea#body';
  const CLEAR_SELECTOR = 'button[aria-label="Supprimer le message"]';
  const SEND_SELECTOR = 'button[aria-label="Envoyer mon message"]';

  window.__ps5ContactReady = Promise.all([
    import(chrome.runtime.getURL('lib/typing.js')),
    import(chrome.runtime.getURL('lib/settings.js')),
  ])
    .then(([{ typeInto, sleep, randomBetween, setNativeValue }, { SETTINGS_KEY, normalizeSettings }]) => {
      async function attendreElement(selecteur, {
        timeoutMs = 5000,
        intervalMs = 100,
        accepter = () => true,
      } = {}) {
        const debut = Date.now();
        while (Date.now() - debut < timeoutMs && window.__ps5ContactAnnule !== true) {
          const element = document.querySelector(selecteur);
          if (element && accepter(element)) return element;
          await sleep(intervalMs);
        }
        return null;
      }

      // innerText ignore les scripts : une page saine mentionne DataDome dans
      // son code. Les mots génériques ne comptent que sans formulaire.
      function pageBloquee() {
        if (document.querySelector('iframe[src*="captcha-delivery.com"]')) return true;
        const texte = `${document.title ?? ''} ${document.body?.innerText ?? document.body?.textContent ?? ''}`;
        if (/accès temporairement restreint/i.test(texte)) return true;
        return !document.querySelector(FIELD_SELECTOR)
          && /datadome|device check|please enable js and disable any ad blocker/i.test(texte);
      }

      // Posé par le service worker quand Pause ou Stop arrive avant le clic.
      const annule = () => window.__ps5ContactAnnule === true;

      async function viderChamp(champ) {
        const boutonVider = document.querySelector(CLEAR_SELECTOR);
        if (boutonVider) {
          boutonVider.click();
        } else {
          setNativeValue(champ, '');
          champ.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await sleep(randomBetween(200, 500));
      }

      window.__ps5EnvoyerContact = async function envoyerContact(texte, {
        timeoutMs = 5000, dryRun = false, listId,
      } = {}) {
        if (typeof texte !== 'string' || !texte.trim()) {
          throw new Error('Message invalide : le texte doit être non vide.');
        }
        // Une exception dans un script injecté arrive comme un résultat nul
        // dans Chrome : tout échec avant le clic doit donc être structuré.
        const sansClic = (details) => ({ ok: false, clique: false, ...details });
        const cible = listId ? `/reply/${listId}` : location.pathname;
        const absent = () => (pageBloquee() ? sansClic({ bloque: true })
          : { ok: false, terminal: true, erreurCode: 'formulaire_absent' });
        let clique = false;
        try {
          if (pageBloquee()) return sansClic({ bloque: true });
          if (annule()) return sansClic({ annule: true });

          const champInitial = await attendreElement(FIELD_SELECTOR, { timeoutMs });
          if (!champInitial) return absent();
          if (annule()) return sansClic({ annule: true });
          champInitial.focus();
          await viderChamp(champInitial);

          // Le composant React peut remplacer le textarea après le clic sur
          // « Supprimer » : toujours reprendre la référence DOM courante.
          const champ = await attendreElement(FIELD_SELECTOR, { timeoutMs });
          if (!champ) return absent();
          champ.focus();
          if (champ.value) {
            setNativeValue(champ, '');
            champ.dispatchEvent(new Event('input', { bubbles: true }));
          }
          await typeInto(champ, texte, { doitArreter: annule });
          if (annule()) return sansClic({ annule: true });

          const pret = await attendreElement(SEND_SELECTOR, {
            timeoutMs,
            accepter: (bouton) => bouton.disabled !== true,
          });
          if (annule()) return sansClic({ annule: true });
          if (!pret) return absent();

          // Relu juste avant le clic. Une lecture en échec interdit le clic.
          let simulation;
          try {
            const reglages = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
            simulation = dryRun === true || normalizeSettings(reglages).dryRun;
          } catch {
            return sansClic({ error: 'Réglages illisibles : rien n’a été envoyé.' });
          }

          // Aucun await entre ces contrôles et le clic.
          if (annule()) return sansClic({ annule: true });
          if (location.origin !== 'https://www.leboncoin.fr' || location.pathname !== cible) {
            return sansClic({ error: 'La page de réponse a changé : rien n’a été envoyé.' });
          }
          if (pageBloquee()) return sansClic({ bloque: true });
          if (simulation) return { ok: true, clique: false, dryRun: true };
          const bouton = document.querySelector(SEND_SELECTOR);
          // Le formulaire existait : échec passager, pas une annonce sans formulaire.
          if (!bouton || bouton.disabled === true) {
            return sansClic({ error: 'Bouton d’envoi indisponible : rien n’a été envoyé.' });
          }
          clique = true;
          bouton.click();
          return { ok: true, clique: true };
        } catch (error) {
          if (clique) throw error;
          return sansClic({ error: `Envoi impossible, rien n’a été envoyé : ${error.message}` });
        }
      };
    });
})();
