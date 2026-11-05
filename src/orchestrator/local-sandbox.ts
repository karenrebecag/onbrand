// SandboxProvider local (ADR 0017): una VM por chat es un proceso `scripts/serve.ts` en puertos libres de esta máquina. Es la
// implementación del core del puerto, para que el orquestador corra entero sin proveedor. No aísla: el proceso comparte máquina y
// usuario con el orquestador, así que solo sirve para desarrollo local. Un proveedor real (Sandbox de una distro) lo sustituye.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { REPO_ROOT } from '../config';
import { signalChild, track } from '../runtime/children';
import type { ChatEntry } from './chat-index';
import type { SandboxEnv, SandboxHandle, SandboxProvider } from './sandbox';

export interface LocalSandboxOptions {
  /** Directorio donde cada chat guarda su estado (`<rootDir>/<chatId>`). */
  readonly rootDir: string;
  /** Comando que arranca el Runtime; recibe `--port`, `--preview-port` y `--root` al final. Default: bun --no-env-file scripts/serve.ts --agent. */
  readonly command?: readonly string[];
  readonly cwd?: string;
  /** Entorno del que se toma lo permitido; default process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Variables EXTRA que el perfil quiere pasar a la VM por nombre (además de la lista permitida y de lo que traiga ensure). */
  readonly passEnv?: readonly string[];
  /** Base pública del proxy del orquestador (`http://localhost:5400`): enciende el proxy en la VM (`WT_GATEWAY_BASE_URL`). */
  readonly gatewayUrl?: string;
  /** Cuánto esperar a que el Runtime diga que está listo. */
  readonly startupMs?: number;
  /** VMs vivas en total y por dueño (HACK: cifras de partida, no de Karen). */
  readonly maxVms?: number;
  readonly maxPerOwner?: number;
  /** Espera mínima antes de reintentar un chat cuyo arranque falló. */
  readonly retryAfterMs?: number;
  /** Detalle de un fallo de arranque (salida del hijo). El error que sube a quien llama no lo lleva: puede acabar en una respuesta HTTP. */
  readonly log?: (message: string) => void;
  readonly freePort?: () => Promise<number>;
  readonly now?: () => number;
}

// Lo único que una VM hereda del entorno del orquestador. Nada de ANTHROPIC_*, BLOB_*, AI_GATEWAY_*, VERCEL_* ni secretos: la VM corre
// código que escribe el agente. Los WT_* pasan salvo los del orquestador y los que nombran un secreto; el perfil añade con `passEnv`.
const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'BUN_INSTALL', 'NO_COLOR', 'FORCE_COLOR'];
// Los WT_* son una allowlist explícita, no un patrón de exclusión: una variable nueva con un secreto en el nombre que no
// sea SECRET/TOKEN/KEY (_PASS, _AUTH, _DSN) no llega a la VM sola. tests/local-sandbox.test.ts compara estas dos listas con las
// variables que el runtime lee, así que una variable nueva obliga a clasificarla aquí.
export const VM_ENV_ALLOW: ReadonlySet<string> = new Set([
  'WT_AGENT_MODEL', 'WT_AGENT_SKILL', 'WT_BRAND_PACK', 'WT_BRANDS_ROOT', 'WT_BRIDGES_DIR', 'WT_BUILDER_ORIGIN', 'WT_COMPOSE_AGENT', 'WT_COMPOSE_CLI',
  'WT_COMPOSE_MODEL', 'WT_COMPOSE_PROVIDER', 'WT_COPY_CLI', 'WT_COPY_MODEL', 'WT_ENHANCER_MODEL',
  'WT_ENHANCER_PROVIDER', 'WT_FACTS_URL', 'WT_FOLLOWUP_RESUME', 'WT_IMAGE_MODELS', 'WT_IMAGE_PROVIDER', 'WT_INFER_RETRY_BASE_MS',
  'WT_MAX_RUNNING', 'WT_MODELS', 'WT_OPTIONAL_TIMEOUT_MS', 'WT_OTLP_URL', 'WT_PATCH_MODEL', 'WT_PORTER_OUT_ROOT', 'WT_PUBLISH_DIR',
  'WT_PUBLISH_PROVIDER', 'WT_REGISTRY_PIN', 'WT_RUNS_DISABLED', 'WT_SCAFFOLD_DIR', 'WT_SERVER_COMMIT', 'WT_SPOTLIGHT', 'WT_SPOTLIGHT_URL', 'WT_SUGGEST_MODEL',
  'WT_THREAD_SUMMARY_MODEL', 'WT_TRANSCRIBE_MODEL', 'WT_TRANSCRIBE_PROVIDER', 'WT_TZ', 'WT_VARIANTS_PLAN_MODEL', 'WT_VAULT_ROOT', 'WT_VISION_MODEL',
]);
/** WT_* que el runtime lee y la VM NO hereda: los pone `ensure` o el runtime a sus hijos (MCP, scaffold), son del listener o del IdP del orquestador,
 * o son secretos. Un perfil que necesite una la nombra en `passEnv`. */
