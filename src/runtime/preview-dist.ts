// Preview estable por ws y snapshot `dist/<commit>` servible: lo que el listener de previews necesita de cada workspace,
// la url estable, el guardado del dist y el latido del builder. No sabe de corridas ni del índice más allá de "¿este ws
// existe?". Paso 5 de la modularización de transport.ts (capa preview.* del inventario).

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { randomUUID, type KeyObject } from 'node:crypto';
import { basename, join } from 'node:path';
import { agentEnv } from './agent-loop';
import { runCommand } from './child-run';
import { headSha, isClean } from './git-workspace';
import { HttpError } from './http';
import { MAX_LIVE, type PreviewPool } from './preview';
import type { PreviewGate, PreviewResolve } from './preview-serve';
import { previewTokenExp, signPreviewToken } from './preview-token';
import { INSTALLED_MARK, SH_TIMEOUT_MS, VERSION_BUILD } from './shared';
import { PUBLISH_MODE } from './wt-bridges-plugin';

// Re-export: los tests y quien leía la marca de aquí siguen funcionando.
export { INSTALLED_MARK };
/** Versiones con snapshot de dist que se conservan por ws (las más recientes). */
const MAX_DIST_VERSIONS = 8;
/** Base con la que se construyó el snapshot servible (R5.5: en la raíz del origen por ws). */
const DIST_BASE = '/';

export type PreviewStatus = 'live' | 'dist' | 'absent';

export interface PreviewDistDeps {
  previews?: PreviewPool;
  previewPort?: number;
  previewOrigin?: string;
  wsDir: (ws: string) => string;
  /** ¿Existe un mensaje con este ws en el índice? Cierra el traversal junto con la regex del id. */
  hasWs: (ws: string) => boolean;
  /** Secreto del token de preview (WT_PREVIEW_SECRET): con él, el listener exige el token y el latido lo firma (HMAC, local). */
  previewSecret?: Buffer;
  /** Llave pública del preview (modo asimétrico, deploy-sandbox.md §4): con ella el listener exige el token pero la VM NO
   *  lo firma; lo acuña el orquestador. Excluyente con previewSecret (serve.ts lo garantiza). */
  previewPublicKey?: KeyObject;
  /** El token ya firmado por el orquestador para este ws (modo asimétrico): el latido lo reenvía tal cual, nunca acuña.
   *  Ausente ⇒ el latido no manda token en modo asimétrico. */
  forwardedPreviewToken?: (ws: string, owner: string) => string | undefined;
  /** ¿Es `owner` el dueño de este ws? Sin esto (antes de la fase 2) no se emite ningún token. */
  ownsWs?: (ws: string, owner: string) => boolean;
  now?: () => number;
}

export interface PreviewState {
  status: PreviewStatus;
  version: string | null;
  /** Estable y sin token: no cambia, así el iframe no se remonta cuando cambia el token. */
  url: string;
  /** Solo con el gate encendido y para un ws del dueño; el builder lo pone como ?wt_preview= al montar el iframe. */
  previewToken?: string;
}

export class PreviewDist {
  /** Veredicto del marcador `.base` por ruta de dist (incluye el commit); saveDist invalida la entrada al reescribir. */
  private distRootCache = new Map<string, boolean>();

  constructor(private deps: PreviewDistDeps) {}

  /** Lo que el listener de previews necesita de cada ws: su workspace y el `dist/<commit>` servible de su versión HEAD. */
  resolve(): PreviewResolve {
    const dirIf = (ws: string): string | undefined => { if (!this.isValidWs(ws)) return undefined; const d = this.deps.wsDir(ws); return existsSync(d) ? d : undefined; };
    return {
      dirFor: dirIf,
      ready: (ws) => { const d = dirIf(ws); return d ? this.installed(d) : false; },
      distFor: (ws) => {
        const d = dirIf(ws);
        if (!d) return undefined;
        let commit: string;
        try { commit = headSha(d); } catch { return undefined; }
        return this.servableDist(d, commit);
      },
    };
  }

