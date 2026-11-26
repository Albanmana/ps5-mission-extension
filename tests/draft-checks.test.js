import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNegotiationMessages, derivePriceContext, requestNegotiation, validateDraftPricePolicy,
} from '../scripts/negotiate-server.js';

const PRICES = { goodPrice: 350, maxPrice: 370 };
const conv = (prix = 400, offre = null) => ({
  messages: [], offre_envoyee_eur: offre, annonce: { titre: 'PS5', prix_eur: prix },
});
const context = (seller, prix = 400, offre = null) => derivePriceContext(conv(prix, offre), seller, PRICES);
const draft = (message, offre = null, extra = {}) => ({
  message, offre_proposee_eur: offre, offre_recue_eur: null, lieu_propose: null,
  arret: { doit_arreter: false, raison: null }, notes_internes: '', ...extra,
});

// Le modèle répond tour à tour avec les brouillons donnés, le dernier se répète.
async function negotiate({ drafts, seller = 'alors ?', prix = 400, offre = null }) {
  const requests = [];
  const result = await requestNegotiation({
    conversation: conv(prix, offre), messageVendeur: seller, apiKey: 'k', settings: PRICES,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).messages);
      const next = drafts[Math.min(requests.length, drafts.length) - 1];
      return Response.json({ choices: [{ message: { content: JSON.stringify(next) } }] });
    },
  });
  return { result, requests };
}

test('un prix du neuf ou un achat passé n’est jamais le prix demandé', () => {
  for (const message of [
    'elle coûte 400€ neuve', 'ça coûte 400€ neuf en magasin', 'la même coûte 400€ en magasin',
    'elle coûte 550€ à la fnac', 'achete 400€ il y a 6 mois', 'console achete 400€ en 2023',
    'je l’ai bien achete 400€', 'je l’ai pas paye 400€ pour rien', 'j’ai tout juste paye 400€',
    'je viens de l’acheter 400€', 'elle m’avait vraiment coute 400€', 'ça m’a vite coute 400€', 'neuve à 400€',
  ]) {
    const ctx = context(message, 380, 350);
    assert.deepEqual([ctx.sellerMessagePrice, ctx.ceiling], [null, 350], message);
  }
});

test('le prix lié à la vente l’emporte et la cible ne dépasse pas la demande', () => {
  for (const message of [
    'elle coûte 550€ neuve, je vous la laisse 300€', 'achete 550€ il y a un an, je vous la laisse 300€',
    'je l’ai payée 550€ je la vends 300€', '320€ avec les jeux ou 300€ sans',
  ]) {
    const ctx = context(message, 300);
    assert.deepEqual([ctx.sellerMessagePrice, ctx.targetOffer], [300, 300], message);
  }
});

test('les prix actuels écrits sans tournure prévue sont lus', () => {
  for (const message of [
    'état neuf elle coûte 380€', 'comme neuve elle coûte 380€', 'port payé 380€', 'envoi payé 380€',
    'le coût total avec envoi c’est 380€', '380 dernier prix', 'je la laisse à 380', 'le prix est de 380',
    'je vous la fais à 380', 'je peux vous la faire à 380', '380 pas moins', '380 et elle est à vous', 'ok pour 380', '380',
  ]) {
    assert.equal(context(message).sellerMessagePrice, 380, message);
  }
  assert.equal(context('je l’ai depuis 250 jours').sellerMessagePrice, null);
});

const ENVOI = 'par paiement leboncoin avec envoi ça vous va ?';