export const VM_ENV_DENY: ReadonlySet<string> = new Set([
  'WT_HOST', 'WT_TRANSPORT_PORT', 'WT_PREVIEW_PORT', 'WT_PREVIEW_ORIGIN', 'WT_PREVIEW_URLS', 'WT_PREVIEW_SECRET', 'WT_PREVIEW_PUBLIC_KEY',
  'WT_ORIGIN_SECRET', 'WT_SESSION_PROVIDER', 'WT_PROFILE', 'WT_PROFILE_MODULE', 'WT_CHAT_ID', 'WT_IDENTITY_PUBLIC_KEY',
  'WT_GATEWAY_BASE_URL', 'WT_CONNECT_USER', 'WT_APPROVAL_URL', 'WT_APPROVAL_TOKEN', 'WT_CONNECTOR_URL', 'WT_COPY_TRANSPORT', 'WT_ALLOWED_HOSTS',
  'WT_WORKSPACE_IMAGE_MODEL', 'WT_RUNTIME_URL', 'WT_MCP_TOKEN', 'WT_JWT_AUDIENCE', 'WT_JWT_AUTHORIZED_PARTIES', 'WT_JWT_ISSUER', 'WT_JWT_JWKS_URL',
  'WT_JWT_PUBLIC_KEY', 'WT_JWT_SCOPES_CLAIM',
]);
const CHAT_ID = /^[\w-]{1,64}$/;
export const DEFAULT_COMMAND: readonly string[] = ['bun', '--no-env-file', join(REPO_ROOT, 'scripts', 'serve.ts'), '--agent'];
// HACK: 8 VM en total, 2 por dueño y 2 s entre arranques fallidos son cifras de partida: cada VM es un Runtime con su vite y sus CLI.
// Subirlas con la capacidad medida de la máquina o cuando un dueño legítimo las toque.
const DEFAULT_MAX_VMS = 8;
const DEFAULT_MAX_PER_OWNER = 2;
const DEFAULT_RETRY_AFTER_MS = 2_000;
const READY = /transport en (http:\/\/[^\s;]+)/;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address() as { port: number }; srv.close(() => resolve(port)); });
  });
}

interface Vm { readonly handle: SandboxHandle; readonly child: ChildProcess; readonly owner: string }
class StartFailed extends Error {}

