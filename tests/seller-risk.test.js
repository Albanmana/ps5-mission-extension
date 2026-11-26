import assert from 'node:assert/strict';
import test from 'node:test';

import { requestNegotiation } from '../scripts/negotiate-server.js';

const PRICES = { goodPrice: 350, maxPrice: 370 };
const ENVOI = 'par paiement leboncoin avec envoi ça vous va ?';

const draft = (message, offre = null) => ({
  message, offre_proposee_eur: offre, offre_recue_eur: null, lieu_propose: null,
  arret: { doit_arreter: false, raison: null }, notes_internes: '',
});

async function run({ seller, drafts, prix = 400, offre = null, messages }) {
  let calls = 0;
  const result = await requestNegotiation({
    conversation: {
      annonce: { titre: 'PS5', prix_eur: prix }, offre_envoyee_eur: offre,
      messages: messages ?? [{ expediteur: 'vendeur', contenu: seller }],
    },
    messageVendeur: seller, apiKey: 'k', settings: PRICES,
    fetchImpl: async () => {
      const next = drafts[Math.min(calls, drafts.length - 1)];
      calls += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify(next) } }] });
    },
  });
  return { result, calls };
}

const assertNothingSent = ({ result }, label) => {
  assert.equal(result.message, null, `${label} -> ${result.message}`);
  assert.equal(result.arret.doit_arreter, true, label);
  assert.equal(result.offre_proposee_eur, null, label);
};

// Le modèle propose le brouillon le plus dangereux : rien ne doit partir.
const RISQUES = {
  'rendez-vous': [
    'On se voit samedi à 18h chez moi, paiement en liquide ?', 'Il faut venir la chercher samedi, ça marche ?',
    'Je vous attends samedi à 14h ?', 'on se voit demain ?', 'Vous pouvez passer la prendre ?', 'main propre à la gare ?',
    'on peut se capter ?', 'je suis à Villeneuve-Exemple, ça vous va ?', 'Je suis dispo à 18h30', 'rdv au parking ?', 'vous pouvez venir la récupérer ?',
  ],
  paiement: [
    'Je préfère en espèces à la gare ce soir ok ?', 'paiement cash possible ?', 'un paylib ça vous va ?',
    'vous réglez comment ?', 'paiement en 2 fois ok ?', 'on peut faire ça hors leboncoin ?', 'je prends les chèques', 'Je vous donne mon IBAN ?',
  ],
  'acompte ou réservation': [
    'Envoyez moi 100€ d acompte et je vous la garde', 'il me faut des arrhes', 'une caution de 50 ?',
    'Je vous la réserve, vous me donnez votre numéro ?', 'je vous la bloque ?', 'je la mets de côté pour vous ?',
  ],
  coordonnées: [
    'vous me donnez votre numéro ?', 'appelez moi', 'voici mon mail', 'écrivez moi sur whatsapp', '06 00 00 00 00',
    'quelle est votre adresse ?', 'envoyez moi un message sur fb', 'vous pouvez me joindre ?',
  ],
  'frais à notre charge': [
    'Les frais de port sont à votre charge, ok ?', 'c’est 360 plus les frais de port', 'port en plus',
  ],
  'prix en toutes lettres': [
    'Je la fais à quatre cent cinquante, ok ?', 'finalement ce sera 3 cent 90, ok ?', 'je veux trois cents',
  ],
  'supplément': [
    'Je peux ajouter 2 jeux pour 100€ de plus', 'avec le casque il faut rajouter 30 euros', 'en supplément je vends le casque',
  ],
  'remise en différence': [
    'Je veux bien baisser de 100€', 'je vous fais une remise de 20', 'je peux enlever 30 euros', '20€ de moins ça vous va ?',
  ],
  'montant très bas': ['c’est 100€ pour vous', 'il reste 150 à régler'],
  'refus citant un montant': [
    'Non, je ne descends pas à 350€. 400€', '350€ c’est trop bas, je veux 400€', 'je ne la vends pas 350€',
    'je refuse 350€, c’est 400€', '350€ non désolé, 400€', 'à 350€ je perds trop, 400', 'vos 350€ c’est non, mon prix 400',
  ],
};

