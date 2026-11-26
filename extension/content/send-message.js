// Émission contrôlée sur /messages/id/<uuid>. Le résultat n'est confirmé que
// si une nouvelle bulle sortante contenant exactement le texte apparaît.
// Avant de taper et juste avant de cliquer, le script revérifie lui-même le
// destinataire, la pause et le mode simulation.
(() => {
  if (window.__ps5SendMessageReady) return;

  const FIELD = 'textarea[aria-label="Ecrire mon message"]';
  const SEND = 'button[aria-label="Envoyer mon message"]';
  const BUBBLES = '[data-qa-id="message-bubble"]';
  // Même clé que sw/conversation-state.js.
  const STATE_KEY = 'conversation_poller_state';

  window.__ps5SendMessageReady = Promise.all([
    import(chrome.runtime.getURL('lib/typing.js')),
    import(chrome.runtime.getURL('lib/settings.js')),
  ])
    .then(([{ typeInto, sleep, setNativeValue }, { SETTINGS_KEY, normalizeSettings }]) => {
      const blocked = () => /accès temporairement restreint/i.test(document.body?.textContent || '');
      const outgoingCount = (text) => [...document.querySelectorAll(BUBBLES)]
        .filter((bubble) => bubble.parentElement?.classList?.contains('justify-end')
          && (bubble.textContent || '').trim() === text).length;

      function onExpectedPage(expectedUrl) {
        try {
          const expected = new URL(expectedUrl);
          const actual = new URL(location.href);
          return actual.origin === expected.origin && actual.pathname === expected.pathname;
        } catch {
          return false;
        }
      }

      // Une lecture de stockage en échec lève : rien n'est alors envoyé.
      async function readGuard(pauseSeq) {
        const stored = await chrome.storage.local.get([STATE_KEY, SETTINGS_KEY]);
        const state = stored[STATE_KEY];
        return {
          paused: state?.enabled !== true || state.activationVersion !== 2
            || (pauseSeq !== undefined && (state.pauseSeq ?? 0) !== pauseSeq),
          dryRun: normalizeSettings(stored[SETTINGS_KEY]).dryRun,
        };
      }

      const refused = (erreurCode) => ({ ok: false, clique: false, confirme: false, erreurCode });

      async function waitElement(selector, timeoutMs, accept = () => true) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const node = document.querySelector(selector);
          if (node && accept(node)) return node;
          await sleep(50);
        }
        return null;
      }

      window.__ps5EnvoyerMessage = async function envoyerMessage(text, {
        expectedUrl, dryRun, pauseSeq, timeoutMs = 10_000,
      } = {}) {
        if (typeof text !== 'string' || !text.trim()) throw new Error('Message non vide requis.');
        const exact = text.trim();
        if (blocked()) throw new Error('Accès temporairement restreint : aucun message envoyé.');
        if (!onExpectedPage(expectedUrl)) return refused('mauvaise_conversation');
        const field = await waitElement(FIELD, timeoutMs);
        if (!field) return refused('formulaire_absent');

        const initial = await readGuard(pauseSeq);
        if (initial.paused) return refused('interrompu');
        if (!onExpectedPage(expectedUrl)) return refused('mauvaise_conversation');
        let simulation = dryRun === true || initial.dryRun;

        const clearField = () => {
          setNativeValue(field, '');
          field.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const abort = (erreurCode) => { clearField(); return refused(erreurCode); };

        const before = outgoingCount(exact);
        field.focus();
        clearField();
        const wrongPage = new Error('mauvaise_conversation');
        try {
          await typeInto(field, exact, {
            sleep: async (ms) => {
              await sleep(ms);
              if (!onExpectedPage(expectedUrl)) throw wrongPage;
            },
          });
        } catch (error) {
          if (error === wrongPage) return abort('mauvaise_conversation');
          throw error;
        }
        let button = null;
        if (!simulation) {
          button = await waitElement(SEND, timeoutMs, (node) => node.disabled !== true);
          if (!button) return refused('formulaire_absent');
        }

        const last = await readGuard(pauseSeq);
        // Plus aucune attente entre ces contrôles et le clic.
        if (last.paused) return abort('interrompu');
        if (!onExpectedPage(expectedUrl)) return abort('mauvaise_conversation');
        simulation ||= last.dryRun;
        if (simulation) return { ok: true, clique: false, dryRun: true };
        if (blocked()) throw new Error('Accès temporairement restreint : aucun message envoyé.');
        const liveButton = document.querySelector(SEND);
        if (document.querySelector(FIELD) !== field || field.value !== exact
          || !liveButton || liveButton.disabled === true) return refused('formulaire_absent');

        liveButton.click();
        try {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            if (outgoingCount(exact) > before) return { ok: true, clique: true, confirme: true };
            await sleep(100);
          }
        } catch { /* après le clic, le résultat ne peut être qu'incertain */ }
        return { ok: false, clique: true, confirme: false, erreurCode: 'envoi_incertain' };
      };
    });
})();
