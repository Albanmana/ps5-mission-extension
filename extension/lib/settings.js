// Réglages choisis par l'utilisateur dans le panneau. Aucune clé API ici :
// elles restent dans le .env du serveur local.

export const SETTINGS_KEY = 'ps5_settings';

export const DEFAULT_SETTINGS = Object.freeze({
  dryRun: false,
  ownerName: '',
  handoffEmail: '',
  goodPrice: 350,
  maxPrice: 370,
  replyScope: 'contacted',
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const price = (value) => Number.isInteger(value) && value >= 100 && value <= 2000;

// L'envoi est réel par défaut : seuls « rien d'enregistré » et « dryRun: false »
// l'autorisent. Un mode enregistré mais douteux reste en simulation.
function modeSimulation(raw) {
  if (raw === undefined) return false;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  return raw.dryRun !== undefined && raw.dryRun !== false;
}

// Pour le reste, toute valeur douteuse retombe sur le défaut.
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const email = typeof source.handoffEmail === 'string' ? source.handoffEmail.trim() : '';
  const pricesValid = price(source.goodPrice) && price(source.maxPrice) && source.goodPrice <= source.maxPrice;
  return {
    dryRun: modeSimulation(raw),
    ownerName: typeof source.ownerName === 'string' ? source.ownerName.trim().slice(0, 80) : '',
    handoffEmail: EMAIL.test(email) ? email : '',
    goodPrice: pricesValid ? source.goodPrice : DEFAULT_SETTINGS.goodPrice,
    maxPrice: pricesValid ? source.maxPrice : DEFAULT_SETTINGS.maxPrice,
    replyScope: source.replyScope === 'all' ? 'all' : 'contacted',
  };
}

export async function loadSettings(chrome) {
  return normalizeSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
}

export async function saveSettings(chrome, value) {
  const settings = normalizeSettings(value);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}
