// Un HMR que falla no se reintenta: el cliente de vite descarta el import que tiró (fetchUpdate + warnFailedUpdate,
// vite/dist/client/client.mjs:640-646). En c7c7ec26 el sistema remontó App mientras 01-navbar.tsx no compilaba; cada
// update de App falló, el arreglo del navbar solo actualizó el navbar y el iframe se quedó con el App del principio
// (navbar y main vacío) hasta después de settled. Vite avisa el error por el socket antes de responder el 500
// (logError, vite/dist/node/chunks/node.js:8206-8216, que llega como vite:error), así que se anota qué módulos
// quedaron viejos y, cuando un update posterior sale bien sin que ellos se hayan puesto al día, se recarga la página.

interface UpdatePayload { updates?: { acceptedPath?: string; path?: string }[] }

/** Lo que usa del `import.meta.hot` de Vite. */
export interface RecoverHot {
  on(event: 'vite:beforeUpdate' | 'vite:afterUpdate', cb: (payload: UpdatePayload) => void): void;
  on(event: 'vite:error', cb: () => void): void;
}

const pathsOf = (payload: UpdatePayload): string[] =>
  (payload.updates ?? []).map((u) => u.acceptedPath ?? u.path ?? '').filter(Boolean);

/** Estado puro del seguimiento: qué módulos quedaron sin su última versión. */
export function createHmrRecover(reload: () => void) {
  let stale = new Set<string>();
  let current: string[] = [];
  let failed = false;
  return {
    before(payload: UpdatePayload): void {
      current = pathsOf(payload);
      failed = false;
    },
    error(): void {
      failed = true;
    },
    after(): void {
      if (failed) {
        stale = new Set([...stale, ...current]);
        return;
      }
      stale = new Set([...stale].filter((p) => !current.includes(p)));
      if (stale.size) reload();
    },
  };
}

export function installHmrRecover(hot: RecoverHot | undefined, reload: () => void): void {
  if (!hot) return;
  const recover = createHmrRecover(reload);
  hot.on('vite:beforeUpdate', (p) => recover.before(p));
  hot.on('vite:error', () => recover.error());
  hot.on('vite:afterUpdate', () => recover.after());
}
