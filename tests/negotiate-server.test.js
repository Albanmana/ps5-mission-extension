import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { upsertAnnonce } from '../scripts/lib/annonces.js';
import {
  NEGOTIATION_MODEL,
  buildHandoffEmail,
  buildNegotiationMessages,
  corsHeaders,
  createHandoffNotifier,
  createNegotiationServer,
  derivePriceContext,
  isAllowedOrigin,
  loadConversation,
  loadConversations,
  parseNegotiationResponse,
  renderPage,
  requestNegotiation,
  sendHandoffEmail,
  validateAnnoncePayload,
  validateClassifyRequest,
  validateContactErrorRequest,
  validateHandoffRequest,
  validateNegotiationRequest,
  validateDraftPricePolicy,
} from '../scripts/negotiate-server.js';

test('une origine locale reste autorisée', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:8835'), true);
  assert.equal(isAllowedOrigin('http://localhost:8835'), true);
  assert.equal(isAllowedOrigin('http://localhost:3000'), false);
  assert.equal(isAllowedOrigin(undefined), true);
});

test('une origine extension est autorisée si elle correspond exactement', () => {
  const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  assert.equal(isAllowedOrigin(ext, ext), true);
});

test('une autre extension est refusée', () => {
  const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  assert.equal(isAllowedOrigin('chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', ext), false);
});

test('une origine web quelconque est refusée', () => {
  assert.equal(isAllowedOrigin('https://www.leboncoin.fr'), false);
  assert.equal(isAllowedOrigin('http://evil.example'), false);
});

