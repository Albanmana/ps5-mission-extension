import assert from 'node:assert/strict';
import test from 'node:test';
import { HOLD, deferred, monter } from './helpers/panel-chrome.js';
import { buttonNamed, links, settle, visible } from './helpers/panel-dom.js';

const URL = 'https://www.leboncoin.fr/messages/id/00000000-0000-4000-8000-000000000101';
const poison = '<img src=x onerror=alert(1)>';

async function fixture({
  state = { enabled: true, status: 'idle', nextRunAt: Date.parse('2026-09-26T12:30:00Z'), lastResult: null, lastError: null },
  conversations = [], failure, hold, reservations = [], ...options
} = {}) {
  const replies = {
    'conversations-etat': { etat: state },
    'conversations-liste': { conversations },
    'conversations-verifier': { etat: { ...state, lastResult: 'no_unread' } },
    'conversations-pause': { etat: { ...state, enabled: false, status: 'paused', nextRunAt: null } },
    'conversations-activer': (m) => ({ etat: { ...state, enabled: m.enabled, status: 'idle' } }),
    'conversations-handoff-traite': { etat: { ...state, handoffs: {} } },
    'conversations-echec-traite': { etat: { ...state, echecs: {} } },
    'contact-reservations': { ok: true, reservations },
  };
  if (failure) replies[failure.type] = { ok: false, error: failure.error };
  if (hold) replies[hold] = HOLD;
  const f = await monter({ replies, wait: !hold, ...options });
  await settle();
  return Object.assign(f, {
    live: (message) => f.chrome.live(message),
    on: () => f.el('conversations-active').getAttribute('aria-checked') === 'true',
  });
}
const cartes = (f) => f.el('conversations-handoffs').children;

test('l’autopilote actif est affiché avec son prochain passage', async () => {
  const f = await fixture();
  assert.equal(f.on(), true);
  assert.equal(f.el('conversations-active').getAttribute('role'), 'switch');
  assert.match(f.el('conversations-statut').textContent, /actif|prêt/i);
  assert.match(f.el('conversations-prochain').textContent, /prochain/i);
  assert.equal(f.sent('conversations-etat').length, 1);
  assert.equal(f.sent('conversations-liste').length, 1);
});

test('vérification immédiate et pause transmettent les commandes et actualisent les contrôles', async () => {
  const f = await fixture();
  const avant = f.chrome.messages.length;
  await f.click('conversations-verifier');
  assert.deepEqual(f.chrome.messages.slice(avant).map((m) => m.type), ['conversations-verifier', 'conversations-liste']);
  assert.match(f.el('conversations-resultat').textContent, /aucun.*non lu/i);
  assert.match(f.el('toast-texte').textContent, /aucun.*non lu/i);
  await f.click('conversations-active');
  assert.equal(f.chrome.messages.at(-1).type, 'conversations-pause');
  assert.equal(f.on(), false);
});

test('réactiver envoie l’activation explicite', async () => {
  const f = await fixture({ state: { enabled: false, status: 'paused' } });
  await f.click('conversations-active');
  assert.deepEqual(f.sent('conversations-activer'), [{ type: 'conversations-activer', enabled: true }]);
  assert.equal(f.on(), true);
});

test('une conversation vendeur déjà traitée est balisée comme reprise humaine, avec tous ses détails', async () => {
  const f = await fixture({ conversations: [{
    url_conversation: URL, vendeur: 'VendeurIota', dernier_message: 'La ps5 surchauffe',
    dernier_message_de: 'vendeur', traite_le: '2026-09-27T21:19:40.546Z', non_lus: 2, automation_erreur_code: 'generation_echec',
  }, { url_conversation: URL, vendeur: 'Bob', dernier_message: 'je peux faire 340', dernier_message_de: 'moi' }] });
  const [a, b] = f.el('conversations-liste').children.map((li) => li.textContent);
  assert.match(a, /dernier : vendeur.*traitée.*reprise humaine.*2 non lu\(s\).*erreur : generation_echec/i);
  assert.match(a, /Non lu/);
  assert.match(b, /En attente.*Vous : je peux faire 340/);
});

