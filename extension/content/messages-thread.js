// Lecture DOM du fil ouvert. Aucune mutation, aucune requête réseau.
(() => {
  if (window.__ps5LireConversation) return;

  const BUBBLES = '[data-qa-id="message-bubble"]';
  const blocked = () => /accès temporairement restreint/i.test(document.body?.textContent || '');

  function roleFor(bubble) {
    const classes = bubble.parentElement?.classList;
    if (classes?.contains('justify-end')) return 'moi';
    if (classes?.contains('justify-start')) return 'vendeur';
    return 'systeme';
  }

  function clean(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || null;
  }

  function absoluteLeboncoin(href, pattern) {
    if (!href) return null;
    const url = new URL(href, location.origin);
    return url.origin === 'https://www.leboncoin.fr' && pattern.test(url.pathname) ? url.href : null;
  }

  window.__ps5LireConversation = function lireConversation() {
    if (blocked()) throw new Error('Accès temporairement restreint par leboncoin.');
    const urlConversation = absoluteLeboncoin(location.href, /^\/messages\/id\/[0-9a-f-]{16,}$/i);
    if (!urlConversation) throw new Error('Aucune conversation Leboncoin ouverte.');

    const messages = [...document.querySelectorAll(BUBBLES)].map((bubble) => ({
      expediteur: roleFor(bubble),
      contenu: clean(bubble.textContent),
      envoye_le: null,
      type: roleFor(bubble) === 'systeme' ? 'notice' : 'texte',
      montant_eur: null,
      lu: true,
    })).filter((message) => message.contenu);
    if (!messages.length) throw new Error('Fil de conversation vide ou introuvable.');

    const ad = document.querySelector('a[href^="/ad/"]');
    const adText = clean(ad?.innerText || ad?.textContent) || '';
    const adLines = adText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const priceMatch = adText.replace(/[\u00a0\u202f\s]/g, '').match(/(\d+)€/);
    // Le premier lien de profil est un avatar sans texte : prendre celui qui
    // porte le nom.
    const profile = [...document.querySelectorAll('a[href^="/profile/"]')]
      .map((link) => clean(link.textContent || link.innerText))
      .find(Boolean) ?? null;
    const last = messages.at(-1);
    const latestSeller = [...messages].reverse().find((message) => message.expediteur === 'vendeur');

    return {
      url_conversation: urlConversation,
      url_annonce: absoluteLeboncoin(ad?.getAttribute('href'), /^\/ad\/[^/]+\/\d+$/),
      vendeur: profile,
      annonce_titre: adLines[0] || null,
      annonce_prix_eur: priceMatch ? Number(priceMatch[1]) : null,
      messages,
      dernier_message_vendeur: latestSeller?.contenu ?? null,
      non_lus: last?.expediteur === 'vendeur' ? 1 : 0,
    };
  };

  window.__ps5MessagesThreadReady = Promise.resolve(true);
})();
