// Un dev server Vite por workspace, arrancado una vez y reutilizado entre mensajes: el equivalente de la
// VM de v0, que vive por chat y se refresca con HMR (VERIFIED: run-pipeline + recarga de *.v0.build,
// v0-endpoint-map.md §4f). Escucha en 127.0.0.1 salvo que el despliegue pida otro host (Sandbox, deploy-ec.md).

import { PREVIEW_VITE_CONFIG } from './shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';

export interface Preview {
  /** La que abre el navegador del builder: en un Vercel Sandbox es el dominio público del puerto, no loopback. */
  url: string;
  /** La que usan el agente y los sensores desde la misma máquina, sin pasar por el proxy público. */
  localUrl: string;
  port: number;
}

/** Red del preview en un despliegue. En un Vercel Sandbox solo se publican los `ports` declarados al crearlo, hasta 15,
 * por `sandbox.domain(port)` (https://vercel.com/docs/sandbox/sdk-reference §Sandbox.create, §sandbox.domain). */
export interface PreviewNet {
  host?: string;
  ports?: readonly number[];
  publicUrl?: (port: number) => string;
}

/** ¿Está libre el puerto en ese host? Se prueba donde vite va a escuchar: en 0.0.0.0 un puerto ocupado solo en otra
 * interfaz pasaría por libre en 127.0.0.1 y --strictPort tumbaría el arranque. */
function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

// Lo que vite dice en su terminal y el navegador no ve: errores de transformación y del server.
const SERVER_ERROR = /\berror\b/i;
const MAX_ERRORS = 50;
// vite reenvía a su terminal lo que pasa en el navegador (consola y errores no capturados, `[vite] (client) …`);
// eso ya lo cuenta el sensor del navegador en su propia carga. Contarlo aquí sumaba los errores HMR de una página
// a medio escribir (live3/live4 de orq: "[Unhandled error] … reading 'useState'").
const FORWARDED = /\[vite\] \(client\)/;
// Los frames de un stack nombran archivos como error-*.mjs: no son el error, solo su rastro.
const STACK_FRAME = /^at\s/;
// Códigos de color ANSI de la salida de vite.
const ANSI = /\x1b\[[0-9;]*m/g;

/** Una línea de la terminal de vite, si es un error del server; si no, undefined. */
export function serverErrorLine(raw: string): string | undefined {
  const line = raw.replace(ANSI, '').trim();
  return SERVER_ERROR.test(line) && !FORWARDED.test(line) && !STACK_FRAME.test(line) ? line.slice(0, 300) : undefined;
}

async function waitUp(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite salió con código ${child.exitCode} antes de responder`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // Todavía no escucha: se reintenta hasta el plazo.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite no respondió en ${url} tras ${timeoutMs} ms`);
}

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
// vite corre código generado por el agente (config, plugins) y expone VITE_* al bundle: solo recibe lo que necesita para
// arrancar, nunca tokens del proveedor ni variables del operador (security-reviewer #283).
const CHILD_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'NODE_ENV', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'BUN_INSTALL', 'NO_COLOR', 'FORCE_COLOR'];
export const childEnv = (env: NodeJS.ProcessEnv): Record<string, string> => Object.fromEntries(CHILD_ENV.flatMap((k) => (typeof env[k] === 'string' ? [[k, env[k] as string]] : [])));

/** Variables de entorno del preview según el origen del builder (`--builder-origin`): vacío = puente de errores inerte. */
export function previewEnv(builderOrigin?: string): Record<string, string> {
  if (!builderOrigin) return {};
  if (!ORIGIN.test(builderOrigin)) throw new Error(`--builder-origin debe ser un origen http(s) sin ruta, no "${builderOrigin}"`);
  return { VITE_WT_BUILDER_ORIGIN: builderOrigin };
}

/** WT_PREVIEW_URLS: "5310=https://…,5311=https://…", la url de sandbox.domain(port) por puerto declarado. Un mapa y no
 * una plantilla: la doc no dice cómo se forma el dominio de cada puerto, solo que lo resuelve sandbox.domain(). */
