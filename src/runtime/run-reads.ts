// Lecturas de una corrida y su export: hilo, versiones, log, archivos, diff, capturas y publish. No arrancan corridas ni
// escriben el índice; leen el workspace y el log por las deps que les pasa el transport. Paso de la partición de
// transport.ts (patrón de api-handlers.ts y brand-store.ts).

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { config } from '../config';
import { dsSkillOf } from './run-checks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { SHOT_FILE, SHOTS_DIR } from './agent-stream';
import { foldMessage, readEvents } from './events';
import { EXPORT_FORMATS, EXPORT_MAX_BYTES, ExportRefused, ExportTooLarge, exportFilename, exportSlug, MAX_ENTRIES, pageHtml, parseExportFormat, siteZip, SOURCE_EXCLUDE, sourceZip, type ExportFormat } from './export';
import { diffCommits, diffStats, headSha, isRepo, listFiles, parentOf, showFile, showFileBytes, treeEntries } from './git-workspace';
import { HttpError, json } from './http';
import { owns, type Session } from './session';
import { checkPublishable, type CheckResult, type PublishProvider } from './publish';
import { PLAN_PATH } from './section-ops';
import { DESIGN_FILE } from '../identity-design';
import type { PreviewPool } from './preview';
import { INSTRUCTIONS_FILE, PAGE_PATHS, planOnly, REQUEST_FILE, type MessageEntry, type VersionStats } from './shared';

const POLL_MS = 150;
// Un paso largo del composer deja el stream sin bytes; detrás de un proxy, el cliente no distingue
// eso de un upstream muerto. v0 manda `null` como latido (VERIFIED, §6.6); aquí una línea vacía, que
// un lector NDJSON ya ignora.
const HEARTBEAT_MS = 15_000;

function isOwnShot(wsDir: string, path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink() && realpathSync(dirname(path)) === join(realpathSync(wsDir), SHOTS_DIR);
  } catch {
    return false;
  }
}


export interface RunReadsDeps {
  /** El índice vivo: el transport lo reasigna al arrancar, así que se lee en cada llamada. */
  index: () => Readonly<Record<string, Readonly<MessageEntry>>>;
  entry: (id: string) => Readonly<MessageEntry>;
  wsDir: (ws: string) => string;
  logDir: string;
  isFinished: (id: string) => boolean;
  brandOf: (ws: string, commit: string) => string | undefined;
  /** Viven en preview-dist.ts: aquí solo se llaman. */
  stableUrl: (ws: string) => string;
  servableDist: (dir: string, commit: string) => string | undefined;
  /** El paquete exportado sin puentes (P3, buildExportDist): 409 not-at-commit si el ws no está en esa versión. */
  exportDist: (dir: string, commit: string) => Promise<string>;
  /** ¿El árbol del ws es esa versión? Sin eso no hay paquete site/page que construir. */
  atCommit: (dir: string, commit: string) => boolean;
  opts: { previews?: PreviewPool; previewPort?: number; heartbeatMs?: number; publish?: PublishProvider; registry?: (pin?: string) => Promise<{ pin: string }> };
}

// El `latest` del registry cambia cuando se publica un DS, no en cada GET: un recargo del builder no abre el registry otra vez.
// Sin esperar más de LATEST_WAIT_MS: un registry lento no cuelga la lectura del chat, solo deja el campo sin `latest`.
const LATEST_TTL_MS = 60_000;
const LATEST_WAIT_MS = 3_000;

/** Ocupación de la ventana al cerrar el turno, del último `context.usage` del log (el que emite emitContextUsage desde
 * agent.trace.context); el builder lo pinta como "Contexto NN %" (docs/spec/contexto-agente.md §2). */
export function contextOf(events: readonly { type: string }[]): { context?: { ratio: number; lastTokens: number; floorTokens: number; window: number } } {
  const e = events.findLast((ev) => ev.type === 'context.usage') as { ratio: number; lastTokens: number; floorTokens: number; window: number } | undefined;
  return e ? { context: { ratio: e.ratio, lastTokens: e.lastTokens, floorTokens: e.floorTokens, window: e.window } } : {};
}

export class RunReads {
  constructor(private deps: RunReadsDeps) {}

  private latest?: { at: number; pin: string };

