import assert from 'node:assert/strict';
import test from 'node:test';

import { findPriceLikeNumbers } from '../scripts/lib/price-guard.js';
import {
  buildHandoffEmail, buildNegotiationMessages, createHandoffNotifier, createNegotiationServer,
  derivePriceContext, requestNegotiation, sendHandoffEmail, validateDraftPricePolicy,
} from '../scripts/negotiate-server.js';
import { computeClassification } from '../scripts/classify.js';
import { chargerShortlist } from '../scripts/lib/annonces.js';
import { request } from './helpers/http.js';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const PRICES = { goodPrice: 200, maxPrice: 230 };
const conversation = { id: 'c1', messages: [], annonce: { titre: 'PS5', prix_eur: 300 } };

test('la classification suit goodPrice et maxPrice', () => {
  const classe = (prix_eur) => computeClassification({ prix_eur, lecteur_disque: true, manettes_incluses: 1 }, PRICES).classification;
  assert.deepEqual([200, 201, 230, 231].map(classe), ['saint_graal', 'interessant', 'interessant', 'a_verifier']);
});

test('la négociation dérive ouverture, plafond et dernière offre des réglages', () => {
  const at = (offre, message) => derivePriceContext({ ...conversation, offre_envoyee_eur: offre }, message, PRICES);
  assert.equal(at(null, 'Oui').targetOffer, 190);
  assert.equal(at(190, 'Je reste à 260').targetOffer, 200);
  assert.deepEqual([at(200, 'Je reste à 240').ceiling, at(200, 'Je reste à 280').ceiling], [230, 230]);
  assert.deepEqual([at(200, 'Je reste à 239').ceiling, at(200, 'Je reste à 281').ceiling, at(190, 'Je reste à 260').ceiling], [200, 200, 200]);
});

test('le prompt reflète les prix et le prénom, sans valeurs figées', () => {
  const [{ content }] = buildNegotiationMessages(conversation, 'Oui', undefined, { ...PRICES, ownerName: 'Sam' });
  assert.doesNotMatch(content, /\b(?:330|340|350|370|400)\b/);
  assert.match(content, /ouvrir à 190, puis monter à 200/);
  assert.match(content, /230 dernier prix/);
  assert.match(content, /Sam reprend la main/);
  assert.match(buildNegotiationMessages(conversation, 'Oui')[0].content, /l'utilisateur reprend la main/);
});

test('les nombres ressemblant à un prix sont repérés, pas les modèles, stockages, années ou heures', () => {
  const ok = 'PS5 825 Go de 2023, modèle CFI 1216A ou 1216B, PS 5, le 1er, 4K, 1To ou 1000go, 120 Hz, dispo à 18h30 ou 18:45 le 12/05/2025\nje peux faire 340';
  assert.deepEqual(findPriceLikeNumbers(ok).filter((n) => n > 350), []);
  for (const [text, value] of [['400 c’est trop', 400], ['je mets 400e', 400], ['400€', 400], ['2000 euros', 2000],
    ['1 000 max', 1000], ['jusqu’à 1.200', 1200], ['allez 380.', 380], ['350,50 ok', 350.5], ['PS5 450', 450], ['je mets 400max', 400], ['ok à400', 400], ['2023€', 2023], ['ok pour 390C', 390], ['ok 360h', 360], ['ok pour 380k', 380]]) {
    assert.ok(findPriceLikeNumbers(text).includes(value), text);
  }
});

test('le plafond s’applique à tout nombre du message, même sans offre_proposee_eur', () => {
  const context = { ceiling: 350, targetOffer: 340, conflict: false, sellerMessagePrice: null };
  const draft = { message: 'je peux aller à 390 ça vous va ?', offre_proposee_eur: null, arret: { doit_arreter: false } };
  assert.throws(() => validateDraftPricePolicy(draft, context), /plafond 350/);
  assert.throws(() => validateDraftPricePolicy({ ...draft, message: '340 ou 360 ?', offre_proposee_eur: 340 }, context), /plafond 350/);
});

test('requestNegotiation refait un essai puis refuse un message au-dessus du plafond configuré', async () => {
  let calls = 0;
  await assert.rejects(requestNegotiation({
    conversation, messageVendeur: 'Oui', apiKey: 'test', settings: PRICES,
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        message: 'je peux faire 210', offre_proposee_eur: null, offre_recue_eur: null, lieu_propose: null,
        arret: { doit_arreter: false, raison: null }, notes_internes: '',
      }) } }] });
    },
  }), /plafond 200/);
  assert.equal(calls, 2);
});

