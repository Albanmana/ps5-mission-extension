// Récupération d'une fiche annonce depuis le serveur, sans navigateur.
//
// leboncoin est protégé par DataDome : un `fetch` nu reçoit un 403. La requête
// passe avec l'ensemble complet des en-têtes d'une navigation réelle — le
// User-Agent seul ne suffit pas, c'est l'absence de Referer et de Sec-Fetch-*
// qui trahit le script.
//
// Ce module reproduit le mappage de extension/sw/extract-detail.js, qui
// lit le même objet `props.pageProps.ad`. Les deux doivent rester d'accord :
// tests/leboncoin-fiche.test.js verrouille les champs.

import { execFile } from 'node:child_process';

export const EN_TETES_NAVIGATEUR = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
  referer: 'https://www.leboncoin.fr/recherche?text=ps5',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'upgrade-insecure-requests': '1',
};

// L'annonce n'existe plus (vendue, retirée). Sans description elle resterait
// éternellement dans la file d'enrichissement : il faut la sortir du jeu.
export class FicheIntrouvable extends Error {
  constructor(status) {
    super(`Annonce supprimée de leboncoin (HTTP ${status}).`);
    this.name = 'FicheIntrouvable';
  }
}

export class AccesRestreint extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccesRestreint';
  }
}

function parisEnUtc(texte) {
  if (!texte) return null;
  const [date, heure = '00:00:00'] = texte.split(' ');
  const naive = Date.parse(`${date}T${heure}Z`);
  if (!Number.isFinite(naive)) return null;
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let utc = naive;
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(format.formatToParts(new Date(utc))
      .map(({ type, value }) => [type, value]));
    const paris = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
      +parts.hour, +parts.minute, +parts.second);
    const correction = naive - paris;
    if (correction === 0) return new Date(utc).toISOString();
    utc += correction;
  }
  return null;
}

const ENTITES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decoderEntites(texte) {
  return texte
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (entier, nom) => ENTITES[nom.toLowerCase()] ?? entier);
}