  /** ¿Existe el mensaje y es de otra sesión? Para el latido, que lista varios ws y no puede dar 404 a uno solo. */
  denies(session: Session, id: string): boolean {
    const index = this.deps.index();
    return Object.hasOwn(index, id) && !owns(session, index[id] as Readonly<MessageEntry>);
  }

  /** El router resuelve el dueño antes del scope: solo un mensaje que existe y es de la sesión sigue adelante; lo demás es 404. */
  visible(session: Session, id: string): boolean {
    const index = this.deps.index();
    return Object.hasOwn(index, id) && owns(session, index[id] as Readonly<MessageEntry>);
  }

  /** Lo mismo para `/variants/:groupId`: el dueño es el de cualquiera de las variantes del grupo. */
  visibleGroup(session: Session, groupId: string): boolean {
    const first = Object.values(this.deps.index()).find((e) => e.variantOf?.groupId === groupId);
    return first !== undefined && owns(session, first);
  }

  /** El pin del registry con el que se construyó una versión: su request.json (lo mismo que Runtime.pinOf). */
  private pinAt(dir: string, commit: string): { pin?: string; skill?: string } {
    if (!listFiles(dir, commit, [REQUEST_FILE]).length) return {};
    const rec = JSON.parse(showFile(dir, commit, REQUEST_FILE)) as Record<string, unknown>;
    const pin = typeof rec.registryPin === 'string' ? rec.registryPin : undefined;
    const skill = dsSkillOf(pin, typeof rec.dsSkill === 'string' ? rec.dsSkill : undefined);
    return { ...(pin ? { pin } : {}), ...(skill ? { skill } : {}) };
  }