test('l’arrêt paiement hors plateforme cite le prénom configuré ou un repli neutre', async () => {
  const risky = { messages: [{ expediteur: 'vendeur', contenu: 'Payez par virement' }] };
  const run = (settings) => requestNegotiation({ conversation: risky, messageVendeur: 'x', apiKey: 'k', settings });
  assert.match((await run({ ownerName: 'Sam' })).notes_internes, /Sam reprend la main/);
  assert.match((await run(undefined)).notes_internes, /L'utilisateur reprend la main/);
});

const handoff = { arret: { doit_arreter: true, raison: 'refus_categorique_prix' }, notes_internes: 'n',
  offre_proposee_eur: null, offre_recue_eur: null, lieu_propose: null };
const body = { conversation_id: 'c1', message_vendeur: 'non', handoff };

test('le sujet de handoff utilise le prix maximal configuré', () => {
  assert.match(buildHandoffEmail({ conversation, handoff, messageVendeur: 'non', settings: PRICES }).subject, /Ne pas dépasser 230 €/);
});

test('sans clé ou sans destinataire le handoff répond notified:false sans appel réseau', async () => {
  for (const options of [{ apiKey: '', fallbackRecipient: 'a@example.com' }, { apiKey: 'k' }]) {
    const server = createNegotiationServer({
      loadConversation: async () => conversation,
      notifyHandoff: createHandoffNotifier({ ...options, sendEmail: async () => assert.fail('aucun envoi') }),
    });
    const response = await request(server, '/api/handoff', { method: 'POST', body });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { notified: false, reason: 'email_non_configure' });
  }
});

test('le destinataire des réglages n’est cru que depuis l’origine extension', async () => {
  const sent = [];
  const server = createNegotiationServer({
    extensionOrigin: EXTENSION, loadConversation: async () => conversation,
    notifyHandoff: createHandoffNotifier({ apiKey: 'k', fallbackRecipient: 'env@example.com',
      sendEmail: async ({ to }) => { sent.push(to); return { id: 'e1' }; } }),
  });
  for (const [origin, handoffEmail] of [[EXTENSION, 'user@example.com'], [undefined, 'attaquant@example.com'],
    ['http://127.0.0.1:8835', 'attaquant@example.com']]) {
    const response = await request(server, '/api/handoff', { method: 'POST', origin, body: { ...body, settings: { handoffEmail } } });
    assert.deepEqual(await response.json(), { notified: true, email_id: 'e1' });
  }
  assert.deepEqual(sent, ['user@example.com', 'env@example.com', 'env@example.com']);
});

test('depuis l’extension, un e-mail vide dans les réglages n’envoie rien, même avec HANDOFF_EMAIL', async () => {
  const server = createNegotiationServer({
    extensionOrigin: EXTENSION, loadConversation: async () => conversation,
    notifyHandoff: createHandoffNotifier({ apiKey: 'k', fallbackRecipient: 'env@example.com',
      sendEmail: async () => assert.fail('aucun envoi') }),
  });
  for (const settings of [{ handoffEmail: '' }, undefined]) {
    const response = await request(server, '/api/handoff', { method: 'POST', origin: EXTENSION, body: { ...body, settings } });
    assert.deepEqual(await response.json(), { notified: false, reason: 'email_non_configure' });
  }
});

