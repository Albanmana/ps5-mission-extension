import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../extension/content/messages-thread.js', import.meta.url), 'utf8');

function element({ text = '', href = null, parentClass = '' } = {}) {
  return {
    textContent: text,
    innerText: text,
    parentElement: { classList: { contains: (value) => parentClass.split(' ').includes(value) } },
    getAttribute: (name) => name === 'href' ? href : null,
  };
}

function inject({ latestMine = false, seller = 'VendeurAlpha', avatarFirst = false } = {}) {
  const bubbles = [
    element({ text: 'Bonjour', parentClass: 'flex justify-end' }),
    element({ text: 'Oui disponible', parentClass: 'flex justify-start' }),
    ...(latestMine ? [element({ text: 'ok pour 280', parentClass: 'flex justify-end' })] : []),
  ];
  const ad = element({ text: 'PS5 Slim\n280 €', href: '/ad/consoles/1000000002' });
  const profile = seller ? element({ text: seller, href: '/profile/uuid' }) : null;
  // Page réelle : un premier lien de profil sans texte (avatar) précède le nom.
  const profiles = [...(avatarFirst ? [element({ text: '', href: '/profile/uuid' })] : []), ...(profile ? [profile] : [])];
  const document = {
    body: { textContent: 'Conversation' },
    querySelectorAll(selector) {
      if (selector === 'a[href^="/profile/"]') return profiles;
      return selector === '[data-qa-id="message-bubble"]' ? bubbles : [];
    },
    querySelector(selector) {
      if (selector === 'a[href^="/ad/"]') return ad;
      if (selector === 'a[href^="/profile/"]') return profiles[0] ?? null;
      return null;
    },
  };
  const context = vm.createContext({ window: {}, document, URL, location: {
    href: 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101',
    origin: 'https://www.leboncoin.fr', pathname: '/messages/id/00000000-0000-4000-8000-000000000101',
  } });
  new vm.Script(source).runInContext(context);
  return context.window;
}

test('normalise le fil, l’annonce et le dernier message vendeur depuis le DOM réel', () => {
  const result = inject().__ps5LireConversation();
  assert.equal(result.url_conversation, 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101');
  assert.equal(result.url_annonce, 'https://www.leboncoin.fr/ad/consoles/1000000002');
  assert.equal(result.vendeur, 'VendeurAlpha');
  assert.equal(result.annonce_titre, 'PS5 Slim');
  assert.equal(result.annonce_prix_eur, 280);
  assert.deepEqual(JSON.parse(JSON.stringify(result.messages.map((m) => [m.expediteur, m.contenu]))), [
    ['moi', 'Bonjour'], ['vendeur', 'Oui disponible'],
  ]);
  assert.equal(result.dernier_message_vendeur, 'Oui disponible');
});

test('conserve le dernier vendeur même si mon message est la dernière bulle', () => {
  const result = inject({ latestMine: true, seller: null }).__ps5LireConversation();
  assert.equal(result.vendeur, null);
  assert.equal(result.dernier_message_vendeur, 'Oui disponible');
  assert.equal(result.messages.at(-1).expediteur, 'moi');
});

test('refuse une page sans conversation ou une page anti-bot', () => {
  const context = vm.createContext({ window: {}, document: { body: { textContent: 'Accès temporairement restreint' } }, URL, location: { href: 'https://www.leboncoin.fr/messages/id/uuid', pathname: '/messages/id/uuid', origin: 'https://www.leboncoin.fr' } });
  new vm.Script(source).runInContext(context);
  assert.throws(() => context.window.__ps5LireConversation(), /restreint/i);
});

test('lit le nom du vendeur quand le premier lien de profil est un avatar sans texte', () => {
  assert.equal(inject({ avatarFirst: true }).__ps5LireConversation().vendeur, 'VendeurAlpha');
});