  /** El pin que hoy publica el registry (C3, actualizar el DS). Sin registry, o si no responde a tiempo, undefined. */
  private async latestPin(): Promise<string | undefined> {
    const open = this.deps.opts.registry;
    if (!open) return undefined;
    if (this.latest && Date.now() - this.latest.at < LATEST_TTL_MS) return this.latest.pin;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), LATEST_WAIT_MS); });
      const registry = await Promise.race([open(undefined), wait]).finally(() => clearTimeout(timer));
      if (!registry) return undefined;
      this.latest = { at: Date.now(), pin: registry.pin };
      return registry.pin;
    } catch {
      return undefined;
    }
  }

  /** GET /chats/:chatId: el hilo entero para que el builder lo rehidrate al recargar, como listConversationMessages de
   * Stitch o chat/latest de v0 (transport.md §8). chatId es el mensaje raíz del workspace. Cada mensaje trae si su log ya
   * cerró: el que sigue abierto se reengancha con events?cursor. El preview se vuelve a levantar: tras reiniciar el
   * transport, la url que quedó en el log apunta a un dev server muerto. */
  async thread(chatId: string): Promise<unknown> {
    if (this.deps.entry(chatId).ws !== chatId) throw new HttpError(404, `${chatId} no es el mensaje raíz de un chat`);
    const messages = Object.entries(this.deps.index())
      .filter(([, e]) => e.ws === chatId)
      .sort(([, a], [, z]) => (a.at ?? 0) - (z.at ?? 0))
      .map(([messageId, e]) => ({
        messageId,
        parentId: e.parentId ?? null,
        prompt: e.prompt ?? e.title ?? messageId,
        ...(e.model ? { model: e.model } : {}),
        // Fila 1: el builder hidrata el effort del turno cortado para Continuar.
        ...(e.thinking ? { thinking: e.thinking } : {}),
        commit: e.commit ?? null,
        // La marca de cada versión, para que el panel de Tema marque la vigente sin adivinarla del hilo.
        ...((b) => (b ? { brand: b } : {}))(e.commit ? this.deps.brandOf(chatId, e.commit) : undefined),
        at: e.at ?? null,
        ...((r) => ({ done: r.done, ...contextOf(r.events) }))(readEvents(this.deps.logDir, messageId)),
        // R2.3/R2.6: el desenlace y "Continuar" se rehidratan de aquí; el sessionId no sale.
        ...(e.outcome ? { outcome: e.outcome } : {}),
        ...(e.interrupted ? { interrupted: true } : {}),
        ...(e.continuable !== undefined ? { continuable: e.continuable && !e.continued } : {}),
        ...(e.continueOf ? { continueOf: e.continueOf } : {}),
        ...(e.autoRepair ? { autoRepair: e.autoRepair } : {}),
      }));
    // Las variantes son chats propios (ws = su id) y el filtro de arriba las perdía al recargar (R3.4): salen por su fuente.
    const variants = Object.entries(this.deps.index())
      .filter(([, e]) => e.variantOf && e.parentId && this.deps.index()[e.parentId]?.ws === chatId)
      .map(([messageId, e]) => {
        const { groupId, index, count } = e.variantOf as NonNullable<MessageEntry['variantOf']>;
        const { done, events } = readEvents(this.deps.logDir, messageId);
        return {
          messageId,
          groupId,
          sourceId: e.parentId as string,
          index,
          count,
          title: e.title ?? messageId,
          commit: e.commit ?? null,
          at: e.at ?? null,
          done,
          queued: !done && events.some((ev) => ev.type === 'run.queued') && !events.some((ev) => ev.type === 'run.started'),
          ...(e.outcome ? { outcome: e.outcome } : {}),
        };
      })
      .sort((a, z) => (a.at ?? 0) - (z.at ?? 0) || a.index - z.index);
    const dir = this.deps.wsDir(chatId);
    // Url estable del ws (R5.1): no se arranca vite aquí (lo hace el latido, gated por install, ADR §3.2-3.3); el proxy
    // sirve dist o lo levanta bajo demanda. Antes se devolvía el puerto de vite, que tras reiniciar apuntaba a un server
    // muerto, y el ensure ansioso del GET podía chocar con un install a medias (R1.3).
    const preview = this.deps.opts.previews && this.deps.opts.previewPort !== undefined && messages.some((m) => m.commit) && existsSync(dir) ? this.deps.stableUrl(chatId) : null;
    // El builder hidrata sus rules de aquí: tras recargar las tenía vacías y el siguiente follow-up mandaba [], que gana a
    // las heredadas y quedaba escrito en instructions.json (pérdida de datos, C6). Las del último mensaje con versión.
    const head = messages.filter((m) => m.commit).at(-1)?.commit;
    const instructions = head && existsSync(dir) ? this.instructionsAt(dir, head) : [];
    // C3: el DS con que está construido el chat (la versión HEAD) y el que hoy publica el registry; con los dos distintos
    // el builder ofrece "Actualizar DS" (POST /runs {updateDs: true, parentId}). Sin registry no hay campo. `skill` es el DS del
    // chat y `latestSkill` el que publica el registry del perfil: si difieren, updateDs responde 409 y el builder no lo ofrece.
    const { pin, skill } = head && existsSync(dir) && isRepo(dir) ? this.pinAt(dir, head) : {};
    const latest = await this.latestPin();
    const latestSkill = config().agentSkillId;
    const ds = this.deps.opts.registry && (pin || latest) ? { ...(pin ? { pin } : {}), ...(skill ? { skill } : {}), ...(latest ? { latest, latestSkill } : {}) } : undefined;
    return { chatId, messages, variants, preview, instructions, ...(ds ? { ds } : {}) };
  }

  /** Las instructions guardadas en la versión `commit`, o [] si esa versión no tiene archivo. */
  instructionsAt(dir: string, commit: string): string[] {
    return listFiles(dir, commit, [INSTRUCTIONS_FILE]).length ? (JSON.parse(showFile(dir, commit, INSTRUCTIONS_FILE)) as string[]) : [];
  }

  /** GET /runs/:id/versions: las versiones del workspace de ese mensaje, en orden, para el picker. Cada una trae su +N/-N
   * contra la base del diff, como el diff-stats por mensaje de v0 (deob/v0-design-mode/deobfuscated.js:21282-21288) y el
   * changedFiles de versionCreated de Make (figma-make.md §3): el picker no pide el diff entero de cada versión. */
  versions(id: string): unknown {
    const { ws } = this.deps.entry(id);
    const dir = this.deps.wsDir(ws);
    const head = existsSync(dir) && isRepo(dir) ? headSha(dir) : undefined;
    const list = Object.entries(this.deps.index())
      .filter(([, e]) => e.ws === ws && e.commit && e.asked === undefined && !planOnly(e, e.parentId ? this.deps.index()[e.parentId]?.commit : undefined))
      .map(([messageId, e]) => ({ messageId, parentId: e.parentId ?? null, commit: e.commit, title: e.title ?? messageId, at: e.at ?? null, restoreFrom: e.restoreFrom ?? null, updatedDs: e.updatedDs ?? null, appliedBrand: e.appliedBrand ?? null, appliedTheme: e.appliedTheme ?? null, head: e.commit === head, stats: head ? this.statsOf(dir, e) : null }))
      .sort((a, z) => (a.at ?? 0) - (z.at ?? 0));
    return { versions: list };
  }

  /** GET /runs/:id/events: NDJSON desde seq+1 hasta que el job termina (después del snapshot). */
  async stream(id: string, cursor: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.deps.entry(id);
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    let closed = false;
    req.on('close', () => { closed = true; });
    let after = cursor;
    const beat = this.deps.opts.heartbeatMs ?? HEARTBEAT_MS;
    let quietSince = Date.now();
    for (;;) {
      // Se mira antes de leer: si el job ya terminó, esta lectura trae hasta el último evento. Un plan pendiente mantiene el stream
      // abierto aunque el turno de plan ya haya cerrado: su decisión (otra pestaña, un mensaje nuevo) llega al log minutos después.
      const over = this.deps.isFinished(id) && this.deps.entry(id).plan?.status !== 'pending';
      const { events, cursor: next } = readEvents(this.deps.logDir, id, { after });
      for (const e of events) res.write(`${JSON.stringify(e)}\n`);
      if (events.length) quietSince = Date.now();
      else if (Date.now() - quietSince >= beat) {
        res.write('\n');
        quietSince = Date.now();
      }
      after = next;
      if (over || closed) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    res.end();
  }

  /** GET /runs/:id: el log completo y su fold, para pintar un mensaje sin stream. */
  snapshot(id: string): unknown {
    this.deps.entry(id);
    const { events } = readEvents(this.deps.logDir, id);
    return { events, state: foldMessage(events) };
  }

  private versionOf(id: string): { dir: string; commit: string; entry: Readonly<MessageEntry> } {
    const entry = this.deps.entry(id);
    if (!entry.commit) throw new HttpError(409, `el mensaje ${id} todavía no tiene versión`);
    return { dir: this.deps.wsDir(entry.ws), commit: entry.commit, entry };
  }

  /** GET /runs/:id/publishable: ¿pasa el gate esta versión, sin publicarla? Solo lectura, sin red y sin provider: responde
   *  igual en core y en una distro. El veredicto es el dato pedido, así que un dist que no pasa es 200 `ok:false` (el 409
   *  not-publishable es solo de POST /publish, que sí intentó una acción). 404 / 409-sin-versión como el resto de
   *  /runs/:id; 409 `no-build` sin dist servible, el mismo que publishRun. */
  async publishable(id: string): Promise<CheckResult> {
    const { dir, commit } = this.versionOf(id);
    // Lo que se publica es el paquete que se exporta (P3, sin puentes), no el dist del preview: 409 not-at-commit igual.
    return checkPublishable(await this.exportDist(dir, commit));
  }

  /** POST /runs/:id/publish: valida el dist servible de la versión y lo exporta con el PublishProvider configurado. Sin
   *  provider, 501 (publish no habilitado en core sin wiring). Pasa por el mismo gate que GET /publishable; si no pasa, 409
   *  con errors[]. El export local es síncrono: copiar una carpeta es rápido, no necesita stream. */
  async publishRun(id: string): Promise<unknown> {
    const provider = this.deps.opts.publish;
    if (!provider) throw new HttpError(501, 'publish no está habilitado');
    const { dir, commit, entry } = this.versionOf(id);
    const dist = await this.exportDist(dir, commit);
    const check = checkPublishable(dist);
    if (!check.ok) throw new HttpError(409, 'el dist no pasa las validaciones de publicación', { code: 'not-publishable', errors: check.errors, externalOrigins: check.externalOrigins });
    const result = await provider.publish(dist, { chat: entry.ws, commit, externalOrigins: check.externalOrigins });
    return { ...result, externalOrigins: check.externalOrigins };
  }

  /** GET /runs/:id/files: los archivos de la página en el commit del mensaje. */
  files(id: string): unknown {
    const { dir, commit } = this.versionOf(id);
    const paths = listFiles(dir, commit, PAGE_PATHS);
    return { commit, files: paths.map((path) => ({ path, content: showFile(dir, commit, path) })) };
  }

  /** Contra la versión sobre la que se construyó (el padre); en el primer mensaje, contra el commit base del scaffold. */
  private baseOf(dir: string, entry: Readonly<MessageEntry>): string | undefined {
    return entry.parentId ? this.deps.index()[entry.parentId]?.commit : parentOf(dir, entry.commit as string);
  }

  /** Los commits no cambian: el +N/-N de un par se calcula una vez y no un git diff por versión en cada GET. */
  private readonly statsCache = new Map<string, VersionStats>();

  private statsOf(dir: string, entry: Readonly<MessageEntry>): VersionStats | null {
    const base = this.baseOf(dir, entry);
    if (!base) return null;
    const key = `${dir}\0${base}..${entry.commit}`;
    const hit = this.statsCache.get(key);
    if (hit) return hit;
    const files = diffStats(dir, base, entry.commit as string, [REQUEST_FILE]);
    const stats = { additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), files };
    this.statsCache.set(key, stats);
    return stats;
  }

  /** GET /runs/:id/diff: contra la base de baseOf. */
  diff(id: string): unknown {
    const { dir, commit, entry } = this.versionOf(id);
    const base = this.baseOf(dir, entry);
    if (!base) throw new HttpError(409, `el mensaje ${id} no tiene versión base`);
    // request.json es la receta de la versión, no un cambio de la página: no se muestra en el diff.
    return { base, head: commit, files: diffCommits(dir, base, commit).filter((f) => f.path !== REQUEST_FILE) };
  }

  /** GET /runs/:id/shots/:file: una captura que la tool browser le devolvió al agente (agent-stream la escribe). El
   * nombre se valida contra el formato que arma el stream: nada de rutas, solo archivos de .wt/shots del hilo. */
  /** Un build de export por (ws, commit) a la vez: el export es un GET y N pedidos seguidos (Copiar página + Sitio, o un
   *  cliente que reintenta) lanzaban N `vite build`. */
  private readonly exporting = new Map<string, Promise<string>>();

  private exportDist(dir: string, commit: string): Promise<string> {
    const key = `${dir}\0${commit}`;
    const running = this.exporting.get(key);
    if (running) return running;
    const p = this.deps.exportDist(dir, commit)
      .catch((e: unknown) => {
        if (e instanceof HttpError) throw e;
        // El stderr del build es del servidor; al cliente, el mismo no-build que ya entiende el menú.
        console.error(`[runtime] build de export de ${commit} en ${dir}: ${e instanceof Error ? e.message : String(e)}`);
        throw new HttpError(409, 'la versión no se pudo construir', { code: 'no-build' });
      })
      .finally(() => this.exporting.delete(key));
    this.exporting.set(key, p);
    return p;
  }

  /** Qué formatos tiene la versión: el menú apaga los que no, porque un <a download> no puede atrapar un 404. */
  private exportFormats(dir: string, commit: string): Record<ExportFormat, boolean> {
    const has = new Set(listFiles(dir, commit, [DESIGN_FILE, PLAN_PATH]));
    // site y page salen del build de export, no del dist del preview (que lleva los puentes): solo la versión en la que está el ws.
    const built = this.deps.atCommit(dir, commit);
    return { source: true, site: built, 'design-md': has.has(DESIGN_FILE), brief: has.has(PLAN_PATH), page: built };
  }

  /** GET /runs/:id/export[?format=]: sin format, la disponibilidad; con format, el archivo. Solo lectura del ws. */
  async exportVersion(res: ServerResponse, id: string, raw: string | null): Promise<void> {
    const { dir, commit, entry } = this.versionOf(id);
    if (raw === null) return json(res, 200, { commit, formats: this.exportFormats(dir, commit) });
    const format = parseExportFormat(raw);
    if (!format) throw new HttpError(400, `format debe ser uno de ${EXPORT_FORMATS.join(', ')}`);
    // El nombre sale del primer pedido del chat: los follow-ups ("cambia el hero") no nombran la página.
    let root = entry;
    while (root.parentId && this.deps.index()[root.parentId]) root = this.deps.index()[root.parentId];
    const title = root.title ?? '';
    const send = (type: string, body: Buffer | string): void => {
      res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename="${exportFilename(title, commit, format)}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    try {
      if (format === 'source') return send('application/zip', sourceZip(dir, commit, exportSlug(title)));
      // P3: el paquete no lleva los puentes del preview; el dist de la versión (servableDist) sí los lleva.
      if (format === 'site') return send('application/zip', siteZip(await this.exportDist(dir, commit), exportSlug(title)));
      if (format === 'page') return send('text/html; charset=utf-8', pageHtml(await this.exportDist(dir, commit)));
      const path = format === 'design-md' ? DESIGN_FILE : PLAN_PATH;
      if (!listFiles(dir, commit, [path]).length) throw new HttpError(404, `esta versión no tiene ${path}`);
      return send('text/markdown; charset=utf-8', showFile(dir, commit, path));
    } catch (e) {
      if (e instanceof ExportTooLarge) throw new HttpError(413, e.message);
      if (e instanceof ExportRefused) throw new HttpError(422, e.message);
      throw e;
    }
  }

  /** GET /runs/:id/tree: el árbol commiteado de la versión para un cliente MCP (H9, P2, solo lectura). Mismas reglas que
   *  el zip `source`: lo commiteado, sin symlinks ni submódulos (422) y con el tope de 50 MiB (413). Excluye
   *  `SOURCE_EXCLUDE` (P1: request.json/instructions.json no son la página). */
  tree(id: string): unknown {
    const { dir, commit } = this.versionOf(id);
    const entries = treeEntries(dir, commit);
    if (entries.some((e) => e.mode === '120000' || e.mode === '160000')) throw new HttpError(422, 'la versión tiene symlinks o submódulos en el árbol');
    const files = entries.filter((e) => !(SOURCE_EXCLUDE as readonly string[]).includes(e.path));
    // Tope por cantidad además de por bytes: muchos archivos vacíos no suman bytes pero sí inflan el JSON (misma cota que el zip).
    if (files.length > MAX_ENTRIES) throw new HttpError(413, `el árbol pasa de ${MAX_ENTRIES} archivos`);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    if (bytes > EXPORT_MAX_BYTES) throw new HttpError(413, `el árbol pasa de ${EXPORT_MAX_BYTES} bytes`);
    return { commit, files: files.map((f) => ({ path: f.path, size: f.size })) };
  }

  /** GET /runs/:id/file?path=: el contenido de texto de una ruta commiteada (H9, P2). La ruta tiene que existir en el
   *  árbol del commit: no hay acceso al disco ni rutas relativas, así que `..` o un symlink no sacan nada de fuera.
   *  Binario → 422 `{code:'binary', size}` (se baja con el export); ruta ausente o excluida por P1 → 404; symlink o
   *  submódulo → 422; tope 50 MiB → 413. */
  readFile(id: string, path: string): unknown {
    if (!path) throw new HttpError(400, 'falta el parámetro path');
    const { dir, commit } = this.versionOf(id);
    if ((SOURCE_EXCLUDE as readonly string[]).includes(path)) throw new HttpError(404, 'esa ruta no se exporta');
    const entry = treeEntries(dir, commit).find((e) => e.path === path);
    if (!entry) throw new HttpError(404, 'no hay esa ruta en la versión');
    if (entry.mode === '120000' || entry.mode === '160000') throw new HttpError(422, 'esa ruta es un symlink o submódulo');
    if (entry.size > EXPORT_MAX_BYTES) throw new HttpError(413, `el archivo pasa de ${EXPORT_MAX_BYTES} bytes`);
    const buf = showFileBytes(dir, commit, path);
    if (buf.includes(0)) throw new HttpError(422, 'el archivo es binario; bájalo con el export', { code: 'binary', size: buf.length });
    return { commit, path, content: buf.toString('utf8') };
  }

  shot(res: ServerResponse, id: string, file: string): void {
    const { ws } = this.deps.entry(id);
    if (!SHOT_FILE.test(file)) throw new HttpError(400, 'nombre de captura inválido');
    const path = join(this.deps.wsDir(ws), SHOTS_DIR, file);
    // El agente tiene herramientas sobre el workspace: un symlink con nombre válido (o .wt/shots apuntando a otra
    // carpeta) serviría un archivo de fuera. Solo archivos regulares dentro del .wt/shots real de este workspace.
    if (!isOwnShot(this.deps.wsDir(ws), path)) throw new HttpError(404, 'no hay esa captura');
    // El nombre lleva el tool_use_id: una captura no cambia nunca.
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
    res.end(readFileSync(path));
  }
}