export function parsePreviewUrls(v: string): PreviewNet {
  const urls = new Map<number, string>();
  for (const pair of v.split(',')) {
    const m = /^\s*(\d{2,5})=(https?:\/\/[^\s,]+?)\/?\s*$/.exec(pair);
    if (!m || Number(m[1]) > 65535) throw new Error(`WT_PREVIEW_URLS inválido cerca de "${pair.trim()}"`);
    urls.set(Number(m[1]), `${m[2]}/`);
  }
  // El tope es el de puertos abiertos por Sandbox, contando el del transport.
  if (urls.size > 14) throw new Error('WT_PREVIEW_URLS: un Sandbox expone hasta 15 puertos, uno es del transport');
  return { ports: [...urls.keys()], publicUrl: (port) => urls.get(port) as string };
}

// Uno por corrida en curso (MAX_RUNNING 3) y uno de holgura para el chat que se está mirando.
export const MAX_LIVE = 4;

// Tras un arranque fallido no se re-spawnea vite hasta pasado esto: el placeholder recarga cada 1 s y, sin backoff, un ws
// que no arranca se re-spawnearía en bucle (security-reviewer M1).
export const START_BACKOFF_MS = 10_000;

// El builder manda los ws visibles cada ~5 s (R5.2; v0 `vm/status?pageFocused&pageVisible`, HALLAZGOS-frontend-v0.md:13).
// Un ws visto dentro de este plazo no se desaloja aunque no tenga corrida: 3 latidos perdidos (15 s) y vuelve a desechable.
const WATCH_TTL_MS = 15_000;

export class PreviewPool {
  private running = new Map<string, { child: ChildProcess; preview: Preview; errors: string[] }>();
  // Arranques en curso por workspace. Sin esto, dos ensure() simultáneos (el GET del hilo con el doble montaje de
  // StrictMode, o dos recargas) elegían el mismo puerto: el perdedor caía por --strictPort y su catch borraba la entrada
  // del ganador, dejando un vite huérfano que stopAll ya no mataba (security-reviewer, E3).
  private starting = new Map<string, Promise<Preview>>();
  // Cada GET /chats/:id levanta el preview de su chat; sin tope, recorrer chats dejaba un vite vivo por cada uno
  // (security-reviewer, E3). Se apaga el usado hace más tiempo, nunca el de un workspace con corrida en curso.
  private usedAt = new Map<string, number>();
  private uses = 0;
  // Último arranque fallido por workspace (M1): dentro del backoff, ensure no vuelve a intentar.
  private failedAt = new Map<string, number>();
  /** Lo pone el transport: true si el workspace tiene una corrida en curso y su preview no se puede apagar. */
  protect: (dir: string) => boolean = () => false;
  /** Lo pone el transport: la url estable del ws (el proxy de la url estable, R5.1), que el builder abre en vez del puerto
   * efímero de vite. Sin él, `url` cae al dominio público del puerto de vite (o loopback). */
  stableUrl: ((dir: string) => string) | undefined;
  /** Si está, la terminal entera de cada vite queda en `<logDir>/<workspace>.vite.log` con la hora de cada línea: el
   * arnés cruza las recargas ("page reload", "hmr update") con el log del turno, y sin esto se perdían (qa.md, S0). */
  logDir: string | undefined;

  /** `env` extra para vite: VITE_WT_BUILDER_ORIGIN activa el puente de errores del preview (#278) hacia el builder.
   * `command` es inyectable en tests: el binario y sus argumentos antes de --host/--port. */
  // Último latido por workspace (R5.2): un ws visto hace menos de watchTtlMs no se desaloja.
  private seenAt = new Map<string, number>();