  /** El `dist/<commit>` servible de una versión, o undefined. Servir solo un snapshot de R5.5 (raíz): saveDist graba `.base`
   *  con la base del build. Un snapshot viejo con --base /preview/<ws>/ no lo tiene → 'absent' → rebuild bajo demanda, en vez
   *  de servir una página rota (sus assets bajo /preview/ no resuelven en la raíz). Marcador, no contenido: un og:image
   *  externo con /preview/ no cuenta. Una lectura por versión, cacheada por ruta de dist (incluye el commit); saveDist
   *  invalida la entrada al reescribir el snapshot. */
  servableDist(d: string, commit: string): string | undefined {
    const dist = join(d, '.wt', 'dist', commit);
    // Solo el veredicto del marcador `.base` se cachea por ruta (saveDist lo invalida al reescribir el snapshot). El
    // chequeo de symlink (L-4) corre EN CADA request: un symlink puesto después del primer distFor no debe quedar servible
    // por una cache vieja, y cachear el realpath lo haría.
    let base = this.distRootCache.get(dist);
    if (base === undefined) { base = this.hasDistBase(dist); this.distRootCache.set(dist, base); }
    return base && this.distUnderWs(dist, d) ? dist : undefined;
  }

  /** El snapshot tiene el marcador `.base` de R5.5 (raíz). readFileSync sigue symlinks a propósito: el ancla contra el
   *  symlink la pone distUnderWs, no esto. */
  private hasDistBase(dist: string): boolean {
    try { return readFileSync(join(dist, '.base'), 'utf8') === DIST_BASE; } catch { return false; }
  }

  /** `.wt/dist/<commit>` vive REALMENTE bajo el ws `d`. L-4: el agente puede cambiar `.wt/dist/<commit>` —o `.wt/dist` o
   *  `.wt` enteros— por un symlink al dist de otro ws (que sí tiene `.base` válido) y distFile lo serviría con rootReal =
   *  realpath. El ancla es realpath(d) + ruta literal: d es el dir real del ws (no un symlink), así que resolver el lado
   *  izquierdo por el mismo symlink no puede empatar al derecho. */
  private distUnderWs(dist: string, d: string): boolean {
    try { return realpathSync(dist) === join(realpathSync(d), '.wt', 'dist', basename(dist)); } catch { return false; }
  }