test('la clé d’idempotence Resend est stable au rejeu et change avec le destinataire', async () => {
  const keys = [];
  for (const to of ['a@example.com', 'a@example.com', 'b@example.com']) {
    await sendHandoffEmail({ conversation, handoff, messageVendeur: 'non', apiKey: 'k', to,
      fetchImpl: async (_url, options) => { keys.push(options.headers['Idempotency-Key']); return Response.json({ id: 'x' }); } });
  }
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
});

test('la route classify transmet les réglages normalisés', async () => {
  const seen = [];
  const server = createNegotiationServer({ classifyAnnonce: async (_url, options) => { seen.push(options); return {}; } });
  for (const settings of [PRICES, undefined, { goodPrice: 900, maxPrice: 100 }]) {
    await request(server, '/api/annonces/classify', { method: 'POST', body: { url_annonce: 'https://www.leboncoin.fr/ad/consoles/1', force: false, settings } });
  }
  assert.deepEqual(seen.map(({ settings }) => [settings.goodPrice, settings.maxPrice]), [[200, 230], [350, 370], [350, 370]]);
});

test('la question sur l’envoi répartie sur deux bulles n’est pas supprimée', async () => {
  const result = await requestNegotiation({
    conversation: { messages: [], annonce: { titre: 'PS5', prix_eur: 300 } }, messageVendeur: 'Oui', apiKey: 'k',
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({
      message: 'ok pour 300\npar paiement leboncoin\navec envoi ça vous va ?', offre_proposee_eur: 300,
      offre_recue_eur: null, lieu_propose: null, arret: { doit_arreter: false, raison: null }, notes_internes: '',
    }) } }] }),
  });
  assert.equal(result.message, 'ok pour 300\npar paiement leboncoin\navec envoi ça vous va ?');
});

test('un montant déjà proposé reste autorisé, sans jamais dépasser maxPrice', () => {
  const at = (offre, message, prices = PRICES) => derivePriceContext({ ...conversation, offre_envoyee_eur: offre }, message, prices);
  for (const message of ['Alors ?', 'Je reste à 300', 'dernier prix 235']) {
    assert.deepEqual([at(230, message).ceiling, at(230, message).targetOffer], [230, 230], message);
  }
  assert.doesNotThrow(() => validateDraftPricePolicy(
    { message: '230 dernier prix', offre_proposee_eur: 230, arret: { doit_arreter: false } }, at(230, 'Alors ?'),
  ));
  // Le vendeur descend sous notre offre : on ne propose pas plus que sa demande.
  assert.equal(at(230, 'ok je peux faire 220').targetOffer, 220);
  assert.equal(at(230, 'je peux faire 180').targetOffer, 180);
  // maxPrice baissé depuis l’offre : l’ancien montant n’est plus autorisé.
  assert.equal(at(260, 'Alors ?').ceiling, 230);
  assert.equal(at(190, 'Alors ?').ceiling, 200);
});

test('un montant d’achat passé n’est pas le prix demandé et ne déclenche pas la dernière offre', () => {
  const at = (message) => derivePriceContext({ ...conversation, offre_envoyee_eur: 200 }, message, PRICES);
  for (const message of ['je l’ai achetée 250€', "je l'ai payée 260 euros en janvier", 'achetée au prix de 250']) {
    assert.deepEqual([at(message).sellerMessagePrice, at(message).ceiling], [null, 200], message);
  }
  assert.equal(at("je l'ai achetée 550€, je vous la fais à 250€").sellerMessagePrice, 250);
  assert.equal(at('vous pouvez payer 250€ ?').sellerMessagePrice, 250);
  // Le vendeur accepte le maximum déjà proposé : l’offre n’est pas retirée.
  for (const message of ['ok pour 230€', 'ok pour 230', 'ça marche']) {
    assert.equal(derivePriceContext({ ...conversation, offre_envoyee_eur: 230 }, message, PRICES).ceiling, 230);
  }
  // Un nombre nu sans mot de prix n’a jamais été pris pour un prix.
  assert.equal(at('je l’ai depuis 250 jours').sellerMessagePrice, null);
});