  constructor(private firstPort = 5310, private timeoutMs = 60_000, private env: Record<string, string> = {}, private command: string[] = ['bunx', 'vite', '--config', PREVIEW_VITE_CONFIG], private maxLive = MAX_LIVE, private net: PreviewNet = {}, private watchTtlMs = WATCH_TTL_MS, private backoffMs = START_BACKOFF_MS) {}

  /** La URL del preview del workspace; lo arranca si no está corriendo o si se cayó. `onDemand` es el arranque por el
   *  placeholder/latido (R5.2): recarga cada 1 s, así que un ws roto se re-spawnearía en bucle y abrir N urls con Play
   *  levantaría N vites — solo ahí aplican el tope y el backoff. Una corrida viva (R5.3) siempre arranca su vite: su
   *  ensure no pasa por el tope ni el backoff (regresión M-1: antes abortaba la corrida 5ª con el cupo lleno de vigilados). */
  ensure(dir: string, opts: { onDemand?: boolean } = {}): Promise<Preview> {
    this.usedAt.set(dir, ++this.uses);
    const live = this.running.get(dir);
    if (live && live.child.exitCode === null) return Promise.resolve(live.preview);
    const pending = this.starting.get(dir);
    if (pending) return pending;
    if (opts.onDemand) {
      const failed = this.failedAt.get(dir);
      if (failed !== undefined && Date.now() - failed < this.backoffMs) return Promise.reject(new Error(`preview en backoff (${basename(dir)})`));
      // Cupo atómico (M2): desaloja lo desechable y cuenta vivos + arrancando ANTES de reservar, en un turno síncrono (sin
      // await entre el chequeo y el starting.set). Un ws en waitUp está en running y en starting a la vez: se cuenta como
      // uno (unión de claves), no dos, o el cupo se cerraría una posición antes de tiempo.
      this.evict(dir);
      const liveCount = new Set([...this.running.keys(), ...this.starting.keys()]).size;
      if (liveCount >= this.maxLive) return Promise.reject(new Error('sin cupo de preview'));
    } else {
      // Corrida: hace lugar desalojando lo desechable, pero arranca aunque el cupo esté lleno de ws vigilados.
      this.evict(dir);
    }
    const started = this.start(dir).finally(() => this.starting.delete(dir));
    this.starting.set(dir, started);
    return started;
  }

