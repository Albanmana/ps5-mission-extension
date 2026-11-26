// Lecture du .env à la racine du projet, factorisée : quatre scripts en
// avaient chacun leur copie identique.
import { readFileSync } from 'node:fs';

const DEFAULT_ENV_URL = new URL('../../.env', import.meta.url);

export function parseEnv(content) {
  const values = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

export function loadEnv(target = process.env, envUrl = DEFAULT_ENV_URL) {
  let content;
  try {
    content = readFileSync(envUrl, 'utf8');
  } catch {
    return target; // pas de .env : on continue avec l'environnement existant
  }
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (!target[key]) target[key] = value;
  }
  return target;
}