test('corsHeaders renvoie l\'origine demandée, jamais une étoile', () => {
  const headers = corsHeaders('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  assert.equal(headers['Access-Control-Allow-Origin'], 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  assert.notEqual(headers['Access-Control-Allow-Origin'], '*');
  assert.match(headers['Access-Control-Allow-Headers'], /content-type/i);
});

test('corsHeaders sans origine ne pose pas d\'en-tête', () => {
  assert.deepEqual(corsHeaders(undefined), {});
});

const conversation = {
  id: '11111111-1111-4111-8111-111111111111',
  vendeur: 'Camille',
  statut: 'en_attente_moi',
  offre_envoyee_eur: 340,
  offre_recue_eur: 370,
  rdv_date: null,
  rdv_lieu: null,
  messages: [
    {
      expediteur: 'moi',
      contenu: 'Salut, elle est toujours dispo ?',
      envoye_le: '2026-09-25T12:00:00.000Z',
      type: 'texte',
      montant_eur: null,
      lu: true,
    },
    {
      expediteur: 'vendeur',
      contenu: 'Oui, mais je reste à 370 €',
      envoye_le: '2026-09-25T12:05:00.000Z',
      type: 'offre',
      montant_eur: 370,
      lu: true,
    },
  ],
  annonce: {
    titre: 'PS5 Slim avec lecteur',
    prix_eur: 380,
    etat: 'Très bon état',
    description: 'Très bon état, petite rayure sur la façade',
    modes_remise: {
      main_propre: { disponible: true, lieu: 'Villeneuve-Exemple' },
      domicile: { disponible: false },
    },
    ville: 'Villeneuve-Exemple',
    code_postal: '00000',
    images: ['https://img.example/ps5.jpg'],
    image_url: null,
    url_annonce: 'https://www.leboncoin.fr/ad/consoles/123',
    livraison_possible: false,
  },
};

const validDraft = {
  message: 'Je peux monter à 350 € si ça te va\nVous faites un envoi par paiement leboncoin ?',
  offre_proposee_eur: 350,
  offre_recue_eur: 370,
  lieu_propose: null,
  arret: { doit_arreter: false, raison: null },
  notes_internes: 'Contre-offre plafond et question sur l’envoi',
};

test('price context préfère le prix PS5 libellé aux nombres techniques et au prix affiché', () => {
  const conflict = {
    ...conversation,
    offre_envoyee_eur: 300,
    annonce: {
      ...conversation.annonce,
      prix_eur: 300,
      description: 'Lot fictif 825Go. Écran 27 pouces 120Hz. Prix PS5 : 500€. Prix écran : 90€.',
    },
  };
  assert.deepEqual(derivePriceContext(conflict, 'La console est toujours disponible'), {
    listingPrice: 300,
    descriptionPrice: 500,
    sellerMessagePrice: null,
    effectiveSellerPrice: 500,
    conflict: true,
    targetOffer: 340,
    ceiling: 350,
    sellerLowestAsked: null,
  });
});

test('effective seller price donne la priorité au dernier prix vendeur', () => {
  const conflict = {
    ...conversation,
    offre_envoyee_eur: 340,
    annonce: { ...conversation.annonce, prix_eur: 300, description: 'Prix PS5 : 500€' },
  };
  assert.deepEqual(derivePriceContext(conflict, "Pour moi la PS5 est à 480"), {
    listingPrice: 300,
    descriptionPrice: 500,
    sellerMessagePrice: 480,
    effectiveSellerPrice: 480,
    conflict: true,
    targetOffer: 350,
    ceiling: 350,
    sellerLowestAsked: 480,
  });
});

test('un refus de 350 avec une contre-proposition autour de 400 déclenche 370 dernier prix', () => {
  const resisted = {
    ...conversation,
    offre_envoyee_eur: 350,
    annonce: { ...conversation.annonce, prix_eur: 400 },
  };
  assert.deepEqual(derivePriceContext(resisted, 'Je reste à 400'), {
    listingPrice: 400,
    descriptionPrice: null,
    sellerMessagePrice: 400,
    effectiveSellerPrice: 400,
    conflict: false,
    targetOffer: 370,
    ceiling: 370,
    sellerLowestAsked: 400,
  });
});

test('une première résistance autour de 400 monte seulement de 340 à 350', () => {
  const resisted = {
    ...conversation,
    offre_envoyee_eur: 340,
    annonce: { ...conversation.annonce, prix_eur: 400 },
  };
  assert.equal(derivePriceContext(resisted, 'Je reste à 400').targetOffer, 350);
  assert.equal(derivePriceContext(resisted, 'Je reste à 400').ceiling, 350);
});

test('la politique de prix impose la cible et le plafond avant tout envoi', () => {
  const priceContext = {
    listingPrice: 300,
    descriptionPrice: 500,
    sellerMessagePrice: 500,
    effectiveSellerPrice: 500,
    conflict: true,
    targetOffer: 340,
    ceiling: 350,
  };
  const targetDraft = { ...validDraft, message: 'je vais bien aussi merci\nje peux faire 340 ça vous va ?', offre_proposee_eur: 340 };
  assert.equal(validateDraftPricePolicy(targetDraft, priceContext), targetDraft);
  assert.throws(
    () => validateDraftPricePolicy({ ...targetDraft, offre_proposee_eur: 300 }, priceContext),
    /cible.*340/i,
  );
  assert.throws(
    () => validateDraftPricePolicy({ ...targetDraft, offre_proposee_eur: 360 }, priceContext),
    /plafond.*350/i,
  );
  assert.throws(
    () => validateDraftPricePolicy({ ...targetDraft, message: 'je peux faire 350 ça vous va ?' }, priceContext),
    /message.*340/i,
  );
});

test('parseNegotiationResponse accepte le contrat complet sans point d’arrêt', () => {
  assert.deepEqual(parseNegotiationResponse(JSON.stringify(validDraft)), validDraft);
});

test('parseNegotiationResponse accepte un bloc JSON et normalise une raison vide', () => {
  const text = `\`\`\`json\n${JSON.stringify({ ...validDraft, arret: { doit_arreter: false, raison: '' } })}\n\`\`\``;
  assert.deepEqual(parseNegotiationResponse(text), validDraft);
});

test('parseNegotiationResponse transforme la ponctuation du modèle en bulles conformes à la voix', () => {
  const verbose = {
    ...validDraft,
    message: "360 €, c'est un peu au-dessus... Je peux monter à 340 € sans problème. Paiement sécurisé possible ? Sinon, rendez-vous à Paris ?",
  };

  const parsed = parseNegotiationResponse(JSON.stringify(verbose));
  assert.equal(
    parsed.message,
    "360 €, c'est un peu au dessus\nJe peux monter à 340 € sans problème\nPaiement sécurisé possible ?\nSinon, rendez vous à Paris ?",
  );
  assert.equal(parsed.message.split('\n').every((line) => (line.match(/\?/g) || []).length <= 1), true);
  assert.doesNotMatch(parsed.message, /[.…—–-]/);
});

test('parseNegotiationResponse exige message null pour un point d’arrêt', () => {
  const stopped = {
    ...validDraft,
    message: null,
    offre_proposee_eur: null,
    lieu_propose: null,
    arret: { doit_arreter: true, raison: 'paiement_leboncoin_accepte' },
  };

  assert.deepEqual(parseNegotiationResponse(JSON.stringify(stopped)), stopped);
  assert.throws(
    () => parseNegotiationResponse(JSON.stringify({ ...stopped, message: 'Super merci' })),
    /message doit être null/i,
  );
});

test('parseNegotiationResponse exige toutes les propriétés du contrat JSON', () => {
  assert.throws(
    () => parseNegotiationResponse(JSON.stringify({
      message: null,
      arret: { doit_arreter: true, raison: 'defaut_majeur' },
      notes_internes: 'Lecteur cassé',
    })),
    /propriété manquante/i,
  );
});

test('parseNegotiationResponse rejette les raisons d’arrêt inconnues', () => {
  assert.throws(
    () => parseNegotiationResponse(JSON.stringify({
      ...validDraft,
      message: null,
      arret: { doit_arreter: true, raison: 'vendeur_sympa' },
    })),
    /raison d'arrêt invalide/i,
  );
});

test('requestNegotiation appelle le chat OpenRouter avec le modèle et le mode JSON attendus', async () => {
  let capturedUrl;
  let capturedOptions;
  const result = await requestNegotiation({
    conversation,
    messageVendeur: 'Je ne descends pas à moins de 370',
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validDraft) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(result, validDraft);
  assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(capturedOptions.body);
  assert.equal(NEGOTIATION_MODEL, 'openai/gpt-6-luna');
  assert.equal(body.model, 'openai/gpt-6-luna');
  assert.deepEqual(body.reasoning, { effort: 'medium' });
  assert.equal(body.max_completion_tokens, 1500);
  assert.equal('max_tokens' in body, false);
  assert.equal('temperature' in body, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[1].role, 'user');
  assert.deepEqual(JSON.parse(body.messages[1].content).price_context, {
    listingPrice: 380,
    descriptionPrice: null,
    sellerMessagePrice: 370,
    effectiveSellerPrice: 370,
    conflict: true,
    targetOffer: 350,
    ceiling: 350,
  });
});

test('paiement hors Leboncoin dans l’historique vendeur arrête avant OpenRouter', async () => {
  let fetchCalls = 0;
  const riskyConversation = {
    ...conversation,
    messages: [
      { expediteur: 'vendeur', contenu: 'Payer maintenant par virement ou PayPal' },
      { expediteur: 'vendeur', contenu: 'Je ne peux recevoir que 80 sur leboncoin' },
      { expediteur: 'vendeur', contenu: 'Il faudra verser le solde par virement' },
      { expediteur: 'moi', contenu: 'Je préfère tout régler sur leboncoin' },
      { expediteur: 'vendeur', contenu: 'Oui' },
    ],
  };

  const result = await requestNegotiation({
    conversation: riskyConversation,
    messageVendeur: 'Oui',
    apiKey: 'test-key',
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validDraft) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(result, {
    message: null,
    offre_proposee_eur: null,
    offre_recue_eur: null,
    lieu_propose: null,
    arret: { doit_arreter: true, raison: 'question_importante' },
    notes_internes: "Le vendeur a demandé un paiement hors Leboncoin. L'utilisateur reprend la main.",
  });
});

test('paiement hors Leboncoin écrit par l’acheteur ne déclenche pas le handoff', async () => {
  let fetchCalls = 0;
  const safeConversation = {
    ...conversation,
    messages: [
      { expediteur: 'moi', contenu: 'Je pourrais payer par virement' },
      { expediteur: 'vendeur', contenu: 'Oui' },
    ],
  };

  const result = await requestNegotiation({
    conversation: safeConversation,
    messageVendeur: 'Oui',
    apiKey: 'test-key',
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validDraft) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(result.arret.doit_arreter, false);
});

test('un paiement hors Leboncoin même refusé, resté sans réponse, ne laisse rien partir', async () => {
  let fetchCalls = 0;
  const safeConversation = {
    ...conversation,
    messages: [
      { expediteur: 'vendeur', contenu: 'Pas de virement, uniquement paiement leboncoin' },
      { expediteur: 'vendeur', contenu: 'Oui' },
    ],
  };

  const result = await requestNegotiation({
    conversation: safeConversation,
    messageVendeur: 'Oui',
    apiKey: 'test-key',
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validDraft) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(result.message, null);
  assert.match(result.notes_internes, /paiement hors leboncoin/);
});

test('requestNegotiation refuse une offre qui ignore le prix vendeur effectif', async () => {
  const conflict = {
    ...conversation,
    offre_envoyee_eur: 300,
    annonce: { ...conversation.annonce, prix_eur: 300, description: 'Prix PS5 : 500€' },
  };
  await assert.rejects(requestNegotiation({
    conversation: conflict,
    messageVendeur: "Pour moi la PS5 est à 500",
    apiKey: 'test-key',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      ...validDraft,
      message: 'ok pour 300',
      offre_proposee_eur: 300,
      offre_recue_eur: 500,
    }) } }] }), { status: 200 }),
  }), /cible.*340/i);
});

test('requestNegotiation corrige une fois une offre qui ignore la cible deterministe', async () => {
  const conflict = {
    ...conversation,
    offre_envoyee_eur: 340,
    annonce: { ...conversation.annonce, prix_eur: 300, description: 'Prix PS5 : 500€' },
  };
  const responses = [340, 350];
  const bodies = [];
  const result = await requestNegotiation({
    conversation: conflict,
    messageVendeur: 'Ca va et vous ?',
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      const offer = responses.shift();
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        ...validDraft,
        message: `je vais bien aussi merci\n${offer} ca vous va ?`,
        offre_proposee_eur: offer,
        offre_recue_eur: null,
        lieu_propose: null,
      }) } }] }), { status: 200 });
    },
  });

  assert.equal(bodies.length, 2);
  assert.match(bodies[1].messages.at(-1).content, /cible obligatoire.*350/i);
  assert.equal(result.offre_proposee_eur, 350);
  assert.match(result.message, /350 ca vous va \?/i);
});

