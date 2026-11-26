import assert from 'node:assert/strict';
import test from 'node:test';

import { chargerImage, analyzeImages, MAX_IMAGE_BYTES } from '../scripts/classify.js';

const PIXEL = Buffer.from('ffd8ffdb0043', 'hex'); // en-tête JPEG, suffisant ici

function reponse({ ok = true, status = 200, type = 'image/jpeg', corps = PIXEL, taille } = {}) {
  return {
    ok,
    status,
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? type
      : n.toLowerCase() === 'content-length' ? (taille ?? String(corps.length)) : null) },
    arrayBuffer: async () => corps.buffer.slice(corps.byteOffset, corps.byteOffset + corps.byteLength),
  };
}

test('chargerImage rend une data URL base64 exploitable par une API de vision', async () => {
  const image = await chargerImage('https://img.leboncoin.fr/x.jpg', { fetch: async () => reponse() });

  assert.equal(image, `data:image/jpeg;base64,${PIXEL.toString('base64')}`);
});

test('chargerImage renonce sur un refus du CDN plutôt que de faire échouer le run', async () => {
  const image = await chargerImage('https://img.leboncoin.fr/x.jpg', {
    fetch: async () => reponse({ ok: false, status: 403 }),
  });

  assert.equal(image, null);
});

test('chargerImage renonce si la réponse n’est pas une image', async () => {
  const image = await chargerImage('https://img.leboncoin.fr/x.jpg', {
    fetch: async () => reponse({ type: 'text/html' }),
  });

  assert.equal(image, null);
});

test('chargerImage renonce au-delà de la taille maximale annoncée', async () => {
  const image = await chargerImage('https://img.leboncoin.fr/x.jpg', {
    fetch: async () => reponse({ taille: String(MAX_IMAGE_BYTES + 1) }),
  });

  assert.equal(image, null);
});

test('chargerImage renonce si le réseau tombe', async () => {
  const image = await chargerImage('https://img.leboncoin.fr/x.jpg', {
    fetch: async () => { throw new Error('ECONNRESET'); },
  });

  assert.equal(image, null);
});

test('analyzeImages transmet des données inline, jamais une URL leboncoin', async () => {
  let envoye;
  await analyzeImages(
    { images: ['https://img.leboncoin.fr/a.jpg?rule=ad-image-avif'] },
    {
      charger: async () => 'data:image/jpeg;base64,AAAA',
      demander: async (_path, body) => {
        envoye = body;
        return { choices: [{ message: { content: '{"lecteur_disque_visible":true}' } }] };
      },
    },
  );

  const images = envoye.messages[0].content.filter((p) => p.type === 'image_url');
  assert.equal(images.length, 1);
  assert.equal(images[0].image_url.url, 'data:image/jpeg;base64,AAAA');
  // C'était la cause du 403 : laisser un tiers aller chercher l'image.
  assert.ok(!JSON.stringify(envoye).includes('img.leboncoin.fr'));
});

test('analyzeImages garde les images valides et ignore celles qui échouent', async () => {
  let envoye;
  await analyzeImages(
    { images: ['https://img.leboncoin.fr/ok.jpg', 'https://img.leboncoin.fr/ko.jpg'] },
    {
      charger: async (url) => (url.includes('ok') ? 'data:image/jpeg;base64,AAAA' : null),
      demander: async (_path, body) => {
        envoye = body;
        return { choices: [{ message: { content: '{}' } }] };
      },
    },
  );

  const images = envoye.messages[0].content.filter((p) => p.type === 'image_url');
  assert.equal(images.length, 1);
});

test('si aucune image n’est récupérable, la classification continue sans vision', async () => {
  let appele = false;
  const vision = await analyzeImages(
    { images: ['https://img.leboncoin.fr/ko.jpg'] },
    {
      charger: async () => null,
      demander: async () => { appele = true; return {}; },
    },
  );

  assert.equal(appele, false, 'inutile d’appeler le modèle sans aucune image');
  assert.equal(vision.lecteur_disque_visible, null);
  assert.match(vision.notes, /image/i);
});