test('la shortlist reçoit le prix maximal courant et le lie à la requête SQL', async () => {
  const calls = [];
  const server = createNegotiationServer({ chargerShortlist: async (options) => { calls.push(options); return []; } });
  for (const query of ['?prix_max=300', '', '?prix_max=abc']) {
    await request(server, `/api/annonces/shortlist${query}`);
  }
  assert.deepEqual(calls.map((options) => options.prixMax), [300, 370, 370]);
  const queries = [];
  await chargerShortlist({ query: async (...args) => { queries.push(args); return { rows: [] }; } }, { limite: 5, prixMax: 300 });
  assert.match(queries[0][0], /prix_eur <= \$2/);
  assert.deepEqual(queries[0][1], [5, 300]);
});

test('un prix demandé au présent est bien le prix du vendeur', () => {
  const at = (message) => derivePriceContext({ ...conversation, offre_envoyee_eur: 200 }, message, PRICES);
  for (const message of ['elle coûte 250 €', 'elle coute 250€', 'ça vous coûtera 250 €', 'tu me payes 250€ et elle est à toi',
    'elle est comme neuve elle coûte 250 €', 'comme neuve elle coûte 250 €']) {
    assert.equal(at(message).sellerMessagePrice, 250, message);
  }
  for (const message of ['elle m’a coûté 250 €', 'elle m’a coute 250€', 'elle m’a bien coûté 250 €', 'neuve elle coûtait 250 €',
    'elles coûtaient 250€ à la sortie', 'neuve elle coûte 250 €', 'en magasin elle coûte 250€', 'le coût était de 250€',
    'je l’ai achetee 250€', 'j’ai paye 250€', 'je l’ai acheté 250€']) {
    assert.equal(at(message).sellerMessagePrice, null, message);
  }
});

const draftFetch = (message, offre = 340) => async () => Response.json({ choices: [{ message: { content: JSON.stringify({
  message, offre_proposee_eur: offre, offre_recue_eur: null, lieu_propose: null,
  arret: { doit_arreter: false, raison: null }, notes_internes: '',
}) } }] });

test('« ça vous va ? » n’est retiré que si la phrase restante est complète', async () => {
  const run = async (message) => (await requestNegotiation({
    conversation: { messages: [], annonce: { titre: 'PS5', prix_eur: 400 } }, messageVendeur: 'Oui', apiKey: 'k',
    fetchImpl: draftFetch(message),
  })).message.split('\n').slice(0, -1).join('\n');
  for (const [message, attendu] of [['340 ça vous va ?', '340'], ['je peux faire 340, ça vous va ?', 'je peux faire 340'],
    ['je peux faire 340 maximum ça vous va ?', 'je peux faire 340 maximum'], ['je peux faire 340\nça vous va ?', 'je peux faire 340']]) {
    assert.equal(await run(message), attendu, message);
  }
  for (const message of ['je peux faire 340 si ça vous va ?', 'si je vous propose 340 ça vous va ?',
    'je peux faire 340 et venir vite si ça vous va ?', 'est ce que 340 ça vous va ?', '340 livraison comprise ça vous va ?',
    'je peux faire 340 parce que ça vous va ?', 'avec 340 en tout ça vous va ?', 'ok pour 340 puisque ça vous va ?', 'je peux faire 340 si\nça vous va ?']) {
    assert.equal(await run(message), message, message);
  }
});

const sansOffre = (message) => ({ message, offre_proposee_eur: null, arret: { doit_arreter: false } });