test('requestNegotiation répond à la petite question du vendeur tout en visant le prix effectif', async () => {
  const conflict = {
    ...conversation,
    offre_envoyee_eur: 300,
    annonce: { ...conversation.annonce, prix_eur: 300, description: 'Prix PS5 : 500€' },
  };
  const result = await requestNegotiation({
    conversation: conflict,
    messageVendeur: 'Bonjour je vais bien merci et vous ? La PS5 est à 500',
    apiKey: 'test-key',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      ...validDraft,
      message: 'je vais bien aussi merci\nje peux faire 340 ça vous va ?',
      offre_proposee_eur: 340,
      offre_recue_eur: 500,
      lieu_propose: null,
      notes_internes: 'Réponse de courtoisie puis offre cible',
    }) } }] }), { status: 200 }),
  });

  assert.equal(
    result.message,
    'je vais bien aussi merci\nje peux faire 340\npar paiement leboncoin avec envoi ça vous va ?',
  );
  assert.equal(result.offre_proposee_eur, 340);
  assert.equal(result.offre_recue_eur, 500);
});
test('requestNegotiation remonte une erreur exploitable sans exposer la clé', async () => {
  await assert.rejects(
    requestNegotiation({
      conversation,
      messageVendeur: 'Toujours intéressé ?',
      apiKey: 'secret-value',
      fetchImpl: async () => new Response('quota dépassé', { status: 429 }),
    }),
    (error) => {
      assert.match(error.message, /OpenRouter[^\n]*429/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    },
  );
});

test('requestNegotiation interrompt un appel OpenRouter qui dépasse le délai', async () => {
  await assert.rejects(
    requestNegotiation({
      conversation,
      messageVendeur: 'Toujours intéressé ?',
      apiKey: 'test-key',
      timeoutMs: 10,
      fetchImpl: async (_url, options) => {
        if (!options.signal) throw new Error('signal absent');
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      },
    }),
    /délai.*OpenRouter/i,
  );
});

test('les lecteurs PostgreSQL n’émettent que des SELECT paramétrés', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  assert.deepEqual(await loadConversations(client), []);
  assert.equal(await loadConversation(client, conversation.id), null);
  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ sql }) => sql.trimStart().toLowerCase().startsWith('select')), true);
  assert.deepEqual(calls[1].params, [conversation.id]);
});

test('upsertAnnonce conserve les colonnes IA et signale une annonce déjà analysée', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (calls.length === 1) return { rows: [{ analyse_ia_le: '2026-09-25T10:00:00.000Z' }] };
      return { rows: [] };
    },
  };

  const result = await upsertAnnonce(client, {
    url_annonce: 'https://www.leboncoin.fr/ad/consoles/123',
    titre: 'PS5 Slim',
    description: null,
  });

  assert.deepEqual(result, { created: false, deja_analysee: true });
  assert.equal(calls[0].params[0], 'https://www.leboncoin.fr/ad/consoles/123');
  assert.equal(calls[1].params.includes('123'), true);
  assert.match(calls[1].sql, /on conflict \(url_annonce\) do update set/i);
  assert.doesNotMatch(calls[1].sql, /description/i);
  assert.doesNotMatch(calls[1].sql, /analyse_ia/i);
});

test('upsertAnnonce signale une annonce nouvellement créée', async () => {
  const client = {
    async query() {
      return { rows: [] };
    },
  };

  assert.deepEqual(
    await upsertAnnonce(client, { url_annonce: 'https://www.leboncoin.fr/ad/consoles/456' }),
    { created: true, deja_analysee: false },
  );
});

test('upsertAnnonce omet les booléens null pour laisser les défauts ou valeurs stockées', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  await upsertAnnonce(client, {
    url_annonce: 'https://www.leboncoin.fr/ad/consoles/789',
    titre: 'PS5',
    livraison_possible: null,
    sponsorise: null,
  });

  assert.doesNotMatch(calls[1].sql, /livraison_possible|sponsorise/i);
  assert.equal(calls[1].params.includes(null), false);
});

test('validateNegotiationRequest rejette les corps JSON non objets', () => {
  for (const body of [null, [], 'texte', 42, true]) {
    assert.throws(() => validateNegotiationRequest(body), /objet JSON/i);
  }
  assert.deepEqual(
    validateNegotiationRequest({ conversation_id: ` ${conversation.id} `, message_vendeur: ' Bonjour ' }),
    { conversationId: conversation.id, messageVendeur: 'Bonjour', sessionMessages: [] },
  );
});

test('validateNegotiationRequest nettoie les session_messages fournis par le navigateur', () => {
  const result = validateNegotiationRequest({
    conversation_id: conversation.id,
    message_vendeur: 'Bonjour',
    session_messages: [
      { expediteur: 'vendeur', contenu: ' oui ', envoye_le: '2026-09-25T10:00:00.000Z' },
      { expediteur: 'moi', contenu: 'Je peux faire 340 €', montant_eur: 340, envoye_le: 'pas une date' },
      { expediteur: 'systeme', contenu: 'ignoré : expéditeur non autorisé' },
      { expediteur: 'moi', contenu: '   ' },
      'pas un objet',
    ],
  });
  assert.deepEqual(result.sessionMessages, [
    { expediteur: 'vendeur', contenu: 'oui', envoye_le: '2026-09-25T10:00:00.000Z', type: 'texte', montant_eur: null },
    { expediteur: 'moi', contenu: 'Je peux faire 340 €', envoye_le: null, type: 'offre', montant_eur: 340 },
  ]);
});

test('validateAnnoncePayload exige une url_annonce', () => {
  assert.throws(() => validateAnnoncePayload({ annonce: { titre: 'PS5' } }), /url_annonce/);
});

test('validateAnnoncePayload exige une url leboncoin', () => {
  assert.throws(
    () => validateAnnoncePayload({ annonce: { url_annonce: 'https://evil.example/ad/1' } }),
    /leboncoin/,
  );
});

test('validateAnnoncePayload refuse les suffixes après l’identifiant leboncoin', () => {
  for (const url_annonce of [
    'https://www.leboncoin.fr/ad/consoles/123garbage',
    'https://www.leboncoin.fr/ad/consoles/123/extra',
    'https://www.leboncoin.fr/ad/consoles?x/123',
    'https://www.leboncoin.fr/ad/consoles#x/123',
  ]) {
    assert.throws(() => validateAnnoncePayload({ annonce: { url_annonce } }), /leboncoin/);
  }
});

test('validateAnnoncePayload accepte une annonce minimale', () => {
  const { annonce } = validateAnnoncePayload({
    annonce: { url_annonce: 'https://www.leboncoin.fr/ad/consoles/123', titre: 'PS5' },
  });
  assert.equal(annonce.url_annonce, 'https://www.leboncoin.fr/ad/consoles/123');
  assert.equal(annonce.titre, 'PS5');
});

test('validateClassifyRequest exige une url_annonce leboncoin', () => {
  assert.throws(() => validateClassifyRequest({}), /url_annonce/);
  assert.throws(() => validateClassifyRequest({ url_annonce: 'https://evil.example/x' }), /leboncoin/);
});

test('validateClassifyRequest lit le drapeau force', () => {
  const url = 'https://www.leboncoin.fr/ad/consoles/123';
  assert.deepEqual(validateClassifyRequest({ url_annonce: url }), { urlAnnonce: url, force: false });
  assert.deepEqual(validateClassifyRequest({ url_annonce: url, force: true }), { urlAnnonce: url, force: true });
});