function texteDuBlocLivraison(html) {
  const index = html.indexOf('adview_delivery_container');
  if (index === -1) return null;
  const debut = html.lastIndexOf('<', index);
  const brut = html.slice(debut, debut + 4000);
  return decoderEntites(brut.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Le bloc rendu par le serveur ne détaille que la remise en main propre : les
// tarifs et délais d'expédition sont calculés par le navigateur après coup.
// On complète donc la disponibilité avec l'attribut `shipping_type`, et on
// laisse prix et délai à null plutôt que de les inventer — l'extension, qui
// voit le DOM final, les renseigne quand elle passe.
export function extraireModesRemise(html, ad, attributs) {
  const texte = texteDuBlocLivraison(html);
  const expedie = attributs.shippable === 'true';
  const type = attributs.shipping_type ?? null;
  const relais = /relay|relais|point|pickup|clickandcollect/i.test(type ?? '');
  const domicile = /colissimo|domicile|home|courrier|all/i.test(type ?? '');

  const lieu = texte?.match(/Remise en main propre\s*(?:À\s*)?([^.]+?)\s*(?:Rencontrez|$)/);
  return {
    type_expedition: type,
    main_propre: {
      disponible: texte ? /Remise en main propre/.test(texte) : null,
      lieu: lieu ? lieu[1].trim() : (ad.location?.city ?? null),
    },
    point_retrait: { disponible: expedie && relais, prix_min_eur: null, delai: null },
    domicile: { disponible: expedie && domicile, prix_min_eur: null, delai: null },
  };
}

// Les boutons d'action réellement proposés. « Contacter » est toujours offert
// sur une annonce de particulier active ; l'absence des deux autres est le
// signal intéressant — pas de paiement en ligne, pas d'offre négociable.
export function extraireCallToActions(attributs, ad) {
  const actions = [];
  if (ad?.status === 'active') actions.push('Contacter');
  if (attributs.negotiation_cta_visible === 'true') actions.push('Faire une offre');
  if (attributs.purchase_cta_visible === 'true') actions.push('Acheter');
  return actions;
}

export function extraireFiche(html, url) {
  if (/Accès temporairement restreint/i.test(html)) {
    throw new AccesRestreint('leboncoin a restreint l’accès.');
  }
  const brut = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!brut) throw new AccesRestreint('__NEXT_DATA__ absent : page anti-bot ou non-annonce.');

  const ad = JSON.parse(brut[1])?.props?.pageProps?.ad;
  if (!ad) throw new Error('props.pageProps.ad absent de __NEXT_DATA__.');

  const attributs = Object.fromEntries((ad.attributes ?? []).map((a) => [a.key, a.value]));
  const attribut = (...clefs) => {
    for (const clef of clefs) {
      const attr = ad.attributes?.find((a) => a.key === clef);
      if (attr) return attr.value_label ?? attr.value ?? null;
    }
    return null;
  };

  return {
    url_annonce: ad.url ?? url,
    list_id: ad.list_id != null ? String(ad.list_id) : null,
    titre: ad.subject ?? null,
    description: ad.body ?? null,
    prix_eur: Array.isArray(ad.price) ? ad.price[0] ?? null : (ad.price ?? null),
    etat: attribut('item_condition', 'condition'),
    type: attribut('video_game_type'),
    marque: attribut('brand', 'console_brand'),
    plateforme: attribut('video_game_platform', 'console_model'),
    ville: ad.location?.city ?? null,
    code_postal: ad.location?.zipcode ?? null,
    images: (ad.images?.urls_large ?? ad.images?.urls ?? [])
      .map((image) => image.replace(/rule=[^&]*/, 'rule=ad-image')),
    date_publication: parisEnUtc(ad.first_publication_date),
    livraison_possible: attributs.shippable === 'true',
    sponsorise: Boolean(ad.options?.booster || ad.options?.urgent || ad.options?.highlight),
    likes: ad.counters?.favorites ?? null,
    modes_remise: extraireModesRemise(html, ad, attributs),
    call_to_actions: extraireCallToActions(attributs, ad),
  };
}

// Transport : `curl`, pas le fetch de Node.
//
// À en-têtes strictement identiques, curl reçoit 200 et le fetch de Node 403 :
// DataDome ne juge pas que les en-têtes, il reconnaît la signature TLS du
// client. Cette dépendance est donc fragile par nature — si le 403 revient,
// c'est ce transport qu'il faudra revoir, pas les en-têtes.
async function fetchViaCurl(url, { headers }) {
  const args = ['-sS', '--compressed', '--max-time', '25', '-w', '\n%{http_code}'];
  for (const [nom, valeur] of Object.entries(headers)) args.push('-H', `${nom}: ${valeur}`);
  args.push(url);

  const { stdout } = await new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 32 * 1024 * 1024 }, (error, out, err) => {
      if (error) reject(new Error(`curl a échoué : ${err?.trim() || error.message}`));
      else resolve({ stdout: out });
    });
  });

  const coupure = stdout.lastIndexOf('\n');
  const status = Number.parseInt(stdout.slice(coupure + 1), 10);
  const corps = stdout.slice(0, coupure);
  return { ok: status >= 200 && status < 300, status, text: async () => corps };
}

export async function recupererFiche(url, { fetch: request = fetchViaCurl } = {}) {
  const response = await request(url, { headers: { ...EN_TETES_NAVIGATEUR }, redirect: 'follow' });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      throw new AccesRestreint(`leboncoin a refusé la requête (HTTP ${response.status}).`);
    }
    if (response.status === 404 || response.status === 410) throw new FicheIntrouvable(response.status);
    throw new Error(`Fiche annonce indisponible (HTTP ${response.status}).`);
  }
  return extraireFiche(await response.text(), url);
}

// Rythme de consultation.
//
// Un intervalle fixe est exactement ce qui distingue un script d'un humain.
// On tire donc un délai au hasard dans une fourchette large, et on marque une
// pause plus longue tous les quelques appels, comme quelqu'un qui s'interrompt.

export const DELAI_MIN_MS = 4000;
export const DELAI_MAX_MS = 11000;
export const PAUSE_TOUS_LES = 7;
export const PAUSE_LONGUE_MS = 45000;

export function delaiProchaineRequete(rang, {
  min = DELAI_MIN_MS, max = DELAI_MAX_MS, alea = Math.random,
  pauseTousLes = PAUSE_TOUS_LES, pauseLongue = PAUSE_LONGUE_MS,
} = {}) {
  const base = Math.round(min + alea() * (max - min));
  if (rang > 0 && rang % pauseTousLes === 0) return base + Math.round(pauseLongue * (0.5 + alea()));
  return base;
}

export const patienter = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