test('une formulation inconnue part telle quelle, sans nouvel essai ni reprise', async () => {
  for (const [message, offre, options, attendu = offre == null ? message : `${message}\n${ENVOI}`] of [
    ['salut, la console est toujours là ?', null, {}],
    ['vous l’avez achetée où et elle a encore la facture ?', null, {}],
    ['super merci je regarde ça et je reviens vers vous', null, {}],
    [`d’accord, ${ENVOI}`, null, { prix: 300 }],
    ['ok ça marche', null, { prix: 300 }],
    ['je vous en donne 340 et on n’en parle plus', 340, {}],
    ['allez 340 et je prends direct', 340, {}],
    ['je peux faire 340 par contre il me faut la boîte', 340, {}],
    ['je peux faire 340', 340, { seller: 'le joystick dérive un peu' }],
    ['ah mince, le drift vous gêne pour combien de parties ?', null, { seller: 'le joystick dérive un peu' }],
    [`pas grave pour la rayure\n${ENVOI}`, null, { seller: 'il y a une petite rayure' }],
  ]) {
    const { result, requests } = await negotiate({ ...options, drafts: [draft(message, offre)] });
    assert.equal(result.arret.doit_arreter, false, message);
    assert.equal(result.message, attendu, message);
    assert.equal(requests.length, 1, message);
  }
});

test('une acceptation claire sans montant au-dessus du plafond est refaite puis échoue', async () => {
  await assert.rejects(negotiate({ drafts: [draft('ok ça marche')], seller: 'je descends pas' }), /accepte le prix du vendeur/);
  // Le vendeur cite son prix : la cible manquante est signalée en premier.
  for (const seller of ['état neuf elle coûte 380€', 'port payé 380€']) {
    await assert.rejects(negotiate({ drafts: [draft('ok ça marche')], seller }), /cible 340/, seller);
  }
  const { result, requests } = await negotiate({ drafts: [draft('ok ça marche'), draft('je peux faire 340', 340)] });
  assert.match(result.message, /^je peux faire 340/);
  assert.equal(requests.length, 2);
});

test('un montant au-dessus du plafond ne part jamais, même annoncé autrement', async () => {
  await assert.rejects(negotiate({ drafts: [draft('je peux faire 340 voire 360', 340)] }), /plafond 350/);
  await assert.rejects(negotiate({ drafts: [draft('je peux faire 360', 360)] }), /plafond 350/);
  await assert.rejects(negotiate({ drafts: [draft('je peux faire un geste', 340)] }), /ne contient pas l'offre 340/);
});

test('une offre au-dessus d’un montant écarté comme prix du neuf est refaite puis échoue', async () => {
  for (const seller of ['elle est neuve elle coûte 300€', 'neuve sous blister à 300€']) {
    await assert.rejects(negotiate({ seller, drafts: [draft('je peux faire 340', 340)] }),
      /prix le plus bas cité par le vendeur \(300\)/, seller);
    const { result, requests } = await negotiate({
      seller, drafts: [draft('je peux faire 340', 340), draft('je peux faire 300', 300)],
    });
    assert.match(result.message, /^je peux faire 300/, seller);
    assert.match(requests[1].at(-1).content, /au-delà de 300/);
  }
});

test('retirer « ça vous va ? » ne produit ni fragment ni question devenue affirmation', async () => {
  for (const message of [
    'et 340 ça vous va ?', 'vous accepteriez 340 ?', 'est ce que 340 ça vous va ?', 'entre 330 et 340 ça vous va ?',
    'je vous la prends à 340 ça vous va ?', 'je peux faire 340 à condition que ça vous va ?',
    'je peux faire 340 ce soir ça vous va ?', 'vous accepteriez 340 ça vous va ?',
  ]) {
    const { result } = await negotiate({ drafts: [draft(message, 340)] });
    assert.equal(result.message, `${message}\n${ENVOI}`, message);
  }
  const { result } = await negotiate({ drafts: [draft('je peux faire 340 ça vous va ? 🙂', 340)] });
  assert.match(result.message, /^je peux faire 340/);
});

test('le prompt n’impose aucune liste de formes', () => {
  const [{ content }] = buildNegotiationMessages(conv(), 'alors ?', undefined, PRICES);
  assert.doesNotMatch(content, /Formes autorisées|sans relecture|brouillon est écarté/);
  assert.match(content, /Pas d'anglicisme business[\s\S]*Va droit à l'information utile[^\n]*\n\nSécurité :/);
});