  /** El origen base del preview (previewOrigin o el default localhost): el host que arma stableUrl y contra el que el
   *  listener valida el Host (R5.5 opción b). Rechaza un host IP al construirlo: el subdominio por ws no funciona sobre una
   *  IP (`new URL(...).hostname = ...` se ignora en silencio), así que todos los ws caerían en la misma url → 421. */
  originBase(): URL {
    const u = new URL(this.deps.previewOrigin ?? `http://localhost:${this.deps.previewPort}`);
    // URL.hostname deja los corchetes en un IPv6 (`[::1]`) e isIP no los reconoce: se quitan para que la IP se rechace igual.
    if (isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw new Error(`previewOrigin no puede ser una IP (${u.hostname}): el origen por ws necesita un host con subdominio, p. ej. http://localhost:${this.deps.previewPort}`);
    return u;
  }

  /** La url estable del preview de un ws: su propio origen `http://<ws>.<host de previewOrigin>/` (R5.5), servido por el
   *  listener del puerto dedicado — no el puerto efímero de vite. El ws entra como primer label del host, así cada ws queda
   *  aislado por origen. */
  stableUrl(ws: string): string {
    const u = this.originBase();
    u.hostname = `${ws}.${u.hostname}`;
    return u.toString();
  }

  /** ¿El workspace está listo para arrancar vite? Pide package.json (un directorio sin él no es un workspace: no se le
   * lanza `bunx vite`, Arq R5 seguridad) y el marcador de install: R1.3 dejó install async y un arranque a mitad del
   * pre-bundle rompe el dev server. */
  installed(dir: string): boolean {
    return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules', INSTALLED_MARK));
  }

  /** Un ws válido para abrir su workspace: un id sin separadores de ruta (ni `.`/`/`/`%`) que exista en el índice como el
   * ws de algún mensaje. Cierra el traversal: `/preview/%2e%2e/` o visible:['..'] no resuelven a ningún directorio real,
   * así la página generada no puede lanzar vite fuera de los workspaces (Arq R5 seguridad). */
  isValidWs(ws: string): boolean {
    return /^[A-Za-z0-9_-]{1,64}$/.test(ws) && this.deps.hasWs(ws);
  }

  /** Guarda el `dist/` recién construido en `.wt/dist/<commit>` (R5.3) y poda las versiones viejas para no llenar el disco
   * (auditoría #1). `.wt` lo ignora git, así que no entra en el commit de la versión. */
  /** Guarda el snapshot sin dejar que un fallo tumbe un run ya completo. El snapshot es derivado y puede faltar (ADR 0013
   *  §1): si saveDist lanza (symlink en .wt, disco lleno), la versión ya está commiteada, así que se registra y se sigue. */
  trySaveDist(dir: string, commit: string): void {
    try {
      this.saveDist(dir, commit);
    } catch (e) {
      console.error(`[transport] no se guardó el snapshot de dist de ${commit}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private saveDist(dir: string, commit: string): void {
    const src = join(dir, 'dist');
    if (!existsSync(src)) return;
    const root = snapshotRoot(dir, 'dist');
    const dest = join(root, commit);
    copyWithoutSymlinks(src, dest);
    writeFileSync(join(dest, '.base'), DIST_BASE); // marcador de base (R5.5 sirve en la raíz): distFor solo sirve snapshots con esto
    this.distRootCache.delete(dest); // un rebuild del mismo commit reescribe `.base`: sin esto distFor serviría el veredicto viejo
    pruneSnapshots(root);
  }

  /** Latido del builder (R5.2): marca los ws visibles como vistos, los levanta bajo demanda si ya instalaron y devuelve el
   * estado servible de cada uno. `url` es siempre la estable; `status` dice qué sirve el proxy ahora mismo. Un ws que aún
   * instala va como 'absent' SIN arrancar vite: el builder muestra carga, y el remonte a 'live' sale de volver de absent
   * (R4.6 framesToRemount; el cliente solo conoce live|dist|absent y descarta cualquier otro status). */
  /** El gate del listener, o undefined sin llave (apagado): HMAC con secreto (local), Ed25519 con pública (orquestador). */
  gate(): PreviewGate | undefined {
    const now = this.deps.now ? { now: this.deps.now } : {};
    if (this.deps.previewSecret) return { secret: this.deps.previewSecret, ...now };
    // Asimétrico: el gate reautoriza el owner del token (lo firmó el orquestador, no la VM) contra el dueño del ws.
    if (this.deps.previewPublicKey) return { publicKey: this.deps.previewPublicKey, ...(this.deps.ownsWs ? { ownsWs: this.deps.ownsWs } : {}), ...now };
    return undefined;
  }

  private tokenFor(ws: string, owner: string | undefined): { previewToken?: string } {
    const { previewSecret, previewPublicKey, forwardedPreviewToken, ownsWs } = this.deps;
    if (owner === undefined || !ownsWs?.(ws, owner)) return {};
    // Local: la VM firma HMAC. Asimétrico: la VM no tiene con qué firmar; reenvía el token que el orquestador ya acuñó.
    if (previewSecret) return { previewToken: signPreviewToken({ ws, owner, exp: previewTokenExp((this.deps.now ?? Date.now)()) }, previewSecret) };
    if (previewPublicKey) { const t = forwardedPreviewToken?.(ws, owner); return t ? { previewToken: t } : {}; }
    return {};
  }

  heartbeat(body: unknown, owner?: string): { states: Record<string, PreviewState> } {
    const asked = Array.isArray((body as { visible?: unknown })?.visible) ? (body as { visible: unknown[] }).visible.filter((x): x is string => typeof x === 'string') : [];
    // Tope a lo visible (Arq R5): el pool solo tiene MAX_LIVE vites, y sin tope la página podría pedir arrancar N.
    const visible = [...new Set(asked)].slice(0, MAX_LIVE);
    const previews = this.deps.previews;
    const states: Record<string, PreviewState> = {};
    for (const ws of visible) {
      const url = this.stableUrl(ws);
      if (!previews || !this.isValidWs(ws)) { states[ws] = { status: 'absent', version: null, url }; continue; }
      const dir = this.deps.wsDir(ws);
      if (!existsSync(dir)) { states[ws] = { status: 'absent', version: null, url }; continue; }
      previews.see(dir);
      // Solo un ws que existe: el token de uno inexistente no sirve y diría que el id es válido.
      const tok = this.tokenFor(ws, owner);
      let version: string | null;
      try { version = headSha(dir); } catch { version = null; }
      if (previews.live(dir)) { states[ws] = { status: 'live', version, url, ...tok }; continue; }
      // Mientras instala no se arranca vite (R1.3: un arranque a mitad del pre-bundle rompe el dev server): 'absent'.
      if (!this.installed(dir)) { states[ws] = { status: 'absent', version, url, ...tok }; continue; }
      // Arranque bajo demanda; sin await: el latido no espera a que vite escuche. onDemand: el tope y el backoff aplican
      // aquí (recarga cada 1 s), no en el camino de una corrida viva (R5.3).
      void previews.ensure(dir, { onDemand: true }).catch(() => {});
      // L-1: por distFor (marcador `.base` + realpath), no existsSync: así el estado reportado coincide con lo que el
      // listener sirve. Un snapshot sin `.base` o apuntado por symlink sale 'absent', no 'dist'.
      const dist = version !== null && !!this.servableDist(dir, version);
      states[ws] = { status: dist ? 'dist' : 'absent', version, url, ...tok };
    }
    return { states };
  }
}

/** `.wt/<kind>` listo para escribir snapshots. Ni `.wt` ni `.wt/<kind>` pueden ser symlinks: si apuntaran afuera, el proxy
 *  serviría (o el paquete exportado llevaría) ese destino como si fuera del ws (security-reviewer M1). */
function snapshotRoot(dir: string, kind: 'dist' | 'export'): string {
  const root = join(dir, '.wt', kind);
  if ((existsSync(join(dir, '.wt')) && lstatSync(join(dir, '.wt')).isSymbolicLink()) || (existsSync(root) && lstatSync(root).isSymbolicLink())) {
    throw new Error(`.wt o .wt/${kind} es un symlink: no se guarda el snapshot`);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

/** Sin symlinks: un `dist/k -> ~/.ssh` que dejara el build no se copia al snapshot (security-reviewer M1). */
function copyWithoutSymlinks(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, filter: (s) => !lstatSync(s).isSymbolicLink() });
}

function pruneSnapshots(root: string): void {
  // HACK: tope fijo de versiones con dist (las más recientes por mtime). Un tope por tamaño cuando el banco mida dists grandes.
  // Los `.build-*` en curso no cuentan ni se podan: son de otro build de export a medias.
  // HACK: puede borrar el `dest` de otro commit que un export esté zipeando; no pasa hoy porque solo la HEAD del ws es
  // exportable y el recién construido es el más nuevo por mtime. Lock por dest si se exportan varias versiones a la vez.
  const stale = readdirSync(root).filter((name) => !name.startsWith('.')).map((name) => ({ name, at: lstatSync(join(root, name)).mtimeMs })).sort((a, z) => z.at - a.at).slice(MAX_DIST_VERSIONS);
  for (const { name } of stale) rmSync(join(root, name), { recursive: true, force: true });
}

/** El build del paquete exportado (H9): el sitio sin los puentes del preview (P3), con `--mode publish` del plugin. Va con
 *  el config del runtime, así un ws viejo cuyo main.tsx importa sus puentes tampoco los empaqueta. */
export const EXPORT_BUILD = (outDir: string): readonly string[] => [...VERSION_BUILD, '--mode', PUBLISH_MODE, '--outDir', outDir, '--emptyOutDir'];

/** Para el paquete exportado, sin puentes (P3): construye `.wt/export/<commit>` desde el árbol del ws y devuelve esa ruta.
 *  Vite lee el árbol, no el commit, así que con HEAD en otro commit o cambios sin commitear el paquete no sería esa
 *  versión → 409 `not-at-commit`. Se construye aparte y se copia sin symlinks, como saveDist: un build a medias no deja un
 *  dist roto. */
/** ¿El árbol del ws es exactamente esa versión? Es lo que vite va a leer al construir el paquete. */
export function isAtCommit(dir: string, commit: string): boolean {
  try { return headSha(dir) === commit && isClean(dir); } catch { return false; }
}

const NOT_AT_COMMIT = (): HttpError => new HttpError(409, 'el workspace no está en el commit de la versión: solo la versión actual se exporta o se publica', { code: 'not-at-commit' });

/** `run` es inyectable para los tests: un turno que escribe el ws a mitad del build no se reproduce con vite real. */
export async function buildExportDist(dir: string, commit: string, signal?: AbortSignal, run: typeof runCommand = runCommand): Promise<string> {
  if (!isAtCommit(dir, commit)) throw NOT_AT_COMMIT();
  const root = snapshotRoot(dir, 'export');
  const dest = join(root, commit);
  // Caché por commit: el árbol es el del commit (lockfile incluido), así que "Copiar página" y luego "Sitio" no
  // reconstruyen. `dest` solo existe completo: se llega a él por rename desde un `.part`.
  if (existsSync(dest) && !lstatSync(dest).isSymbolicLink()) return dest;
  // Sin vite local, `bunx vite` lo bajaría del registry en vez de fallar: un ws sin instalar no tiene paquete que construir.
  if (!existsSync(join(dir, 'node_modules', '.bin', 'vite'))) throw new HttpError(409, 'la versión no tiene un build servible', { code: 'no-build' });
  // Por llamada: dos exports seguidos del mismo commit no comparten carpeta temporal.
  const tag = randomUUID();
  const tmp = join(root, `.build-${commit}-${tag}`);
  const part = join(root, `.part-${commit}-${tag}`);
  try {
    const [cmd, ...args] = EXPORT_BUILD(tmp);
    // agentEnv: el vite.config lo escribió el agente; sin filtrar leería las credenciales del transport (shared.ts sh).
    const r = await run(cmd as string, args, { cwd: dir, env: agentEnv(process.env), timeoutMs: SH_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    if (r.aborted) throw new Error('build de export detenido');
    if (r.timedOut) throw new Error(`build de export sin terminar en ${SH_TIMEOUT_MS / 1000} s`);
    if (r.code !== 0) throw new Error(`build de export falló (exit ${r.code}): ${r.stderr.slice(-400)}`);
    // Vite leyó el árbol durante todo el build: si un turno lo cambió mientras tanto (HEAD movido o archivos a medio
    // escribir), el resultado no es esa versión y la caché lo serviría para siempre (Arq sobre #688, A6).
    if (!isAtCommit(dir, commit)) throw NOT_AT_COMMIT();
    copyWithoutSymlinks(tmp, part);
    // Si otro export del mismo commit ganó la carrera, su resultado vale igual que el nuestro.
    try { renameSync(part, dest); } catch (e) { if (!existsSync(dest)) throw e; }
    pruneSnapshots(root);
    return dest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(part, { recursive: true, force: true });
  }
}