  private async start(dir: string): Promise<Preview> {
    // El cupo y el evict los aplica ensure antes de reservar (M2); aquí ya hay lugar.
    const host = this.net.host ?? '127.0.0.1';
    try {
    const port = await this.freePort(host);
    const [bin, ...pre] = this.command;
    // Sin --base (R5.5): cada ws tiene su propio origen `<ws>.localhost:<previewPort>` por el listener de la url estable,
    // así que vite sirve en la raíz. El builder carga la página por ese host y el cliente de vite arma el socket HMR contra
    // el mismo host (sin clientPort fijo; verificado end-to-end, host-por-ws-experimento.md). Loopback directo
    // (preview-check, tool browser) entra por localUrl, también en la raíz.
    const child = spawn(bin!, [...pre, '--host', host, '--port', String(port), '--strictPort'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv(process.env), ...this.env } });
    const localUrl = `http://127.0.0.1:${port}/`;
    // url = lo que abre el builder: la url estable del host por ws (R5.5) si el transport la inyectó; si no, el dominio
    // público del puerto de vite (Sandbox) o el loopback. localUrl siempre es vite directo, para sensores y tool browser.
    const url = this.stableUrl?.(dir) ?? (this.net.publicUrl ? this.net.publicUrl(port) : localUrl);
    const preview = { url, localUrl, port };
    const errors: string[] = [];
    // Append, no truncar: un vite que se reinicia en el mismo workspace sigue en el mismo archivo
    // (https://nodejs.org/api/fs.html#fscreatewritestreampath-options, flags 'a').
    const raw = this.logDir ? createWriteStream(join(this.logDir, `${basename(dir)}.vite.log`), { flags: 'a' }) : undefined;
    if (raw) {
      child.once('exit', () => raw.end());
      // Un disco lleno no puede tumbar el transport por un log de diagnóstico: se avisa y vite sigue.
      raw.on('error', (e) => console.error(`[preview] no se pudo escribir ${basename(dir)}.vite.log: ${e.message}`));
    }
    // Las tuberías se consumen siempre: una llena bloquearía a vite.
    // Un chunk puede cortar una línea: el resto espera al siguiente.
    const collect = () => {
      let rest = '';
      return (c: Buffer) => {
        const lines = (rest + c.toString()).split('\n');
        rest = lines.pop() ?? '';
        if (raw) for (const line of lines) raw.write(`${new Date().toISOString()} ${line}\n`);
        for (const line of lines.map(serverErrorLine)) if (line) errors.push(line);
        errors.splice(0, Math.max(0, errors.length - MAX_ERRORS));
      };
    };
    child.stdout?.on('data', collect());
    child.stderr?.on('data', collect());
    this.running.set(dir, { child, preview, errors });
    // L-5: un vite que respondió y se cae enseguida (crash: code numérico, no una señal de un kill nuestro) entra en
    // backoff; sin esto el siguiente ensure bajo demanda lo re-spawnearía en bucle.
    child.once('exit', (code) => { if (code && this.running.get(dir)?.child === child) { this.running.delete(dir); this.failedAt.set(dir, Date.now()); } });
    await waitUp(preview.localUrl, this.timeoutMs, child);
    this.failedAt.delete(dir); // arrancó: limpia el backoff
    return preview;
    } catch (e) {
      // Cualquier fallo del arranque entra en backoff (M1/L-5): freePort sin puerto, spawn, o vite que no respondió.
      this.running.get(dir)?.child.kill();
      this.running.delete(dir);
      this.failedAt.set(dir, Date.now());
      throw e;
    }
  }

  // Con puertos declarados no se sale de la lista: un puerto fuera de ella escucharía sin que nadie lo pueda abrir.
  private async freePort(host: string): Promise<number> {
    const used = new Set([...this.running.values()].map((r) => r.preview.port));
    if (this.net.ports) {
      for (const p of this.net.ports) if (!used.has(p) && (await portFree(p, host))) return p;
      throw new Error(`no queda puerto de preview libre entre ${this.net.ports.join(', ')}`);
    }
    let port = this.firstPort;
    while (used.has(port) || !(await portFree(port, host))) port++;
    return port;
  }

  private evict(keep: string): void {
    const idle = [...this.running.keys()].filter((d) => d !== keep && !this.protect(d) && !this.watched(d)).sort((a, z) => (this.usedAt.get(a) ?? 0) - (this.usedAt.get(z) ?? 0));
    for (const dir of idle.slice(0, Math.max(0, this.running.size - this.maxLive + 1))) {
      this.running.get(dir)?.child.kill();
      this.running.delete(dir);
    }
  }

  /** El builder reportó este ws como visible (latido R5.2): no se desaloja mientras siga vigente. */
  see(dir: string): void {
    this.seenAt.set(dir, Date.now());
  }

  /** ¿El builder mira este ws dentro del plazo del latido? Un ws vigilado no se desaloja aunque no tenga corrida. */
  watched(dir: string): boolean {
    return Date.now() - (this.seenAt.get(dir) ?? 0) < this.watchTtlMs;
  }

  /** El preview si su vite sigue vivo; undefined si no se arrancó o se cayó. Lo usa el proxy de la url estable (R5.1). */
  live(dir: string): Preview | undefined {
    const r = this.running.get(dir);
    return r && r.child.exitCode === null ? r.preview : undefined;
  }

  /** Los errores que vite escribió desde la última lectura; leerlos los vacía, así cada mensaje ve los suyos. */
  drainErrors(dir: string): string[] {
    const live = this.running.get(dir);
    return live ? live.errors.splice(0) : [];
  }

  stopAll(): void {
    for (const { child } of this.running.values()) child.kill();
    this.running.clear();
  }
}