test('un message vendeur à risque ne déclenche aucun envoi', async () => {
  for (const [categorie, sellers] of Object.entries(RISQUES)) {
    for (const seller of sellers) {
      for (const [message, offre] of [
        [`d accord, ${ENVOI}`, null], [ENVOI, null], ['merci beaucoup 🙂', null], ['elle est toujours dispo ?', null],
        ['ok pour 350', 350], ['ok pour 100', 100], ['je peux faire 340', 340],
      ]) {
        const outcome = await run({ seller, offre: 350, drafts: [draft(message, offre)] });
        assertNothingSent(outcome, `${categorie} : ${seller} / ${message}`);
      }
    }
  }
});

test('le filtre couvre chaque message vendeur depuis notre dernière réponse', async () => {
  const messages = [
    { expediteur: 'moi', contenu: 'bonjour' },
    { expediteur: 'vendeur', contenu: 'envoyez un acompte' },
    { expediteur: 'vendeur', contenu: 'alors ?' },
  ];
  const outcome = await run({ seller: 'alors ?', messages, drafts: [draft(ENVOI)] });
  assertNothingSent(outcome, 'acompte avant la dernière bulle');
  assert.match(outcome.result.notes_internes, /acompte/);
  const repondu = await run({
    seller: 'alors ?', drafts: [draft(ENVOI)],
    messages: [messages[1], { expediteur: 'moi', contenu: 'non merci' }, messages[2]],
  });
  assert.equal(repondu.result.message, ENVOI);
});

test('les arrêts obligatoires gardent leur motif malgré le filtre', async () => {
  for (const [seller, raison] of [
    ['non je fais uniquement en main propre chez moi', 'paiement_leboncoin_refuse'],
    ['ok pour l’envoi, frais de port à votre charge', 'paiement_leboncoin_accepte'],
    ['elle ne s’allume plus, venez voir', 'defaut_majeur'],
  ]) {
    const stop = { ...draft(null), arret: { doit_arreter: true, raison } };
    const { result, calls } = await run({ seller, drafts: [stop] });
    assert.equal(result.arret.raison, raison, seller);
    assert.equal(calls, 1);
  }
});

test('les messages ordinaires partent toujours', async () => {
  for (const [seller, message, offre, options] of [
    ['Oui toujours disponible', 'je peux faire 340', 340],
    ['Je peux la faire à 360', 'je peux faire 340', 340],
    ['Non dernier prix 400', 'je peux faire 350', 350, { offre: 340, prix: 450 }],
    ['Ok pour 340', 'ok pour 340', 340, { offre: 340 }],
    ['Elle m’a coûté 550 neuve, je vous la laisse 300', 'ok pour 300', 300],
    ['Bonjour oui ça va et vous ?', 'je vais bien aussi merci\nje peux faire 340', 340],
    ['une manette a un petit souci', 'ça bloque quoi concrètement ?', null],
    ['Oui pas de souci, je la fais à 360', 'je peux faire 340', 340],
    ['aucun défaut, tout marche, 380 pas moins', 'je peux faire 340', 340],
    ['Je ne descends pas à moins de 380', 'je peux faire 350', 350, { offre: 340 }],
    ['380 port compris avec 2 manettes en plus', 'je peux faire 340', 340],
    ['Elle fonctionne à 100%, je viens d’avoir la nouvelle', 'je peux faire 340', 340],
    ['vous pouvez passer par le paiement leboncoin', 'je peux faire 340', 340],
    ['elle fait 825 Go, 2 manettes, achetée il y a 6 mois', 'je peux faire 340', 340],
  ]) {
    const { result } = await run({ seller, drafts: [draft(message, offre)], ...options });
    assert.ok(result.message?.startsWith(message), `${seller} -> ${result.message ?? result.notes_internes}`);
  }
});

test('un prix d’ailleurs ou d’un achat passé n’ouvre pas la dernière offre', async () => {
  for (const seller of ['Sur backmarket elle est à 400€', 'Ailleurs elle coûte 400', 'je l’ai prise 400€ en janvier',
    'sur vinted elles partent à 400€', 'un autre me propose 400€']) {
    await assert.rejects(run({ seller, offre: 350, drafts: [draft('370 dernier prix', 370)] }), /plafond 350/, seller);
  }
  const { result } = await run({ seller: 'je la laisse à 400', offre: 350, drafts: [draft('370 dernier prix', 370)] });
  assert.match(result.message, /^370 dernier prix/);
});
