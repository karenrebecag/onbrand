// Puerto de la VM por chat (docs/spec/deploy-sandbox.md §2). El orquestador solo conoce esta interfaz; el proveedor real
// (Vercel Sandbox) vive en la distro y entra por inyección. `fakeSandboxProvider` es el de tests y de local sin VM.

import type { ChatEntry } from './chat-index';

/** Lo que una VM recibe al nacer o reanudarse: nunca una llave privada ni un token de gasto (esos viajan por request). */
export interface SandboxEnv {
  readonly WT_IDENTITY_PUBLIC_KEY: string;
  /** Misma pública: la VM verifica con ella los tokens de preview (no firma). */
  readonly WT_PREVIEW_PUBLIC_KEY: string;
  readonly WT_CHAT_ID: string;
  readonly [name: string]: string;
}

export interface SandboxHandle {
  /** Nombre estable en el proveedor; el orquestador lo guarda en la entrada del chat (`sandbox.name`). */
  readonly name: string;
  /** Base URL del Runtime de la VM, sin barra final. */
  readonly apiUrl: string;
  /** Base URL del preview del chat. */
  readonly previewUrl: string;
}

export interface SandboxProvider {
  /** Crea la VM del chat desde la base o desde `chat.sandbox.snapshotId`, o la reanuda si ya existe. Idempotente por chatId. */
  ensure(chat: ChatEntry, env: SandboxEnv): Promise<SandboxHandle>;
  /** Prolonga la vida de la VM (latido del builder). Sin VM viva no hace nada. */
  keepAlive(chatId: string): Promise<void>;
  /** Congela el FS del chat y devuelve el id para guardar en el índice. */
  snapshot(chatId: string): Promise<{ snapshotId: string }>;
  stop(chatId: string): Promise<void>;
}

export interface FakeSandbox {
  readonly provider: SandboxProvider;
  /** Qué hizo el orquestador, en orden: `ensure:<chat>`, `keepAlive:<chat>`, `snapshot:<chat>`, `stop:<chat>`. */
  readonly calls: string[];
  /** Entorno con el que nació cada VM, por chatId. */
  readonly envs: Map<string, SandboxEnv>;
}

/** Proveedor en memoria: `start` levanta el Runtime del chat y devuelve su URL; así el e2e usa la misma ruta que el real. */
export function fakeSandboxProvider(start: (chat: ChatEntry, env: SandboxEnv) => Promise<string>): FakeSandbox {
  const calls: string[] = [];
  const envs = new Map<string, SandboxEnv>();
  const live = new Map<string, SandboxHandle>();
  let snaps = 0;
  const provider: SandboxProvider = {
    async ensure(chat, env) {
      calls.push(`ensure:${chat.chatId}`);
      const known = live.get(chat.chatId);
      if (known) return known;
      const apiUrl = await start(chat, env);
      const handle: SandboxHandle = { name: `fake-${chat.chatId}`, apiUrl, previewUrl: `${apiUrl}/preview` };
      live.set(chat.chatId, handle);
      envs.set(chat.chatId, env);
      return handle;
    },
    async keepAlive(chatId) { calls.push(`keepAlive:${chatId}`); },
    async snapshot(chatId) { calls.push(`snapshot:${chatId}`); return { snapshotId: `snap-${++snaps}` }; },
    async stop(chatId) { calls.push(`stop:${chatId}`); live.delete(chatId); },
  };
  return { provider, calls, envs };
}
