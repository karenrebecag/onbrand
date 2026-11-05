// Decorador de SandboxProvider: recuerda el handle de cada chat unos segundos. El orquestador pide la URL de la VM en cada request
// (SSE, reconexiones, corridas seguidas) y `ensure` de un proveedor real es una llamada a su API. Si la VM muriera dentro del TTL, el
// reenvío falla (502) y pasado el TTL se vuelve a pedir; `stop` y `snapshot` olvidan el handle.

import type { SandboxHandle, SandboxProvider } from './sandbox';

export const HANDLE_TTL_MS = 15_000;

export function cachedSandbox(inner: SandboxProvider, ttlMs: number = HANDLE_TTL_MS, now: () => number = Date.now): SandboxProvider {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('cachedSandbox: ttlMs debe ser un número finito >= 0');
  const known = new Map<string, { handle: SandboxHandle; until: number }>();
  const inflight = new Map<string, Promise<SandboxHandle>>();
  return {
    async ensure(chat, env) {
      const hit = known.get(chat.chatId);
      if (hit && hit.until > now()) return hit.handle;
      // Dos requests a la vez por el mismo chat comparten una sola llamada al proveedor.
      let p = inflight.get(chat.chatId);
      if (!p) {
        p = inner.ensure(chat, env).then((handle) => { known.set(chat.chatId, { handle, until: now() + ttlMs }); return handle; }).finally(() => inflight.delete(chat.chatId));
        inflight.set(chat.chatId, p);
      }
      return p;
    },
    keepAlive: (chatId) => inner.keepAlive(chatId),
    async snapshot(chatId) { known.delete(chatId); return inner.snapshot(chatId); },
    async stop(chatId) { known.delete(chatId); return inner.stop(chatId); },
  };
}
