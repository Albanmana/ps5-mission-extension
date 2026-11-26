// Cette fonction injectée reste volontairement minuscule et sans exception :
// Chrome doit seulement sérialiser quelques chaînes, jamais tout le parseur.
export function collecterDetailDepuisDocument() {
  const texte = document.body?.textContent || '';
  if (/Accès temporairement restreint/i.test(texte)) return { erreur: 'leboncoin a restreint l’accès.' };
  const brut = document.getElementById('__NEXT_DATA__');
  // Les pages actives embarquent aussi le texte d'une modale masquée
  // « Cette annonce est désactivée ». La donnée structurée de l'annonce est
  // l'autorité ; le texte de page ne sert qu'en son absence.
  if (!brut && /Cette annonce est désactivée/i.test(texte)) {
    return { erreur: 'Annonce leboncoin désactivée.' };
  }
  if (!brut) return { erreur: '__NEXT_DATA__ absent : ce n’est pas une page annonce.' };
  const livraison = document.querySelector?.('[data-qa-id="adview_delivery_container"]');
  // innerText ignore la modale masquée des annonces actives.
  const desactivee = /Cette annonce est désactivée/i.test(document.body?.innerText || '');
  return { href: location.href, nextData: brut.textContent, livraison: livraison?.textContent ?? null, desactivee };
}

export function extraireDetailDepuisDonneesBrutes(donnees) {
  if (donnees?.erreur) throw new Error(donnees.erreur);
  if (typeof donnees?.nextData !== 'string') {
    throw new Error('__NEXT_DATA__ absent : ce n’est pas une page annonce.');
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
    for (let i = 0; i < 3; i++) {
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

  const ad = JSON.parse(donnees.nextData)?.props?.pageProps?.ad;
  if (!ad && donnees.desactivee) throw new Error('Annonce leboncoin désactivée.');
  if (!ad) throw new Error('props.pageProps.ad absent de __NEXT_DATA__.');
  if (ad.status && ad.status !== 'active') throw new Error('Annonce leboncoin désactivée.');
  const attribut = (...clefs) => {
    for (const clef of clefs) {
      const attr = ad.attributes?.find((a) => a.key === clef);
      if (attr) return attr.value_label ?? attr.value ?? null;
    }
    return null;
  };
  const valeur = Object.fromEntries((ad.attributes ?? []).map((a) => [a.key, a.value]));
  const relais = /relay|relais|point|pickup/i.test(valeur.shipping_type ?? '');
  const aDomicile = /colissimo|domicile|home|all/i.test(valeur.shipping_type ?? '');
  const expedie = valeur.shippable === 'true';

  function modesRemise() {
    const texte = typeof donnees.livraison === 'string'
      ? donnees.livraison.replace(/\s+/g, ' ').trim()
      : null;
    const offre = (libelle, defaut) => {
      if (!texte) return { disponible: defaut, prix_min_eur: null, delai: null };
      const m = texte.match(new RegExp(`${libelle}\\s*(?:Dès\\s*)+([\\d,]+)\\s?€.*?(\\d+(?:\\s?à\\s?\\d+)?\\s?jours?\\s?ouvrés)`, 'i'));
      if (!m) return { disponible: defaut, prix_min_eur: null, delai: null };
      return { disponible: true, prix_min_eur: parseFloat(m[1].replace(',', '.')), delai: m[2] };
    };
    const lieu = texte?.match(/Remise en main propre\s*(?:À\s*)?([^.]+?)\s*(?:Rencontrez|$)/);
    return {
      type_expedition: valeur.shipping_type ?? null,
      main_propre: {
        disponible: texte ? /Remise en main propre/.test(texte) : null,
        lieu: lieu ? lieu[1].trim() : (ad.location?.city ?? null),
      },
      point_retrait: offre('Point de retrait', expedie && relais),
      domicile: offre('À domicile', expedie && aDomicile),
    };
  }

  function callToActions() {
    const actions = [];
    if (ad.status === 'active') actions.push('Contacter');
    if (valeur.negotiation_cta_visible === 'true') actions.push('Faire une offre');
    if (valeur.purchase_cta_visible === 'true') actions.push('Acheter');
    return actions;
  }

  return {
    url_annonce: ad.url ?? donnees.href?.split('?')[0],
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
      .map((url) => url.replace(/rule=[^&]*/, 'rule=ad-image')),
    date_publication: parisEnUtc(ad.first_publication_date),
    livraison_possible: expedie,
    sponsorise: Boolean(ad.options?.booster || ad.options?.urgent || ad.options?.highlight),
    likes: ad.counters?.favorites ?? null,
    modes_remise: modesRemise(),
    call_to_actions: callToActions(),
  };
}