test('validateContactErrorRequest accepte uniquement les codes fermés', () => {
  const url = 'https://www.leboncoin.fr/ad/consoles/123';
  assert.deepEqual(validateContactErrorRequest({ url_annonce: ` ${url} `, code: 'formulaire_absent' }), {
    urlAnnonce: url, code: 'formulaire_absent',
  });
  for (const code of ['', 'texte-libre', null, undefined]) {
    assert.throws(() => validateContactErrorRequest({ url_annonce: url, code }), /code/i);
  }
});

test('renderPage injecte les conversations sans permettre de fermer la balise script', () => {
  const html = renderPage(
    '<script>window.__NEGOTIATION_DATA__ = __NEGOTIATION_PAYLOAD__; const copy = window.__NEGOTIATION_DATA__;</script>',
    [{ id: '1', vendeur: '</script><script>alert(1)</script>' }],
  );

  assert.match(html, /window\.__NEGOTIATION_DATA__ = \[/);
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /\\u003c\/script\\u003e/);
});

async function withServer(dependencies, run) {
  const server = createNegotiationServer(dependencies);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('le serveur émet CORS seulement pour l’extension autorisée', async () => {
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    extensionOrigin,
    loadConversations: async () => [],
    loadConversation: async () => conversation,
    negotiate: async () => validDraft,
  }, async (baseUrl) => {
    const preflight = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'OPTIONS',
      headers: {
        origin: extensionOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), extensionOrigin);

    const allowedPost = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'POST',
      headers: { origin: extensionOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversation.id, message_vendeur: 'Bonjour' }),
    });
    assert.equal(allowedPost.status, 200);
    assert.equal(allowedPost.headers.get('access-control-allow-origin'), extensionOrigin);

    const deniedPreflight = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(deniedPreflight.status, 403);
    assert.equal(deniedPreflight.headers.get('access-control-allow-origin'), null);

    const deniedPost = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversation.id, message_vendeur: 'Bonjour' }),
    });
    assert.equal(deniedPost.status, 403);
    assert.equal(deniedPost.headers.get('access-control-allow-origin'), null);
  });
});

test('le serveur charge la page et expose les conversations injectées', async () => {
  await withServer({
    template: '<!doctype html><script>window.__NEGOTIATION_DATA__ = __NEGOTIATION_PAYLOAD__;</script>',
    loadConversations: async () => [conversation],
    loadConversation: async () => conversation,
    negotiate: async () => validDraft,
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(html, /11111111-1111-4111-8111-111111111111/);
  });
});

test('POST /api/negotiate relit la conversation et renvoie le brouillon', async () => {
  let loadedId;
  let receivedMessage;
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async (id) => {
      loadedId = id;
      return conversation;
    },
    negotiate: async ({ messageVendeur }) => {
      receivedMessage = messageVendeur;
      return validDraft;
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversation.id,
        message_vendeur: 'Je peux faire 370, dernier prix',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), validDraft);
    assert.equal(loadedId, conversation.id);
    assert.equal(receivedMessage, 'Je peux faire 370, dernier prix');
  });
});

test('POST /api/negotiate valide les données et renvoie des erreurs réessayables', async () => {
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async () => conversation,
    negotiate: async () => {
      throw new Error('OpenRouter /chat/completions -> HTTP 503');
    },
    logger: { error() {} },
  }, async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: '', message_vendeur: '' }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /conversation.*message/i);

    const nullBody = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    });
    assert.equal(nullBody.status, 400);
    assert.match((await nullBody.json()).error, /objet JSON/i);

    const wrongContentType = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ conversation_id: conversation.id, message_vendeur: 'Bonjour' }),
    });
    assert.equal(wrongContentType.status, 415);

    const foreignOrigin = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ conversation_id: conversation.id, message_vendeur: 'Bonjour' }),
    });
    assert.equal(foreignOrigin.status, 403);

    const failed = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversation.id, message_vendeur: 'Bonjour' }),
    });
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), {
      error: 'La génération a échoué. Réessaie dans un instant.',
      retryable: true,
    });
  });
});

test('POST /api/annonces/upsert renvoie le résultat de l\'upsert', async () => {
  const calls = [];
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async () => null,
    negotiate: async () => ({}),
    upsertAnnonce: async (annonce) => {
      calls.push(annonce);
      return { created: true, deja_analysee: false };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/annonces/upsert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        annonce: { url_annonce: 'https://www.leboncoin.fr/ad/consoles/123', titre: 'PS5' },
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { created: true, deja_analysee: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].titre, 'PS5');
  });
});

test('POST /api/annonces/upsert refuse une charge invalide', async () => {
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async () => null,
    negotiate: async () => ({}),
    upsertAnnonce: async () => assert.fail('ne doit pas être appelé'),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/annonces/upsert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ annonce: { titre: 'sans url' } }),
    });

    assert.equal(response.status, 400);
  });
});

test('POST /api/annonces/classify renvoie la classification', async () => {
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async () => null,
    negotiate: async () => ({}),
    upsertAnnonce: async () => ({ created: false, deja_analysee: false }),
    classifyAnnonce: async (urlAnnonce, { force }) => ({
      url_annonce: urlAnnonce,
      saute: false,
      force_recu: force,
      classification: 'saint_graal',
      disqualifiee: false,
      lecteur_disque: true,
      manettes_incluses: 2,
    }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/annonces/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url_annonce: 'https://www.leboncoin.fr/ad/consoles/123', force: true }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.classification, 'saint_graal');
    assert.equal(payload.force_recu, true);
  });
});

test('POST /api/annonces/classify renvoie 502 si le pipeline échoue', async () => {
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async () => null,
    negotiate: async () => ({}),
    upsertAnnonce: async () => ({ created: false, deja_analysee: false }),
    classifyAnnonce: async () => { throw new Error('OpenRouter 503'); },
    logger: { error() {}, log() {} },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/annonces/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url_annonce: 'https://www.leboncoin.fr/ad/consoles/123' }),
    });

    assert.equal(response.status, 502);
  });
});

test('le serveur renvoie 404 pour une conversation ou une route inconnue', async () => {
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async () => null,
    negotiate: async () => validDraft,
  }, async (baseUrl) => {
    const missingConversation = await fetch(`${baseUrl}/api/negotiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversation.id, message_vendeur: 'Bonjour' }),
    });
    assert.equal(missingConversation.status, 404);

    const missingRoute = await fetch(`${baseUrl}/api/inconnue`);
    assert.equal(missingRoute.status, 404);
  });
});

test('GET /api/annonces/shortlist renvoie les annonces et borne la limite', async () => {
  await withServer({
    chargerShortlist: async ({ limite }) => [{ url_annonce: 'https://www.leboncoin.fr/ad/consoles/1', titre: 'PS5', limite_recue: limite }],
  }, async (baseUrl) => {
    for (const [query, expected] of [['?limite=5', 5], ['?limite=99999', 200], ['?limite=0', 1],
      ['?limite=-10', 1], ['?limite=pasunnombre', 50], ['', 50]]) {
      const response = await fetch(`${baseUrl}/api/annonces/shortlist${query}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { annonces: [
        { url_annonce: 'https://www.leboncoin.fr/ad/consoles/1', titre: 'PS5', limite_recue: expected },
      ] });
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  });
});

