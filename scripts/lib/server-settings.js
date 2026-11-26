// Réglages transmis par l'extension. extension/lib/settings.js reste la seule
// source des valeurs et de leur normalisation.
import { DEFAULT_SETTINGS, normalizeSettings } from '../../extension/lib/settings.js';

export { DEFAULT_SETTINGS };

// Sans objet de réglages (ancien client) : défauts, donc envoi réel, et le tour
// est réservé. Un client qui ignore la simulation enverrait sinon sans
// anti-doublon. Une valeur qui n'est pas un objet compte comme absente ; dans un
// objet, un dryRun douteux reste en simulation.
export function readSettings(raw) {
  return normalizeSettings(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined);
}

export function ownerLabel(settings, fallback = "l'utilisateur") {
  // Le nom entre dans le prompt : jamais sur plusieurs lignes.
  return String(settings?.ownerName ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
}

export const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