test('les données vendeur sont du texte et seules les URL conversation valides deviennent des liens', async () => {
  const f = await fixture({ conversations: [
    { url_conversation: URL, vendeur: poison, annonce_titre: poison, dernier_message: poison, dernier_message_de: 'vendeur', non_lus: 1 },
    { url_conversation: 'javascript:alert(1)', vendeur: poison, annonce_titre: poison },
  ] });
  assert.ok(f.el('conversations-liste').textContent.includes(poison));
  const liens = links(f.el('conversations-liste'));
  assert.equal(liens.length, 1);
  assert.equal(liens[0].href, URL);
  assert.equal(liens[0].rel, 'noopener noreferrer');
});

test('une mise à jour live est rendue et une erreur de commande reste actionnable', async () => {
  const f = await fixture({ failure: { type: 'conversations-verifier', error: poison } });
  f.live({ type: 'conversations-maj', etat: {
    enabled: true, status: 'blocked', lastError: 'bloque', nextRunAt: Date.parse('2026-09-26T13:30:00Z'),
  } });
  assert.match(f.el('conversations-statut').textContent, /bloqué/i);
  assert.match(f.el('conversations-statut').textContent, /actif/i);
  assert.match(f.el('conversations-erreur').textContent, /bloque/);
  assert.match(f.el('conversations-prochain').textContent, /prochain/i);
  assert.equal(f.el('conversations-verifier').disabled, false);
  assert.equal(f.el('conversations-active').disabled, false);
  f.live({ type: 'conversations-maj', etat: { enabled: true, status: 'idle', lastError: null, nextRunAt: null } });
  await f.click('conversations-verifier');
  assert.equal(f.el('conversations-erreur').textContent, poison);
  assert.equal(f.el('conversations-verifier').disabled, false);
});

test('en reprise ou bloqué, l’autopilote reste actif et seul l’interrupteur le coupe', async () => {
  const f = await fixture({ state: {
    enabled: true, status: 'retrying', processingFingerprint: null, lastError: 'generation_echec',
    nextRunAt: Date.parse('2026-09-26T12:35:00Z'),
  } });
  assert.match(f.el('conversations-statut').textContent, /actif.*nouvelle tentative/i);
  assert.equal(f.on(), true);
  assert.equal(f.el('conversations-active').disabled, false);
  await f.click('conversations-active');
  assert.equal(f.chrome.messages.at(-1).type, 'conversations-pause');
  f.live({ type: 'conversations-maj', etat: { enabled: true, status: 'blocked', processingFingerprint: null, lastError: 'bloque' } });
  assert.equal(f.on(), true);
  assert.equal(f.el('conversations-active').disabled, false);
  assert.equal(f.el('conversations-verifier').disabled, false);
});

test('désactivé par défaut : interrupteur coupé, vérification indisponible', async () => {
  const f = await fixture({ state: { enabled: false, status: 'paused' } });
  assert.equal(f.on(), false);
  assert.equal(f.el('conversations-verifier').disabled, true);
  assert.equal(f.el('conversations-active').disabled, false);
  assert.match(f.el('conversations-statut').textContent, /en pause.*aucune réponse ne part/i);
  await f.click('conversations-verifier');
  assert.equal(f.sent('conversations-verifier').length, 0);
});

test('Pause reste cliquable et part pendant qu’une vérification est en cours', async () => {
  const f = await fixture();
  f.chrome.replies['conversations-verifier'] = HOLD;
  void f.click('conversations-verifier');
  f.live({ type: 'conversations-maj', etat: { enabled: true, status: 'running' } });
  assert.equal(f.el('conversations-active').disabled, false);
  assert.equal(f.el('conversations-verifier').disabled, true);
  await f.click('conversations-active');
  assert.equal(f.chrome.messages.at(-1).type, 'conversations-pause');
  assert.equal(f.on(), false);
});

test('un état illisible ne permet pas d’activer, mais permet toujours de mettre en pause', async () => {
  const f = await fixture({ failure: { type: 'conversations-etat', error: 'Service worker arrêté' } });
  assert.equal(f.el('conversations-active').disabled, true);
  assert.match(f.el('conversations-statut').textContent, /illisible/);
  assert.match(f.el('conversations-erreur').textContent, /Service worker arrêté/);
  assert.equal(f.el('tout-a-jour').hidden, true);
  assert.equal(f.el('conversations-pause').hidden, false);
  await f.click('conversations-pause');
  assert.equal(f.sent('conversations-pause').length, 1);
});