export function localSandboxProvider(opts: LocalSandboxOptions): SandboxProvider {
  const vms = new Map<string, Vm>();
  const starting = new Map<string, { promise: Promise<Vm>; owner: string }>();
  const cancelled = new Set<string>();
  const failedAt = new Map<string, number>();
  const port = opts.freePort ?? freePort;
  const startupMs = opts.startupMs ?? 60_000;
  const command = opts.command ?? DEFAULT_COMMAND;
  const maxVms = opts.maxVms ?? DEFAULT_MAX_VMS;
  const maxPerOwner = opts.maxPerOwner ?? DEFAULT_MAX_PER_OWNER;
  const retryAfter = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const log = opts.log ?? ((m: string) => console.error(`[local-sandbox] ${m}`));
  const now = opts.now ?? Date.now;

  function childEnv(env: SandboxEnv): Record<string, string> {
    const source = opts.env ?? process.env;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(source)) {
      if (v !== undefined && (BASE_ENV.includes(k) || VM_ENV_ALLOW.has(k) || opts.passEnv?.includes(k))) out[k] = v;
    }
    Object.assign(out, env, { WT_SESSION_PROVIDER: 'signed' });
    if (opts.gatewayUrl) Object.assign(out, { WT_GATEWAY_BASE_URL: `${opts.gatewayUrl.replace(/\/$/, '')}/gw/claude-code`, ANTHROPIC_AUTH_TOKEN: 'por-corrida' });
    return out;
  }

  /** Un intento de arranque con puertos propios. Rechaza StartFailed si el hijo sale antes de estar listo (p. ej. puerto ocupado). */
  async function attempt(chatId: string, owner: string, env: SandboxEnv): Promise<Vm> {
    const api = await port();
    let preview = await port();
    while (preview === api) preview = await port();
    const [bin, ...args] = command;
    const child = track(spawn(bin!, [...args, '--port', String(api), '--preview-port', String(preview), '--root', join(opts.rootDir, chatId)], { cwd: opts.cwd ?? REPO_ROOT, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true }), { group: true });
    let tail = '';
    const apiUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { signalChild(child, 'SIGKILL'); log(`${chatId}: sin "transport en" tras ${startupMs} ms\n${tail}`); reject(new Error(`local-sandbox: el Runtime de ${chatId} no arrancó en ${startupMs} ms`)); }, startupMs);
      const onData = (d: Buffer): void => {
        tail = (tail + d.toString()).slice(-2000);
        const m = READY.exec(tail);
        if (m) { clearTimeout(timer); resolve(m[1]!); }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.once('exit', (code) => { clearTimeout(timer); log(`${chatId}: salió con ${code} antes de estar listo\n${tail}`); reject(new StartFailed(`local-sandbox: el Runtime de ${chatId} salió con ${code} antes de estar listo`)); });
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const vm: Vm = { child, owner, handle: { name: `local-${chatId}`, apiUrl, previewUrl: `http://localhost:${preview}` } };
    // Un stop() que llegó durante el arranque gana: la VM no queda registrada.
    if (cancelled.delete(chatId)) { signalChild(child, 'SIGTERM'); throw new Error(`local-sandbox: ${chatId} se detuvo durante el arranque`); }
    child.once('exit', () => { if (vms.get(chatId) === vm) vms.delete(chatId); });
    vms.set(chatId, vm);
    return vm;
  }

  async function start(chatId: string, owner: string, env: SandboxEnv): Promise<Vm> {
    try {
      // Un puerto que se ocupó entre elegirlo y abrirlo hace salir a serve.ts: un segundo intento con puertos nuevos.
      try { return await attempt(chatId, owner, env); } catch (e) { if (!(e instanceof StartFailed)) throw e; return await attempt(chatId, owner, env); }
    } catch (e) {
      failedAt.set(chatId, now());
      throw e;
    }
  }

  function admit(chat: ChatEntry): void {
    const failed = failedAt.get(chat.chatId);
    if (failed !== undefined && now() - failed < retryAfter) throw new Error(`local-sandbox: el último arranque de ${chat.chatId} falló; reintenta en unos segundos`);
    const others = [...vms.entries()].filter(([id]) => id !== chat.chatId).map(([, v]) => v.owner).concat([...starting.entries()].filter(([id]) => id !== chat.chatId).map(([, s]) => s.owner));
    if (others.length >= maxVms) throw new Error('local-sandbox: hay demasiadas VM vivas');
    if (others.filter((o) => o === chat.owner).length >= maxPerOwner) throw new Error('local-sandbox: este dueño ya tiene el máximo de VM vivas');
  }

  return {
    async ensure(chat, env) {
      if (!CHAT_ID.test(chat.chatId)) throw new Error('local-sandbox: chatId inválido');
      const known = vms.get(chat.chatId);
      if (known && known.child.exitCode === null && known.child.signalCode === null) return known.handle;
      let pending = starting.get(chat.chatId);
      if (!pending) {
        admit(chat);
        cancelled.delete(chat.chatId);
        pending = { owner: chat.owner, promise: start(chat.chatId, chat.owner, env).finally(() => starting.delete(chat.chatId)) };
        starting.set(chat.chatId, pending);
      }
      return (await pending.promise).handle;
    },
    // Un proceso local no vence: no hay nada que prolongar.
    async keepAlive() {},
    // El estado del chat ya está en su directorio; no hay snapshot aparte que congelar.
    async snapshot(chatId) { return { snapshotId: `local-${chatId}` }; },
    async stop(chatId) {
      const vm = vms.get(chatId);
      vms.delete(chatId);
      if (vm) signalChild(vm.child, 'SIGTERM');
      else if (starting.has(chatId)) cancelled.add(chatId);
    },
  };
}