test('une question seule sur un défaut passe sans offre même si le vendeur a donné un prix', () => {
  const context = derivePriceContext(conversation, 'le joystick dérive un peu, je la fais à 280€', PRICES);
  for (const message of ['ça vous a déjà posé quoi comme problème ?', 'ça bloque quoi concrètement ?',
    'depuis quand ça marche plus ?', 'qu’est ce qui ne marche pas exactement ?']) {
    assert.doesNotThrow(() => validateDraftPricePolicy(sansOffre(message), context), message);
  }
  for (const message of [
    'ok ça marche', 'ok ça marche ?', 'ça marche', 'ok c’est quoi le souci ?', 'ça bloque quoi ?\nok je prends',
    'je la prends, c’est quoi le souci ?', 'c’est bon pour moi ça bloque quoi ?', 'ça bloque quoi concrètement',
    'ça bloque quoi ? je prends', 'parfait ça bloque quoi ?', 'ça vous va ?', 'on fait comme ça ?',
    'comment je peux la récupérer ?', 'quelle est votre adresse ?', 'quel est votre dernier prix ?',
    'comment vous faites pour la remise ?', 'quel jour vous arrange ?', 'quelle heure vous convient ?', 'quel est votre rib ?',
    'pourquoi pas ?', 'c’est quoi la suite ?', 'comment ça se passe pour la vente ?', 'c’est quoi votre mail ?',
    'nickel ça bloque quoi ?', 'c’est quoi le souci pour la remise ?',
    'ça bloque quoi pour 190 ?', 'ça bloque quoi pour 280 ?', 'par paiement leboncoin avec envoi ça vous va ?',
  ]) {
    assert.throws(() => validateDraftPricePolicy(sansOffre(message), context), /cible|plafond/, message);
  }
});

test('une acceptation sans montant ne part pas quand le prix du vendeur dépasse le plafond', () => {
  // Aucun prix dans le message ni conflit : seul le prix de l’annonce vaut.
  const context = derivePriceContext(conversation, 'alors ?', PRICES);
  for (const message of ['ok ça marche', 'ça marche', 'd’accord', 'je la prends', 'ça me va', 'pourquoi pas', 'vendu', 'oui', 'OK']) {
    assert.throws(() => validateDraftPricePolicy(sansOffre(message), context), /plafond 200, sans le citer/, message);
  }
  for (const message of ['elle est toujours dispo ?', 'depuis quand ça marche plus ?']) {
    assert.doesNotThrow(() => validateDraftPricePolicy(sansOffre(message), context), message);
  }
  const abordable = derivePriceContext({ ...conversation, annonce: { prix_eur: 180 } }, 'alors ?', PRICES);
  assert.doesNotThrow(() => validateDraftPricePolicy(sansOffre('ok ça marche'), abordable));
});

test('le nouvel essai après une acceptation sans montant dit quoi corriger', async () => {
  const requests = [];
  await assert.rejects(requestNegotiation({
    conversation, messageVendeur: 'alors ?', apiKey: 'k', settings: PRICES,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).messages);
      return draftFetch('ok ça marche', null)();
    },
  }), /accepte le prix du vendeur/);
  assert.equal(requests.length, 2);
  assert.match(requests[1].at(-1).content, /n'accepte pas le prix du vendeur/);
});

test('vendeur dans le plafond : la seule question d’envoi, sans montant, peut partir', () => {
  const question = {
    message: 'par paiement leboncoin avec envoi ça vous va ?', offre_proposee_eur: null,
    arret: { doit_arreter: false, raison: null },
  };
  const dansLePlafond = { ceiling: 350, targetOffer: 340, sellerMessagePrice: 340, effectiveSellerPrice: 340, conflict: true };
  assert.doesNotThrow(() => validateDraftPricePolicy(question, dansLePlafond));
  // Au-dessus du plafond, la cible reste obligatoire.
  const auDessus = { ceiling: 350, targetOffer: 340, sellerMessagePrice: 380, effectiveSellerPrice: 380, conflict: false };
  assert.throws(() => validateDraftPricePolicy(question, auDessus), /cible 340/);
});