test('POST /api/annonces/contactee marque l’annonce validée et renvoie la date', async () => {
  const appels = [];
  await withServer({
    marquerContactee: async (url) => { appels.push(url); return { contacte_le: '2026-09-26T10:00:00.000Z' }; },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/annonces/contactee`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url_annonce: ' https://www.leboncoin.fr/ad/consoles/1 ' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { contacte_le: '2026-09-26T10:00:00.000Z' });
    assert.deepEqual(appels, ['https://www.leboncoin.fr/ad/consoles/1']);
  });
});

test('POST /api/annonces/introuvable disqualifie l’annonce validée', async () => {
  const appels = [];
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  await withServer({
    extensionOrigin,
    marquerIntrouvable: async (url) => { appels.push(url); return { marquee: true }; },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/annonces/introuvable`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: extensionOrigin },
      body: JSON.stringify({ url_annonce: ' https://www.leboncoin.fr/ad/consoles/1 ' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { marquee: true });
    assert.deepEqual(appels, ['https://www.leboncoin.fr/ad/consoles/1']);

    const localPage = await fetch(`${baseUrl}/api/annonces/introuvable`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8834' },
      body: JSON.stringify({ url_annonce: 'https://www.leboncoin.fr/ad/consoles/2' }),
    });
    assert.equal(localPage.status, 403);
    assert.deepEqual(appels, ['https://www.leboncoin.fr/ad/consoles/1']);
  });
});

test('POST /api/annonces/contactee refuse les JSON et URLs invalides sans écrire', async () => {
  await withServer({ marquerContactee: async () => assert.fail('aucune écriture attendue') }, async (baseUrl) => {
    for (const body of ['{', 'null', '[]', '{}', JSON.stringify({ url_annonce: 'https://evil.example/ad/1' }),
      JSON.stringify({ url_annonce: 'https://www.leboncoin.fr/ad/consoles/123garbage' })]) {
      const response = await fetch(`${baseUrl}/api/annonces/contactee`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, 'string');
    }
  });
});