test('chaque lastResult est expliqué en français, y compris le bilan et un code inconnu', async () => {
  const f = await fixture();
  for (const [lastResult, expected] of [
    ['waiting_for_tab', /onglet Messages/], ['no_unread', /aucun message non lu/i],
    ['no_seller_message', /pas de nouveau message vendeur/], ['duplicate', /déjà été traité/],
    ['handoff', /reprise manuelle/], ['sent', /envoyée et enregistrée/], ['outside_hours', /08:00–22:59/],
    ['acknowledged', /vérifié manuellement/i], ['requires_review', /vérifier manuellement/],
    ['dry_run', /simulation.*rien.*envoyé/i], ['hors_perimetre', /hors périmètre/i],
    ['interrompu', /interrompue/i], ['code_nouveau', /Dernier résultat : code_nouveau/],
  ]) {
    f.live({ type: 'conversations-maj', etat: { enabled: true, status: 'idle', lastResult } });
    assert.match(f.el('conversations-resultat').textContent, expected, lastResult);
  }
  f.live({ type: 'conversations-maj', etat: { enabled: true, status: 'idle', lastResult: 'batch_complete', lastBatchProcessed: 3 } });
  assert.match(f.el('conversations-resultat').textContent, /Réponses ou reprises : 3\./);
  f.live({ type: 'conversations-maj', etat: { enabled: true, status: 'etrange', lastResult: null } });
  assert.match(f.el('conversations-statut').textContent, /État : etrange/);
});

test('les reprises humaines sont affichées et peuvent être marquées comme faites', async () => {
  const base = { url_conversation: URL, vendeur: poison, raison: 'paiement_leboncoin_accepte', notes: 'À payer', cree_le: 1 };
  const f = await fixture({ state: { enabled: true, status: 'idle', handoffs: {
    a: { ...base, fingerprint: 'a', enregistre: false, offre_recue_eur: 340, lieu_propose: 'Gare' },
    b: { ...base, fingerprint: 'b', enregistre: true, notified: false, cree_le: 2 },
    c: { ...base, fingerprint: 'c', dryRun: true, cree_le: 3 },
  } } });
  const text = f.el('conversations-handoffs').textContent;
  assert.ok(text.includes(poison));
  assert.match(text, /Envoi accepté : le paiement est à vous/);
  assert.match(text, /À payer/);
  assert.match(text, /offre reçue : 340 €.*lieu : Gare/);
  assert.match(text, /en attente/i);
  assert.match(text, /sans e-mail/i);
  assert.match(text, /simulation/i);
  assert.equal(f.el('a-vous').textContent, 'À vous (3)');
  assert.equal(f.el('nav-accueil').textContent, 'Accueil (3)');
  assert.equal(f.el('tout-a-jour').hidden, true);
  assert.equal(links(cartes(f)[0])[0].textContent, 'Ouvrir la conversation');
  await buttonNamed(cartes(f)[0], 'C’est fait').fire('click');
  assert.deepEqual(f.chrome.messages.at(-1), { type: 'conversations-handoff-traite', fingerprint: 'c' });
  assert.equal(cartes(f).length, 0);
  assert.equal(f.el('tout-a-jour').hidden, false);
  assert.equal(f.el('a-vous').hidden, true);
  assert.equal(f.el('nav-accueil').textContent, 'Accueil');
  assert.match(f.el('toast-texte').textContent, /classée/);
  assert.equal(buttonNamed(f.el('toast'), 'Annuler'), undefined, 'rien ne peut restaurer une carte');
});

test('un échec de « C’est fait » garde la carte, sans message de réussite', async () => {
  const f = await fixture({ failure: { type: 'conversations-handoff-traite', error: 'Stockage plein' },
    state: { enabled: true, status: 'idle', handoffs: { a: { fingerprint: 'a', url_conversation: 'javascript:alert(1)', cree_le: 1 } } } });
  assert.equal(links(cartes(f)[0]).length, 0);
  assert.match(cartes(f)[0].textContent, /Lien de conversation indisponible/);
  await buttonNamed(cartes(f)[0], 'C’est fait').fire('click');
  assert.equal(cartes(f).length, 1);
  assert.equal(f.el('conversations-erreur').textContent, 'Stockage plein');
  assert.equal(f.el('toast').hidden, true);
});

