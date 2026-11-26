// Frappe simulée à rythme humain, partagée par les scripts de contact et de
// réponse.
// `random` et `sleep` sont injectables pour rendre les délais testables.

export function randomBetween(min, max, random = Math.random) {
  return min + random() * (max - min);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Le champ leboncoin est un composant React contrôlé : affecter `.value`
// directement ne déclenche pas le re-render (le bouton d'envoi resterait
// désactivé). Il faut passer par le setter natif du prototype.
export function setNativeValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  setter.call(el, value);
}

// Délai avant le caractère suivant : base lente, pause supplémentaire après
// un espace ou une ponctuation, et hésitation occasionnelle.
export function nextCharDelay(prevChar, random = Math.random) {
  let delay = randomBetween(70, 160, random);
  if (prevChar === ' ') delay += randomBetween(40, 120, random);
  if (prevChar && /[,.!?]/.test(prevChar)) delay += randomBetween(150, 400, random);
  if (random() < 0.05) delay += randomBetween(300, 700, random);
  return delay;
}

export async function typeInto(el, text, options = {}) {
  const {
    sleep: wait = sleep,
    random = Math.random,
    setValue = setNativeValue,
    doitArreter = () => false,
  } = options;

  el.focus();
  let current = '';
  let prevChar = null;
  for (const char of text) {
    await wait(nextCharDelay(prevChar, random));
    if (doitArreter()) break;
    current += char;
    setValue(el, current);
    el.dispatchEvent(
      typeof Event === 'function' ? new Event('input', { bubbles: true }) : { type: 'input' },
    );
    prevChar = char;
  }
  return el;
}