test('POST /api/annonces/contact-erreur marque seulement les erreurs terminales validées', async () => {
  const appels = [];
  await withServer({
    marquerErreurContact: async (url, code) => {
      appels.push([url, code]);
      return { contact_erreur_code: code, contact_erreur_le: '2026-09-26T10:00:00.000Z' };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/annonces/contact-erreur`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url_annonce: 'https://www.leboncoin.fr/ad/consoles/1', code: 'reply_indisponible' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      contact_erreur_code: 'reply_indisponible', contact_erreur_le: '2026-09-26T10:00:00.000Z',
    });
    assert.deepEqual(appels, [['https://www.leboncoin.fr/ad/consoles/1', 'reply_indisponible']]);

    for (const body of [{ url_annonce: 'https://www.leboncoin.fr/ad/consoles/1', code: 'libre' },
      { url_annonce: 'https://evil.example/ad/1', code: 'formulaire_absent' }]) {
      const invalid = await fetch(`${baseUrl}/api/annonces/contact-erreur`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(invalid.status, 400);
    }
    assert.equal(appels.length, 1);
  });
});

test('les routes de réservation transmettent les paramètres validés et leurs résultats', async () => {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const url = 'https://www.leboncoin.fr/ad/consoles/1';
  const token = '11111111-2222-4333-8444-555555555555';
  const calls = [];
  await withServer({
    extensionOrigin: origin,
    reserverContact: async (...args) => { calls.push(['reserve', ...args]); return { reservee: false, raison: 'reservation_existante' }; },
    finaliserContact: async (...args) => { calls.push(['finalise', ...args]); return { contacte_le: '2026-09-26T10:00:00.000Z' }; },
    libererContact: async (...args) => { calls.push(['libere', ...args]); return { liberee: true }; },
    marquerErreurContact: async (...args) => { calls.push(['erreur', ...args]); return { contact_erreur_code: 'reply_indisponible' }; },
  }, async (baseUrl) => {
    const cases = [
      ['contact-reserver', { url_annonce: url }, { reservee: false, raison: 'reservation_existante' }],
      ['contact-finaliser', { url_annonce: url, reservation_token: token, resultat: 'confirme' }, { contacte_le: '2026-09-26T10:00:00.000Z' }],
      ['contact-liberer', { url_annonce: url, reservation_token: token }, { liberee: true }],
      ['contact-erreur', { url_annonce: url, code: 'reply_indisponible', reservation_token: token }, { contact_erreur_code: 'reply_indisponible' }],
    ];
    for (const [path, body, result] of cases) {
      const response = await fetch(`${baseUrl}/api/annonces/${path}`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), result);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
  });
  assert.deepEqual(calls, [
    ['reserve', url], ['finalise', url, token, 'confirme'], ['libere', url, token],
    ['erreur', url, 'reply_indisponible', token],
  ]);
});

test('les nouvelles routes exigent l’origine extension et des corps JSON stricts', async () => {
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const url_annonce = 'https://www.leboncoin.fr/ad/consoles/1';
  const reservation_token = '11111111-2222-4333-8444-555555555555';
  const handlers = {
    reserverContact: async () => assert.fail('réservation invalide exécutée'),
    finaliserContact: async () => assert.fail('finalisation invalide exécutée'),
    libererContact: async () => assert.fail('libération invalide exécutée'),
  };
  await withServer({ extensionOrigin, ...handlers }, async (baseUrl) => {
    for (const [path, valid] of [
      ['contact-reserver', { url_annonce }],
      ['contact-finaliser', { url_annonce, reservation_token, resultat: 'incertain' }],
      ['contact-liberer', { url_annonce, reservation_token }],
    ]) {
      for (const origin of [undefined, baseUrl, 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz']) {
        const response = await fetch(`${baseUrl}/api/annonces/${path}`, {
          method: 'POST', headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify(valid),
        });
        assert.equal(response.status, 403, `${path} ${origin}`);
        assert.equal(response.headers.get('access-control-allow-origin'), origin === baseUrl ? origin : null);
      }
      for (const body of [
        { ...valid, url_annonce: 'https://evil.example/ad/consoles/1' },
        { ...valid, extra: true },
        ...(path === 'contact-reserver' ? [] : [{ ...valid, reservation_token: undefined }]),
        ...(path === 'contact-reserver' ? [] : [{ ...valid, reservation_token: 'bad-token' }]),
        ...(path === 'contact-finaliser' ? [{ ...valid, resultat: 'autre' }] : []),
      ]) {
        const response = await fetch(`${baseUrl}/api/annonces/${path}`, {
          method: 'POST', headers: { origin: extensionOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, `${path}: ${JSON.stringify(body)}`);
      }
      const nonJson = await fetch(`${baseUrl}/api/annonces/${path}`, {
        method: 'POST', headers: { origin: extensionOrigin, 'content-type': 'text/plain' }, body: '{}',
      });
      assert.equal(nonJson.status, 415, path);
      const malformed = await fetch(`${baseUrl}/api/annonces/${path}`, {
        method: 'POST', headers: { origin: extensionOrigin, 'content-type': 'application/json' }, body: '{',
      });
      assert.equal(malformed.status, 400, path);
    }
  });
});

test('contact-erreur rejette un jeton malformé ou un champ inconnu sans écrire', async () => {
  await withServer({
    marquerErreurContact: async () => assert.fail('écriture invalide'),
  }, async (baseUrl) => {
    for (const extra of [{ reservation_token: 'bad-token' }, { extra: true }]) {
      const response = await fetch(`${baseUrl}/api/annonces/contact-erreur`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url_annonce: 'https://www.leboncoin.fr/ad/consoles/1', code: 'reply_indisponible', ...extra }),
      });
      assert.equal(response.status, 400);
    }
  });
});

test('les erreurs de base des réservations restent des réponses JSON génériques', async () => {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const fail = async () => { throw new Error('détail privé de la base'); };
  await withServer({ extensionOrigin: origin, reserverContact: fail, finaliserContact: fail, libererContact: fail,
    logger: { error() {} } }, async (baseUrl) => {
    for (const [path, body] of [
      ['contact-reserver', { url_annonce: 'https://www.leboncoin.fr/ad/consoles/1' }],
      ['contact-finaliser', { url_annonce: 'https://www.leboncoin.fr/ad/consoles/1',
        reservation_token: '11111111-2222-4333-8444-555555555555', resultat: 'confirme' }],
      ['contact-liberer', { url_annonce: 'https://www.leboncoin.fr/ad/consoles/1',
        reservation_token: '11111111-2222-4333-8444-555555555555' }],
    ]) {
      const response = await fetch(`${baseUrl}/api/annonces/${path}`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'Réservation de contact impossible.' });
    }
  });
});

test('les routes de contact autorisent exactement l’extension configurée sans refléter les origines refusées', async () => {
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  await withServer({ extensionOrigin, chargerShortlist: async () => [], marquerContactee: async () => ({ contacte_le: 'date' }) }, async (baseUrl) => {
    for (const [origin, expected] of [[extensionOrigin, 200], [baseUrl, 200],
      ['chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 403], ['https://evil.example', 403]]) {
      for (const [path, method, body] of [['shortlist', 'GET', undefined], ['contactee', 'POST', JSON.stringify({ url_annonce: 'https://www.leboncoin.fr/ad/consoles/1' })]]) {
        const response = await fetch(`${baseUrl}/api/annonces/${path}`, { method, headers: { origin, 'content-type': 'application/json' }, body });
        assert.equal(response.status, expected);
        assert.equal(response.headers.get('access-control-allow-origin'), expected === 200 ? origin : null);
      }
    }
  });
});

test('les erreurs SQL de shortlist et de marquage restent des réponses JSON génériques', async () => {
  const fail = async () => { throw new Error('détail privé de la base'); };
  await withServer({ chargerShortlist: fail, marquerContactee: fail, marquerErreurContact: fail, logger: { error() {} } }, async (baseUrl) => {
    const shortlist = await fetch(`${baseUrl}/api/annonces/shortlist`);
    assert.equal(shortlist.status, 500);
    assert.deepEqual(await shortlist.json(), { error: 'Shortlist impossible.' });
    const contactee = await fetch(`${baseUrl}/api/annonces/contactee`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url_annonce: 'https://www.leboncoin.fr/ad/consoles/1' }),
    });
    assert.equal(contactee.status, 500);
    assert.deepEqual(await contactee.json(), { error: 'Marquage impossible.' });
    const erreur = await fetch(`${baseUrl}/api/annonces/contact-erreur`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url_annonce: 'https://www.leboncoin.fr/ad/consoles/1', code: 'formulaire_absent' }),
    });
    assert.equal(erreur.status, 500);
    assert.deepEqual(await erreur.json(), { error: 'Marquage impossible.' });
  });
});

const handoffBase = {
  arret: { doit_arreter: true, raison: 'paiement_leboncoin_accepte' },
  notes_internes: 'Le vendeur accepte le paiement sécurisé',
  offre_proposee_eur: null,
  offre_recue_eur: 350,
  lieu_propose: null,
};

test('le prompt traite le prix puis obtient une réponse sur l’envoi dans une voix naturelle', () => {
  const messages = buildNegotiationMessages(conversation, 'Je ne descends pas à moins de 370');

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  const system = messages[0].content;
  assert.match(system, /prix[^\n]*≤ 350[^\n]*accepte/i);
  assert.match(system, /ouvrir à 340/);
  assert.match(system, /370 dernier prix/i);
  assert.match(system, /jamais[^\n]*price_context\.ceiling/);
  assert.match(system, /prix seul[^\n]*jamais[^\n]*point d'arrêt/i);
  assert.match(system, /par paiement leboncoin avec envoi ça vous va \?/i);
  assert.match(system, /bulle de prix[^\n]*sans « ça vous va \? »/i);
  assert.match(system, /n'écris jamais[^\n]*(?:€|euro)/i);
  assert.match(system, /ne propose jamais[^\n]*(?:lieu|rendez-vous)/i);
  assert.match(system, /accessoires[^\n]*(?:manquant|défectueux|douteux)/i);
  assert.match(system, /ça vous a déjà posé quoi comme problème/i);
  assert.match(system, /défaut mineur ou ambigu[^\n]*priorité/i);
  assert.match(system, /ne traite pas encore le prix ni l'envoi/i);
  assert.match(system, /propose[^\n]*≤ 350[^\n]*ok pour/i);
  assert.match(system, /ne fait pas d'envoi[^\n]*paiement_leboncoin_refuse/i);
  assert.match(system, /répond sur l'envoi[^\n]*ne négocie plus le prix/i);
  assert.match(system, /aucun montant de prix[^\n]*offre_recue_eur[^\n]*null/i);
  assert.match(system, /ne recopie jamais[^\n]*offre_recue_eur[^\n]*historique/i);
  assert.match(system, /vendeur « je peux faire 350 »[^\n]*acheteur « ok pour 350 »/i);
  assert.match(system, /choisis un point d'arrêt[^\n]*message[^\n]*offre_proposee_eur[^\n]*lieu_propose[^\n]*null/i);
  assert.match(system, /paiement_leboncoin_refuse/);
  assert.doesNotMatch(system, /→ rdv_confirme|→ refus_categorique_prix/);
  assert.match(system, /pas de point final/i);
  assert.match(system, /une seule question/i);
  assert.match(system, /défaut majeur/i);
  assert.match(system, /instructions[^\n]*vendeur[^\n]*ignor/i);
  assert.match(system, /et vous[^\n]*je vais bien aussi merci/i);
  assert.match(system, /question[^\n]*anodine[^\n]*improvis/i);
  assert.match(system, /question importante[^\n]*question_importante/i);
  assert.match(system, /n'invente[^\n]*(?:adresse|disponibilité|engagement|paiement)/i);

  assert.equal(messages[1].role, 'user');
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.annonce.prix_eur, 380);
  assert.equal(payload.annonce.description, 'Très bon état, petite rayure sur la façade');
  assert.deepEqual(Object.keys(payload.annonce), [
    'titre',
    'prix_eur',
    'description',
    'etat',
    'livraison_possible',
  ]);
  assert.equal(payload.annonce.livraison_possible, null);
  assert.deepEqual(payload.conversation, {
    offre_envoyee_eur: 340,
    offre_recue_eur: 370,
    messages: [
      {
        expediteur: 'moi',
        contenu: 'Salut, elle est toujours dispo ?',
      },
      {
        expediteur: 'vendeur',
        contenu: 'Oui, mais je reste à 370 €',
        type: 'offre',
        montant_eur: 370,
      },
    ],
  });
  assert.equal(payload.conversation.messages.length, 2);
  assert.equal(payload.message_vendeur_a_traiter, 'Je ne descends pas à moins de 370');
});

test('la livraison inconnue n’est jamais présentée au modèle comme un refus', () => {
  for (const [stored, sent] of [[false, null], [null, null], [undefined, null], [true, true]]) {
    const [system, user] = buildNegotiationMessages(
      { ...conversation, annonce: { ...conversation.annonce, livraison_possible: stored } },
      'Toujours disponible, 380',
    );
    assert.equal(JSON.parse(user.content).annonce.livraison_possible, sent);
    assert.match(system.content,
      /point d'arrêt sur l'envoi[^\n]*uniquement[^\n]*vendeur[^\n]*messages[^\n]*jamais[^\n]*annonce[^\n]*livraison_possible/i);
  }
});

test('une panne du modèle porte un code stable, une réponse inexploitable non', async () => {
  const run = (fetchImpl, apiKey = 'test-key') => requestNegotiation({
    conversation, messageVendeur: 'Oui', apiKey, fetchImpl,
  }).then(() => assert.fail('un échec est attendu'), (error) => error);
  for (const status of [401, 402, 429, 500, 503]) {
    assert.equal((await run(async () => new Response('', { status }))).code, 'modele_indisponible');
  }
  assert.equal((await run(async () => { throw new TypeError('fetch failed'); })).code, 'modele_indisponible');
  assert.equal((await run(undefined, '')).code, 'modele_indisponible');
  assert.equal((await run(async () => new Response('', { status: 400 }))).code, undefined);
  assert.equal((await run(async () => new Response('{}', { status: 200 }))).code, undefined);
});

test('parseNegotiationResponse accepte les raisons actives et les raisons historiques', () => {
  for (const reason of [
    'paiement_leboncoin_accepte',
    'paiement_leboncoin_refuse',
    'rdv_confirme',
    'refus_categorique_prix',
    'defaut_majeur',
    'question_importante',
  ]) {
    const stopped = {
      ...validDraft,
      message: null,
      offre_proposee_eur: null,
      lieu_propose: null,
      arret: { doit_arreter: true, raison: reason },
    };
    assert.equal(parseNegotiationResponse(JSON.stringify(stopped)).arret.raison, reason);
  }
});

test('handoff valide exige un arrêt actif et une raison connue', () => {
  assert.deepEqual(
    validateHandoffRequest({
      conversation_id: ` ${conversation.id} `,
      message_vendeur: ' Oui pour le paiement sécurisé ',
      handoff: handoffBase,
    }),
    { conversationId: conversation.id, messageVendeur: 'Oui pour le paiement sécurisé', handoff: handoffBase },
  );
  assert.throws(
    () => validateHandoffRequest({ conversation_id: conversation.id, message_vendeur: 'x', handoff: { ...handoffBase, arret: { doit_arreter: false, raison: null } } }),
    /doit_arreter.*true/i,
  );
  assert.throws(
    () => validateHandoffRequest({ conversation_id: conversation.id, message_vendeur: 'x', handoff: { ...handoffBase, arret: { doit_arreter: true, raison: 'inconnu' } } }),
    /raison.*invalide/i,
  );
});

test('handoff e-mail rend chaque état avec un sujet et une action explicites', () => {
  const expected = [
    ['paiement_leboncoin_accepte', '[PS5 HANDOFF] ACTION — Finaliser le paiement Leboncoin', 'Finaliser le paiement Leboncoin'],
    ['paiement_leboncoin_refuse', '[PS5 HANDOFF] ACTION — Envoi Leboncoin refusé', "Reprendre la conversation : l'envoi avec paiement Leboncoin est refusé"],
    ['rdv_confirme', '[PS5 HANDOFF] ACTION — Vérifier le rendez-vous', 'Vérifier le rendez-vous'],
    ['refus_categorique_prix', '[PS5 HANDOFF] STOP — Ne pas dépasser 370 €', 'Ne pas dépasser 370 €'],
    ['defaut_majeur', '[PS5 HANDOFF] ALERTE — Vérifier le défaut majeur', 'Vérifier le défaut majeur'],
    ['question_importante', '[PS5 HANDOFF] ACTION — Rédiger vous-même la réponse', 'Lire le dernier message du vendeur et rédiger la réponse vous-même'],
  ];
  for (const [reason, prefix, action] of expected) {
    const email = buildHandoffEmail({
      conversation: { ...conversation, vendeur: 'Camille', annonce: { ...conversation.annonce, titre: 'PS5 <Slim>' } },
      handoff: { ...handoffBase, arret: { doit_arreter: true, raison: reason } },
      messageVendeur: '<script>alert(1)</script>',
    });
    assert.match(email.subject, new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(email.text, new RegExp(action));
    assert.match(email.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(email.html, /<script>/i);
  }
});

test('handoff e-mail refuse une valeur non booléenne pour doit_arreter', () => {
  assert.throws(
    () => buildHandoffEmail({ conversation, handoff: { ...handoffBase, arret: { doit_arreter: 'true', raison: handoffBase.arret.raison } }, messageVendeur: 'x' }),
    /doit_arreter.*true/i,
  );
});

test('handoff e-mail différencie les événements dont les détails changent', () => {
  const first = buildHandoffEmail({ conversation, handoff: handoffBase, messageVendeur: 'x' });
  const second = buildHandoffEmail({
    conversation,
    handoff: { ...handoffBase, notes_internes: 'Autres notes', offre_recue_eur: 351, lieu_propose: 'Bourgexemple' },
    messageVendeur: 'x',
  });
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
});

test('handoff e-mail conserve les offres, le lieu proposé et le rendez-vous connus avec des libellés distincts', () => {
  const email = buildHandoffEmail({
    conversation: {
      ...conversation,
      offre_envoyee_eur: 340,
      offre_recue_eur: 370,
      rdv_lieu: 'Gare de Bourgexemple <rive droite>',
      rdv_date: '2026-09-27T14:30:00.000Z',
    },
    handoff: {
      ...handoffBase,
      offre_proposee_eur: 350,
      offre_recue_eur: 360,
      lieu_propose: 'Paris <Nation>',
    },
    messageVendeur: 'D’accord',
  });

  assert.match(email.text, /Offre proposée par la réponse : 350 €/);
  assert.match(email.text, /Offre reçue par la réponse : 360 €/);
  assert.match(email.text, /Dernière offre envoyée enregistrée : 340 €/);
  assert.match(email.text, /Dernière offre reçue enregistrée : 370 €/);
  assert.match(email.text, /Lieu proposé par la réponse : Paris <Nation>/);
  assert.match(email.text, /Lieu du rendez-vous enregistré : Gare de Bourgexemple <rive droite>/);
  assert.match(email.text, /Date du rendez-vous enregistrée : 2026-09-27T14:30:00.000Z/);
  assert.match(email.html, /Lieu proposé par la réponse : Paris &lt;Nation&gt;/);
  assert.match(email.html, /Lieu du rendez-vous enregistré : Gare de Bourgexemple &lt;rive droite&gt;/);
});

test('handoff e-mail indique séparément les valeurs de contexte indisponibles', () => {
  const email = buildHandoffEmail({
    conversation: { ...conversation, offre_envoyee_eur: null, offre_recue_eur: null },
    handoff: { ...handoffBase, offre_proposee_eur: null, offre_recue_eur: null, lieu_propose: null },
    messageVendeur: 'D’accord',
  });

  assert.match(email.text, /Offre proposée par la réponse : aucune/);
  assert.match(email.text, /Offre reçue par la réponse : aucune/);
  assert.match(email.text, /Dernière offre envoyée enregistrée : inconnue/);
  assert.match(email.text, /Dernière offre reçue enregistrée : inconnue/);
  assert.match(email.text, /Lieu proposé par la réponse : inconnu/);
});

test('Resend handoff appelle l API avec le destinataire et une idempotence stable', async () => {
  let captured;
  const result = await sendHandoffEmail({
    conversation,
    handoff: handoffBase,
    messageVendeur: 'Oui pour le paiement sécurisé',
    apiKey: 'resend-test-key',
    from: 'PS5 Mission <test@example.com>',
    to: 'handoff@example.com',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ id: 'email-123' }), { status: 200 });
    },
  });
  assert.deepEqual(result, { id: 'email-123' });
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.equal(captured.options.headers.Authorization, 'Bearer resend-test-key');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.ok(captured.options.headers['Idempotency-Key']);
  const body = JSON.parse(captured.options.body);
  assert.equal(body.from, 'PS5 Mission <test@example.com>');
  assert.deepEqual(body.to, ['handoff@example.com']);
  assert.match(body.subject, /^\[PS5 HANDOFF\] ACTION/);
  assert.ok(body.text);
  assert.ok(body.html);
});

test('Resend handoff interrompt un fournisseur bloqué avant sa réponse', async () => {
  const outcome = await Promise.race([
    sendHandoffEmail({
      conversation,
      handoff: handoffBase,
      messageVendeur: 'Oui',
      apiKey: 'resend-test-key',
      to: 'handoff@example.com',
      timeoutMs: 10,
      fetchImpl: async () => new Promise(() => {}),
    }).then(
      () => ({ status: 'resolved' }),
      (error) => ({ status: 'rejected', error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'test-timeout' }), 2000)),
  ]);

  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /délai.*Resend/i);
});

test('Resend handoff interrompt un fournisseur bloqué pendant la lecture de la réponse', async () => {
  const outcome = await Promise.race([
    sendHandoffEmail({
      conversation,
      handoff: handoffBase,
      messageVendeur: 'Oui',
      apiKey: 'resend-test-key',
      to: 'handoff@example.com',
      timeoutMs: 10,
      fetchImpl: async () => ({ ok: true, json: async () => new Promise(() => {}) }),
    }).then(
      () => ({ status: 'resolved' }),
      (error) => ({ status: 'rejected', error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'test-timeout' }), 2000)),
  ]);

  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /délai.*Resend/i);
});

test('createHandoffNotifier transmet l expéditeur Resend configuré', async () => {
  const notifyHandoff = createHandoffNotifier({
    apiKey: 'resend-test-key',
    from: 'PS5 Mission <production@example.com>',
    fallbackRecipient: 'handoff@example.com',
    sendEmail: async ({ from }) => ({ id: from || 'default-sender' }),
  });

  const result = await notifyHandoff({
    conversation,
    handoff: handoffBase,
    messageVendeur: 'Oui pour le paiement sécurisé',
  });

  assert.deepEqual(result, { id: 'PS5 Mission <production@example.com>' });
});

test('requestNegotiation ne conserve une offre reçue que si le dernier message vendeur contient ce montant', async () => {
  const draftWithHistoricalOffer = {
    ...validDraft,
    message: null,
    offre_proposee_eur: null,
    offre_recue_eur: 350,
    arret: { doit_arreter: true, raison: 'paiement_leboncoin_accepte' },
  };
  const fetchImpl = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(draftWithHistoricalOffer) } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const withoutPrice = await requestNegotiation({
    conversation,
    messageVendeur: 'Oui je peux l’envoyer avec le paiement leboncoin',
    apiKey: 'test-key',
    fetchImpl,
  });
  assert.equal(withoutPrice.offre_recue_eur, null);

  const withPrice = await requestNegotiation({
    conversation,
    messageVendeur: 'Oui pour l’envoi et je confirme 350',
    apiKey: 'test-key',
    fetchImpl,
  });
  assert.equal(withPrice.offre_recue_eur, 350);
});

test('requestNegotiation ajoute la question sur l’envoi à toute réponse qui propose un prix', async () => {
  const draftWithoutShippingQuestion = {
    ...validDraft,
    message: '350 ça vous va ?',
    offre_proposee_eur: 350,
    offre_recue_eur: null,
  };
  const result = await requestNegotiation({
    conversation,
    messageVendeur: 'Oui toujours disponible',
    apiKey: 'test-key',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(draftWithoutShippingQuestion) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  assert.equal(result.message, '350\npar paiement leboncoin avec envoi ça vous va ?');
});

test('la page affiche le handoff quand le vendeur refuse l’envoi leboncoin', () => {
  const template = readFileSync(new URL('../negociation.html', import.meta.url), 'utf8');
  const html = renderPage(template, []);

  assert.match(html, /paiement_leboncoin_refuse: 'Le vendeur refuse l’envoi avec paiement leboncoin'/);
});

test('POST /api/handoff relit la conversation et confirme la notification envoyée', async () => {
  let loadedId;
  let notification;
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async (id) => {
      loadedId = id;
      return conversation;
    },
    negotiate: async () => validDraft,
    notifyHandoff: async (input) => {
      notification = input;
      return { id: 'email-123' };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversation.id,
        message_vendeur: 'Oui pour le paiement sécurisé',
        handoff: handoffBase,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { notified: true, email_id: 'email-123' });
    assert.equal(loadedId, conversation.id);
    const { settings, recipient, ...rest } = notification;
    assert.equal(recipient, undefined);
    assert.equal(settings.maxPrice, 370);
    assert.deepEqual(rest, {
      conversation,
      handoff: handoffBase,
      messageVendeur: 'Oui pour le paiement sécurisé',
    });
  });
});

test('POST /api/handoff accepte l’origine extension injectée dans le serveur', async () => {
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    extensionOrigin,
    loadConversations: async () => [],
    loadConversation: async () => conversation,
    negotiate: async () => validDraft,
    notifyHandoff: async () => ({ id: 'email-origin' }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: extensionOrigin },
      body: JSON.stringify({
        conversation_id: conversation.id,
        message_vendeur: 'Oui pour le paiement sécurisé',
        handoff: handoffBase,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), extensionOrigin);
  });
});

test('POST /api/handoff refuse un payload invalide et une conversation absente', async () => {
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async () => null,
    negotiate: async () => validDraft,
    notifyHandoff: async () => ({ id: 'email-123' }),
  }, async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversation.id, message_vendeur: 'Bonjour' }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /handoff/i);

    const missing = await fetch(`${baseUrl}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversation.id,
        message_vendeur: 'Oui pour le paiement sécurisé',
        handoff: handoffBase,
      }),
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Conversation introuvable.' });
  });
});

test('POST /api/handoff masque une panne du fournisseur derrière une erreur réessayable', async () => {
  await withServer({
    template: '__NEGOTIATION_PAYLOAD__',
    loadConversations: async () => [],
    loadConversation: async () => conversation,
    negotiate: async () => validDraft,
    notifyHandoff: async () => {
      throw new Error('Resend /emails -> HTTP 503');
    },
    logger: { error() {} },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversation.id,
        message_vendeur: 'Oui pour le paiement sécurisé',
        handoff: handoffBase,
      }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: 'La notification a échoué. Réessaie dans un instant.',
      retryable: true,
    });
  });
});