test('chaque motif d’arrêt a son titre', async () => {
  const attendu = {
    paiement_leboncoin_refuse: /paiement leboncoin refusé/, rdv_confirme: /rendez-vous/,
    refus_categorique_prix: /refus catégorique sur le prix/, defaut_majeur: /défaut majeur/,
    question_importante: /Réponse à rédiger vous-même/, autre: /Reprise nécessaire/,
  };
  const f = await fixture();
  for (const [raison, texte] of Object.entries(attendu)) {
    f.live({ type: 'conversations-maj', etat: { enabled: true, status: 'idle',
      handoffs: { x: { fingerprint: 'x', url_conversation: URL, raison, cree_le: 1 } } } });
    assert.match(f.el('conversations-handoffs').textContent, texte, raison);
  }
  f.live({ type: 'conversations-maj', etat: { enabled: true, status: 'idle',
    handoffs: { x: { fingerprint: 'x', url_conversation: URL, enregistre: true, notified: true, cree_le: 1 } } } });
  assert.match(f.el('conversations-handoffs').textContent, /Enregistrée, e-mail envoyé/);
});

test('un fil abandonné après échecs est à reprendre manuellement et peut être marqué fait', async () => {
  const entry = { essais: 3, abandonne: true, traite: false, vendeur: poison, message_vendeur: 'Oui disponible', cree_le: 1 };
  const f = await fixture({ state: { enabled: true, status: 'idle', echecs: {
    [URL]: entry,
    'https://www.leboncoin.fr/messages/id/cccccccc-1111-2222-3333-dddddddddddd': { ...entry, abandonne: false, vendeur: 'EnAttente' },
    'https://www.leboncoin.fr/messages/id/eeeeeeee-1111-2222-3333-ffffffffffff': { ...entry, traite: true, vendeur: 'DejaTraite' },
  } } });
  const text = f.el('conversations-handoffs').textContent;
  assert.ok(text.includes(poison));
  assert.match(text, /réponse automatique impossible/i);
  assert.match(text, /3 essai/i);
  assert.match(text, /Oui disponible/);
  assert.doesNotMatch(text, /EnAttente|DejaTraite/);
  await buttonNamed(cartes(f)[0], 'C’est fait').fire('click');
  assert.deepEqual(f.chrome.messages.at(-1), { type: 'conversations-echec-traite', url_conversation: URL });
});

test('un fil jamais lu montre son aperçu et l’interruption', async () => {
  const f = await fixture({ state: { enabled: true, status: 'idle', echecs: {
    [URL]: { code: 'interrompu', preview: 'aperçu du fil', essais: 0, abandonne: true, traite: false, cree_le: 1 },
  } } });
  assert.match(f.el('conversations-handoffs').textContent, /aperçu du fil.*interrompue avant tout envoi/);
});

test('les conversations ignorées hors périmètre sont comptées et listées', async () => {
  const vide = await fixture();
  assert.equal(vide.el('conversations-ignorees-titre').textContent, 'Conversations ignorées (0)');
  assert.match(vide.el('conversations-ignorees').textContent, /aucune/i);
  assert.equal(vide.el('tout-a-jour').hidden, false);
  const f = await fixture({ state: { enabled: true, status: 'idle', ignorees: {
    [URL]: { vendeur: 'VendeurAlpha', annonce_titre: poison, message_vendeur: 'je peux faire 340', ignore_le: 5 },
  } } });
  assert.equal(f.el('conversations-ignorees-titre').textContent, 'Conversations ignorées (1)');
  assert.match(f.el('conversations-ignorees').textContent, /VendeurAlpha/);
  assert.match(f.el('conversations-ignorees').textContent, /je peux faire 340/);
  assert.match(f.el('conversations-ignorees-aide').textContent, /répondez vous-même/i);
  assert.equal(links(f.el('conversations-ignorees'))[0].href, URL);
});

test('un envoi non confirmé est à reprendre manuellement avec un texte explicite', async () => {
  const f = await fixture({ state: { enabled: true, status: 'retrying', handoffs: { abc: {
    url_conversation: URL, fingerprint: 'abc', dryRun: false, enregistre: true, raison: 'envoi_incertain',
    vendeur: 'VendeurAlpha', notes: 'Réponse peut-être envoyée : ok', cree_le: 5,
  } } } });
  const texte = f.el('conversations-handoffs').textContent;
  assert.match(texte, /Envoi non confirmé/);
  assert.match(texte, /ne sera pas renvoyé/);
  assert.doesNotMatch(texte, /sans e-mail|Enregistrée/);
});

