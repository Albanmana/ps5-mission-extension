// Deux régimes de cadence : les requêtes leboncoin passent une par une,
// tandis que les appels au serveur local restent parallèles et bornés.

export function jitteredDelay(minMs, maxMs, random = Math.random) {
  if (!(maxMs >= minMs)) {
    throw new Error('maxMs doit être supérieur ou égal à minMs.');
  }
  return Math.round(minMs + random() * (maxMs - minMs));
}

export function createSerialQueue({ minDelayMs, maxDelayMs, sleep, random = Math.random }) {
  const pending = [];
  let running = false;
  let paused = false;
  let hasRunTask = false;

  async function drain() {
    if (running) return;
    running = true;

    try {
      while (!paused && pending.length > 0) {
        if (hasRunTask) {
          await sleep(jitteredDelay(minDelayMs, maxDelayMs, random));
          if (paused || pending.length === 0) continue;
        }

        const { task, resolve, reject } = pending.shift();
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        } finally {
          hasRunTask = true;
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    push(task) {
      const result = new Promise((resolve, reject) => {
        pending.push({ task, resolve, reject });
        void drain();
      });
      // Les consommateurs de l'extension peuvent volontairement lancer une
      // tâche sans attendre sa promesse. Observer son rejet n'en modifie pas
      // l'état pour un consommateur qui l'attend, mais évite une rejection non
      // gérée si clear() annule cette tâche en attente.
      result.catch(() => {});
      return result;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      void drain();
    },
    clear() {
      // Les tâches déjà démarrées ne peuvent pas être annulées ici. Celles qui
      // restent en attente sont retirées et leur promesse est rejetée afin de
      // ne jamais laisser un appelant attendre indéfiniment.
      const error = new Error('Queue cleared');
      while (pending.length > 0) pending.shift().reject(error);
    },
    get size() {
      return pending.length;
    },
    get paused() {
      return paused;
    },
  };
}

export function createParallelQueue({ concurrency }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency doit être un entier supérieur à zéro.');
  }

  const pending = [];
  let active = 0;

  function drain() {
    while (active < concurrency && pending.length > 0) {
      const { task, resolve, reject } = pending.shift();
      active += 1;

      Promise.resolve()
        .then(task)
        .then(
          (result) => {
            active -= 1;
            resolve(result);
            drain();
          },
          (error) => {
            active -= 1;
            reject(error);
            drain();
          },
        );
    }
  }

  return {
    push(task) {
      return new Promise((resolve, reject) => {
        pending.push({ task, resolve, reject });
        drain();
      });
    },
    get size() {
      return pending.length;
    },
    get active() {
      return active;
    },
  };
}