test('les envois à vérifier comptent avec les reprises', async () => {
  const f = await fixture({
    reservations: [{ url_annonce: 'https://www.leboncoin.fr/ad/consoles/1', reservation_le: '2026-11-25T10:00:00Z' }],
    state: { enabled: true, status: 'idle', handoffs: { a: { fingerprint: 'a', url_conversation: URL, cree_le: 1 } } },
  });
  assert.equal(f.el('nav-accueil').textContent, 'Accueil (2)');
  assert.equal(f.el('tout-a-jour').hidden, true);
});

test('l’écran Conversations s’ouvre depuis l’Accueil et recharge la liste', async () => {
  const f = await fixture();
  await f.click('voir-conversations');
  assert.equal(f.el('ecran-conversations').hidden, false);
  assert.equal(f.el('titre').textContent, 'Conversations');
  assert.equal(f.el('retour').hidden, false);
  assert.equal(f.sent('conversations-liste').length, 2);
  assert.match(f.el('ecran-conversations').textContent, /jusqu’à 50 conversations/);
  await f.click('retour');
  assert.equal(f.el('ecran-accueil').hidden, false);
});

const pilote = (f) => f.el('pilote-etat').textContent;

test('la ligne du pilote n’annonce des envois que si quelque chose peut partir', async () => {
  const arret = await fixture({ state: { enabled: false, status: 'paused' } });
  assert.equal(pilote(arret), 'À l’arrêt');
  const reel = await fixture();
  assert.equal(pilote(reel), 'En marche, les messages partent');
  const essai = await fixture({ settings: { dryRun: true } });
  assert.equal(pilote(essai), 'En marche, en mode test');
  const inconnu = await fixture({ failGet: true });
  assert.match(pilote(inconnu), /Mode inconnu/);
  arret.chrome.live({ type: 'recherche-auto-maj', etat: { enabled: true, status: 'idle', options: { contactAuto: false } } });
  assert.equal(pilote(arret), 'En marche, aucun envoi automatique');
  arret.chrome.live({ type: 'run-maj', etat: { statut: 'en_cours', contactAuto: true, annonces: {} } });
  assert.equal(pilote(arret), 'En marche, les messages partent');
});

test('un état illisible n’est jamais présenté comme « À l’arrêt » ou sans envoi', async () => {
  const f = await fixture({ failure: { type: 'conversations-etat', error: 'x' } });
  assert.doesNotMatch(pilote(f), /À l’arrêt/);
  f.chrome.live({ type: 'recherche-auto-maj', etat: { enabled: true, status: 'idle', options: { contactAuto: false } } });
  assert.doesNotMatch(pilote(f), /aucun envoi/);
});

test('une échéance d’un autre jour garde sa date', async () => {
  const demain = new Date(Date.now() + 86_400_000);
  const f = await fixture({ state: { enabled: true, status: 'idle', nextRunAt: demain.getTime() } });
  assert.match(f.el('conversations-prochain').textContent, /\d{2}\/\d{2}\/\d{4}/);
  assert.match(f.el('ecran-accueil').textContent, /plusieurs réponses peuvent partir/);
});

test('une carte redevient nette si « C’est fait » échoue après une mise à jour reçue entre-temps', async () => {
  const handoffs = { a: { fingerprint: 'a', url_conversation: URL, cree_le: 1 } };
  const f = await fixture({ state: { enabled: true, status: 'idle', handoffs } });
  const reponse = deferred();
  f.chrome.replies['conversations-handoff-traite'] = () => reponse.promise;
  const clic = buttonNamed(cartes(f)[0], 'C’est fait').fire('click');
  f.live({ type: 'conversations-maj', etat: { enabled: true, status: 'idle', handoffs } });
  assert.match(cartes(f)[0].className, /en-attente/);
  reponse.resolve({ ok: false, error: 'Stockage plein' });
  await clic;
  assert.doesNotMatch(cartes(f)[0].className, /en-attente/);
});

test('en envoi réel, une ligne près de « Vérifier maintenant » prévient que plusieurs réponses peuvent partir', async () => {
  const avis = (f) => (visible(f.root, f.el('avis-verifier')) ? f.el('avis-verifier').textContent : '');
  const f = await fixture();
  assert.match(avis(f), /Un seul appui peut envoyer plusieurs réponses.*50 conversations.*hors horaires/);
  f.chrome.emit({ dryRun: true });
  assert.equal(avis(f), '');
  f.chrome.emit({ dryRun: false });
  assert.notEqual(avis(f), '');
  assert.equal(avis(await fixture({ settings: { dryRun: true } })), '');
});
