// Runtime de corridas: HTTP nativo que arranca una corrida desacoplada de la conexión y expone su log
// por messageId, como POST /chat/api/chat + resume?messageId&cursor de v0 (VERIFIED, v0-endpoint-map.md
// §4e-§4f). Desvíos a propósito: cursor = seq por evento (no offset de bytes), NDJSON append-only, una
// sola conexión larga (sin tramos de 10 s), snapshot emitido por el runner con el sha del commit.
// Diseño y contrato: ~/Desktop/web-transformer-v0-re/transport-design.md.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { type EventLog, type Suggestion } from './events';
import { listFiles, showFile } from './git-workspace';
import { VariantRuns } from './variants';
import { BrandRuns } from './brand-runs';
import { buildExportDist, isAtCommit, PreviewDist } from './preview-dist';
import { EditRuns } from './edit-runs';
import { AgentMcp } from './agent-mcp';
import { type Allowlist, type PageModel } from './runner';
import { SECTION_SLUG } from './section-ops';
import type { SectionSuggestHook } from './agent-composer';
import type { Connectors } from './connectors';
import { isBrandId } from '../brand-registry';
import type { ConnectorMcp } from './connector-mcp';
import { HttpError, readBody } from './http';
import { pinsFrom, type Pin } from './pinned';
import { LOCAL_OWNER, owns, type Session } from './session';
import { type Composer, type RuntimeOptions, isIanaZone, isoDateInTz, isRepairEntry, MESSAGE_ID, PAGE_FILE, parseInstructions, REQUEST_FILE, stepAsync, titleOf, type LiveTurn, type MessageEntry } from './shared';
import { Approvals } from './approvals';
import { MAX_ATTACHMENTS, UploadStore, type Upload } from './uploads';
import { AUTO_MODEL } from './agent-loop';
import { ApiHandlers } from './api-handlers';
import { BrandStore } from './brand-store';
import { HttpRouter } from './http-router';
import { parseThinking } from './run-input';
import { validateMemoryEdit } from './memory-edit';
import { RunReads } from './run-reads';
import { dsSkillOf, RunChecks, type RequestKey } from './run-checks';
import { RunClose, SHUTDOWN_REASON } from './run-close';
import type { DirectEditDeps } from './direct-edit';
import { escapesWorkspace } from './direct-edit';

export { agentDescribe, reasonOf, type AutoRepairKind, type ComposeRequest, type Composer, type ImageModel, type ModelOption, type ThinkingEffort, type RuntimeOptions } from './shared';
export { isTrustedRequest, UPLOAD_HEADER, type OriginTrust } from './http';
export type { BrandSummary } from './brand-store';
export { mountingLog, remountApp } from './run-cycle-mount';
import { RunCycle } from './run-cycle';
import { createChatReservations } from './chat-reservations';
export { escapesWorkspace };

// Más que el SIGKILL del CLI (KILL_AFTER_MS, 5 s): un agente que ignora el SIGTERM igual cae antes de que el proceso salga.
const SHUTDOWN_GRACE_MS = 8_000;

/** Cuántas direcciones se recuerdan por clave: pickDirection excluye todas las que pueda sin bajar de MIN_POOL candidatas. */
const RECENT_KEEP = 8;


// Cada corrida instala y compila: más de esto en paralelo es un abuso o un bug del cliente.
const MAX_RUNNING = 3;


const LOCK_FILE = '.lock';
// Dueño: el proceso. Cada Runtime registra su root al construirse y el handler de exit los suelta todos; es por proceso
// porque `exit` es del proceso. Dos Runtime con roots distintos conviven; el mismo root en el mismo proceso se re-toma (tests).
const lockedRoots = new Set<string>();

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: existe, pero es de otro usuario.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Un root, un proceso (issue-recover-lock.md): un segundo transport sobre el mismo --root cerraba como muertas las
 * corridas vivas del primero y pisaba su index.json. El lock de un pid muerto (kill -9) se toma; el del propio proceso
 * también, porque un mismo proceso puede volver a abrir su root (reinicio en tests). */
export function lockRoot(root: string): void {
  const path = join(root, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (pid === process.pid) break;
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) throw new Error(`${root} ya lo usa otro transport (pid ${pid}): usa otro --root o detén ese proceso`);
      rmSync(path, { force: true });
    }
  }
  if (lockedRoots.size === 0) process.once('exit', () => { for (const p of lockedRoots) rmSync(p, { force: true }); });
  lockedRoots.add(path);
}

export class Runtime {
  private uploads: UploadStore;
  /** Handlers de la API que no tocan corridas (api-handlers.ts): enhancer, conectores, uploads, dictado, lienzo. */
  private api: ApiHandlers;
  private index: Record<string, MessageEntry>;
  private running = new Set<string>();
  private finished = new Set<string>();
  /** Pasos tardíos por mensaje (preview-check ‖ sugerencias): corren después de message.end y settle() los espera. */
  private late = new Map<string, Promise<unknown>>();
  /** El preview-check tardío de cada workspace: una corrida nueva lo corta, porque miraría el HMR del turno nuevo. */
  private lateChecks = new Map<string, AbortController>();
  /** Ideas por (mensaje, sección): la versión no cambia, así que una vez pedidas valen hasta reiniciar. */
  private sectionIdeas = new Map<string, Promise<Suggestion[]> | Suggestion[]>();
  /** Corridas de modelo en curso por mensaje: POST /runs/:id/cancel aborta la suya. */
  private cancels = new Map<string, AbortController>();
  /** Quién cortó cada corrida: queda como paso en su propio log. QA 2026-11-02 (a67a41ed, d0b82343): dos turnos
   * cerraron 'stopped' y el log no decía si fue la persona, el grupo o el cierre del transport. */
  private stopReasons = new Map<string, string>();
  /** Variantes: cola, grupos y su ciclo (variants.ts). */
  private variants!: VariantRuns;
  private brandRuns!: BrandRuns;
  /** El proceso se está cerrando: no arranca corridas nuevas (variantes en cola, AutoFix, POST /runs). */
  private closing = false;
  /** Turno con composer en curso por workspace: un POST /runs sobre ese workspace entra a este turno en vez de dar 409. */
  private live = new Map<string, LiveTurn>();
  private readonly logDir: string;
  private get maxRunning(): number { return this.opts.maxRunning ?? MAX_RUNNING; }
  /** Allowlist de cada índice ya leído, por pin. Es caché, no estado: el pin de cada versión está en su
   * request.json, así que tras reiniciar se vuelve a leer del store. */
  private allowByPin = new Map<string, Allowlist>();
  /** Marcas disponibles e instrucciones por marca (brand-store.ts). */
  private brands: BrandStore;
  private reads: RunReads;
  private readonly indexPath: string;
  /** Últimas direcciones por marca (`brand:<id>`) o brief (`brief:<hash>`), la más reciente al final: directions.json. */
  private directions: Record<string, string[]>;
  private readonly directionsPath: string;
  private approvals: Approvals;
  /** Corridas del agente que pueden pedir aprobación, por token: el token ata el pedido a su mensaje. */
  /** `allowed`: tools que el guard aprobó en esta corrida y aún no se llamaron; `/connector-mcp` consume una por llamada.
   * `sessions`: mcp-session-id de Pipedream por app. */
  /** Llamadas a generate_image por messageId: sobrevive al reabrir aprobaciones del resume de build (C2) y se borra en
   * release. Cuenta llamadas, que es lo que se paga, no rutas distintas. */
  private imageUse = new Map<string, { attempts: number; made: number; inFlight: number }>();
  private port?: number;
  private previewDist: PreviewDist;
  private edits: EditRuns;
  /** El MCP del workspace y las aprobaciones de la corrida (agent-mcp.ts): dueño del mapa approvalRuns. */
  private agentMcp: AgentMcp;
  /** Comprobaciones y preparación de un turno, sin estado del transport más allá del índice (run-checks.ts). */
  private checks: RunChecks;
  /** Cómo un turno se vuelve versión, pregunta, plan o nada, y la recuperación de corridas a medias (run-close.ts). */
  private close: RunClose;
  /** El ciclo de corrida: start, run, cancel, settle, launch (run-cycle.ts). */
  private cycle!: RunCycle;
  /** Rutas, origen y listen (http-router.ts). */
  private router!: HttpRouter;

  constructor(private opts: RuntimeOptions) {
    // Una zona horaria mal escrita hace RangeError en el primer `remember`, no al arrancar: se valida acá para que falle en
    // el boot con un mensaje claro en vez de a mitad de una corrida.
    if (opts.timezone !== undefined && !isIanaZone(opts.timezone)) throw new Error(`timezone inválida: "${opts.timezone}" no es una zona IANA (p. ej. America/Mexico_City)`);
    // El "siempre" es de quien abrió el chat, no de quien aprueba la tarjeta: el CLI llama sin sesión (identidad §8).
    this.approvals = new Approvals(opts.approvalTimeoutMs, join(opts.root, 'approvals.json'), (chat) => (Object.hasOwn(this.index, chat) ? this.index[chat]?.owner : undefined) ?? LOCAL_OWNER);
    this.logDir = join(opts.root, 'logs');
    this.indexPath = join(opts.root, 'index.json');
    this.directionsPath = join(opts.root, 'directions.json');
    this.directions = existsSync(this.directionsPath) ? (JSON.parse(readFileSync(this.directionsPath, 'utf8')) as Record<string, string[]>) : {};
    mkdirSync(this.logDir, { recursive: true });
    lockRoot(opts.root);
    if (opts.previews) opts.previews.protect = (dir) => [...this.running, ...this.lateChecks.keys()].some((ws) => this.wsDir(ws) === dir);
    // Con la url estable, `Preview.url` es el proxy del puerto dedicado, no el puerto efímero de vite (R5.1): así el
    // evento type:'preview' y thread() dan al builder una url que no cambia al reiniciarse vite.
    if (opts.previews && opts.previewPort !== undefined) opts.previews.stableUrl = (dir) => this.previewDist.stableUrl(basename(dir));
    this.previewDist = new PreviewDist({ ...(opts.previews ? { previews: opts.previews } : {}), ...(opts.previewPort !== undefined ? { previewPort: opts.previewPort } : {}), ...(opts.previewOrigin ? { previewOrigin: opts.previewOrigin } : {}), ...(opts.previewSecret ? { previewSecret: opts.previewSecret } : {}), ...(opts.previewPublicKey ? { previewPublicKey: opts.previewPublicKey } : {}), wsDir: (ws) => this.wsDir(ws), hasWs: (ws) => Object.values(this.index).some((e) => e.ws === ws), ownsWs: (ws, owner) => Object.hasOwn(this.index, ws) && (this.index[ws]?.owner ?? LOCAL_OWNER) === owner });
    this.uploads = new UploadStore(join(opts.root, 'uploads'));
    this.brands = new BrandStore({ root: opts.root, ...(opts.brandsRoot ? { brandsRoot: opts.brandsRoot } : {}), ...(opts.registry ? { registry: opts.registry } : {}), parseInstructions });
    this.reads = new RunReads({
      index: () => this.index,
      entry: (id) => this.entry(id),
      wsDir: (ws) => this.wsDir(ws),
      logDir: this.logDir,
      isFinished: (id) => this.finished.has(id),
      brandOf: (ws, commit) => this.brandOf(ws, commit),
      stableUrl: (ws) => this.previewDist.stableUrl(ws),
      servableDist: (dir, commit) => this.previewDist.servableDist(dir, commit),
      exportDist: (dir, commit) => buildExportDist(dir, commit),
      atCommit: isAtCommit,
      opts,
    });
    this.api = new ApiHandlers({
      ...(opts.enhance ? { enhance: opts.enhance } : {}), ...(opts.enhanceTimeoutMs !== undefined ? { enhanceTimeoutMs: opts.enhanceTimeoutMs } : {}),
      ...(opts.connectors ? { connectors: opts.connectors } : {}), ...(opts.transcribe ? { transcribe: opts.transcribe } : {}),
      uploads: this.uploads,
      canvasDir: (chatId) => {
        const { ws } = this.entry(chatId);
        if (ws !== chatId) throw new HttpError(404, 'chatId debe ser el mensaje raíz del chat');
        return this.wsDir(ws);
      },
    });
    // Getters: running y opts se leen en cada uso, como cuando estos métodos vivían aquí.
    const t = this;
    this.edits = new EditRuns({
      get opts() { return t.opts; }, get logDir() { return t.logDir; }, get running() { return t.running; }, get maxRunning() { return t.maxRunning; },
      index: () => this.index, updateEntry: (id, patch) => this.updateEntry(id, patch), wsDir: (ws) => this.wsDir(ws), entry: (id) => this.entry(id), claim: (ws) => this.claim(ws), release: (id, ws) => this.release(id, ws),
      supersede: (ws) => this.supersede(ws), settle: (id) => this.settle(id), launch: (id, ws, input) => this.launch(id, ws, input), end: (...a) => this.end(...a),
      background: (what, id, work) => this.background(what, id, work), parseModel: (v) => this.parseModel(v), parseThinking,
      assertAutoRepairable: (parent) => this.assertAutoRepairable(parent), requestField: (dir, commit, key) => this.requestField(dir, commit, key),
      pinOf: (dir, commit) => this.pinOf(dir, commit), allowAt: (pin) => this.allowAt(pin), directEditDeps: () => this.directEditDeps(),
    });
    this.index = existsSync(this.indexPath) ? (JSON.parse(readFileSync(this.indexPath, 'utf8')) as Record<string, MessageEntry>) : {};
    this.agentMcp = new AgentMcp({
      opts,
      logDir: this.logDir,
      approvals: this.approvals,
      port: () => this.port,
      wsDir: (ws) => this.wsDir(ws),
      entry: (id) => this.entry(id),
      index: () => this.index,
      cancels: this.cancels,
      imageUse: this.imageUse,
      updateEntry: (id, patch) => this.updateEntry(id, patch),
      startPlanBuild: (id, edited, viewport) => this.resumePlanBuild(id, edited, viewport),
      assertCanBuildPlan: (id) => this.assertCanBuildPlan(id),
      startTurn: async (body) => (await this.start(body)) as { messageId: string },
      brands: this.brands,
      today: (messageId) => isoDateInTz(new Date(), this.index[messageId]?.timezone ?? opts.timezone),
    });
    this.variants = new VariantRuns({
      logDir: this.logDir, index: () => this.index, running: this.running, cancels: this.cancels, stopReasons: this.stopReasons,
      agent: Boolean(opts.agent), parseThinking, finished: this.finished, entry: (id) => this.entry(id), background: (what, id, work) => this.background(what, id, work),
      parseModel: (v) => this.parseModel(v), parseImageGeneration: (v) => this.parseImageGeneration(v),
      ...(opts.variantsPlan ? { variantsPlan: opts.variantsPlan } : {}),
      maxRunning: () => this.maxRunning, closing: () => this.closing, wsDir: (ws) => this.wsDir(ws), updateEntry: (id, patch) => this.updateEntry(id, patch), claim: (ws) => this.claim(ws),
      launch: (id, ws, input) => this.launch(id, ws, input), end: (id, log, reason) => this.end(id, log, reason), settle: (id) => this.settle(id), titleOf, pageFile: PAGE_FILE,
    });
    this.brandRuns = new BrandRuns({
      opts, logDir: this.logDir, index: () => this.index, running: this.running, allowByPin: this.allowByPin, brands: this.brands,
      maxRunning: () => this.maxRunning, wsDir: (ws) => this.wsDir(ws), updateEntry: (id, patch) => this.updateEntry(id, patch), end: (id, log, reason) => this.end(id, log, reason),
      supersede: (ws) => this.supersede(ws), pinOf: (dir, commit) => this.pinOf(dir, commit), dsSkillOf: (dir, commit) => dsSkillOf(this.pinOf(dir, commit), this.requestField(dir, commit, 'dsSkill')), brandOf: (ws, commit) => this.brandOf(ws, commit),
      agentWorkspace: (dir, log, registry, points, pack, signal) => this.agentWorkspace(dir, log, registry, points, pack, signal), entry: (id) => this.entry(id),
      claim: (ws) => this.claim(ws), background: (what, id, work) => this.background(what, id, work), release: (id, ws) => this.release(id, ws),
    });
    this.checks = new RunChecks({ index: () => this.index });
    this.close = new RunClose({
      opts, logDir: this.logDir, index: () => this.index, updateEntry: (id, patch) => this.updateEntry(id, patch), wsDir: (ws) => this.wsDir(ws),
      checks: this.checks, previewDist: this.previewDist, agentMcp: this.agentMcp, variants: this.variants,
      stopReasons: this.stopReasons, lateChecks: this.lateChecks, late: this.late,
    });
    const self = this;
    this.cycle = new RunCycle({
      get opts() { return self.opts; }, get logDir() { return self.logDir; }, get index() { return self.index; }, get closing() { return self.closing; },
      get maxRunning() { return self.maxRunning; }, get directions() { return self.directions; }, get port() { return self.port; },
      running: this.running, finished: this.finished, late: this.late, lateChecks: this.lateChecks, cancels: this.cancels, stopReasons: this.stopReasons,
      live: this.live, imageUse: this.imageUse, allowByPin: this.allowByPin,
      get agentMcp() { return self.agentMcp; }, get brandRuns() { return self.brandRuns; }, get brands() { return self.brands; }, get edits() { return self.edits; },
      get reads() { return self.reads; }, get uploads() { return self.uploads; }, get variants() { return self.variants; },
      updateEntry: (id, patch) => this.updateEntry(id, patch), entry: (id) => this.entry(id), wsDir: (ws) => this.wsDir(ws), agentAt: (id) => this.agentAt(id), pinsAt: (parentId, dictated) => this.pinsAt(parentId, dictated),
      allowAt: (pin) => this.allowAt(pin), brandOf: (ws, commit) => this.brandOf(ws, commit), pinOf: (dir, commit) => this.pinOf(dir, commit),
      requestField: (dir, commit, key) => this.requestField(dir, commit, key), connectApps: (slugs, log, runToken) => this.connectApps(slugs, log, runToken),
      withRegistry: (log, stepId, labels, fn) => this.withRegistry(log, stepId, labels, fn), parseAttachments: (v) => this.parseAttachments(v),
      parseModel: (v) => this.parseModel(v), parseImageGeneration: (v) => this.parseImageGeneration(v), rememberDirection: (key, id) => this.rememberDirection(key, id),
      end: (...a) => this.end(...a), keepPlan: (...a) => this.keepPlan(...a), keepStopped: (...a) => this.keepStopped(...a), materialize: (...a) => this.materialize(...a),
      untouched: (messageId, dir) => this.untouched(messageId, dir), installDeps: (...a) => this.installDeps(...a),
    });
    // Lo que el índice tiene de una vida anterior del proceso ya no está corriendo.
    for (const id of Object.keys(this.index)) {
      const group = this.index[id].variantOf;
      if (group) this.variants.restoreGroup(group.groupId, id);
      if (this.recover(id) !== 'queued') this.finished.add(id);
    }
    // El grupo sale del índice, en el orden de las variantes: el cancel por grupo sigue andando tras reiniciar (R3.3).
    this.variants.sortGroups();
    this.router = new HttpRouter({
      opts, port: () => this.port, setPort: (port) => { this.port = port; },
      brands: this.brands, api: this.api, variants: this.variants, agentMcp: this.agentMcp, approvals: this.approvals, reads: this.reads, previewDist: this.previewDist,
      handleBrandInstructions: (req, raw, owner) => this.handleBrandInstructions(req, raw, owner), handleBrandMemory: (req, raw, owner) => this.handleBrandMemory(req, raw, owner), putPlan: (req, chat, id) => this.putPlan(req, chat, id), start: (body, session, runToken) => this.start(body, session, runToken),
      cancel: (id) => this.cancel(id), sectionSuggestions: (id, slug) => this.sectionSuggestions(id, slug),
      reservations: createChatReservations({ exists: (id) => Object.hasOwn(this.index, id) }),
      chatOf: (id) => (Object.hasOwn(this.index, id) ? this.index[id]?.ws : undefined),
      inChat: (id, chat) => {
        const e = Object.hasOwn(this.index, id) ? this.index[id] : undefined;
        return e !== undefined && (e.ws === chat || (e.variantOf !== undefined && e.parentId !== undefined && this.index[e.parentId]?.ws === chat));
      },
      groupInChat: (groupId, chat) => Object.values(this.index).some((e) => e.variantOf?.groupId === groupId && e.parentId !== undefined && this.index[e.parentId]?.ws === chat),
      ownChats: (session) => {
        // Una pasada: el último `at` de cada ws, en vez de recorrer el índice por cada chat.
        const last = Object.values(this.index).reduce((acc, m) => acc.set(m.ws, Math.max(acc.get(m.ws) ?? 0, m.at ?? 0)), new Map<string, number>());
        return Object.entries(this.index)
          .filter(([id, e]) => e.ws === id && !e.variantOf && owns(session, e))
          .map(([id, e]) => ({ chatId: id, owner: e.owner ?? LOCAL_OWNER, title: e.title ?? '', updatedAt: last.get(id) ?? 0 }));
      },
    });
  }

  private recover(id: string): 'queued' | undefined {
    return this.close.recover(id);
  }

  private save(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2));
  }

  /** El ciclo de corrida vive en run-cycle.ts; estos delegan porque otros colaboradores y los tests los alcanzan por Runtime (ADR 0014 6.9). */
  private claim(...a: Parameters<RunCycle['claim']>): void { this.cycle.claim(...a); }
  private supersede(...a: Parameters<RunCycle['supersede']>): void { this.cycle.supersede(...a); }
  private settle(...a: Parameters<RunCycle['settle']>): Promise<void> { return this.cycle.settle(...a); }
  private background(...a: Parameters<RunCycle['background']>): void { this.cycle.background(...a); }
  async start(body: unknown, session?: Session, runToken?: string): ReturnType<RunCycle['start']> { return this.cycle.start(body, session, runToken); }
  private launch(...a: Parameters<RunCycle['launch']>): void { this.cycle.launch(...a); }
  private release(...a: Parameters<RunCycle['release']>): void { this.cycle.release(...a); }
  cancel(id: string): { messageId: string } { return this.cycle.cancel(id); }
  private assertCanBuildPlan(...a: Parameters<RunCycle['assertCanBuildPlan']>): void { this.cycle.assertCanBuildPlan(...a); }
  private resumePlanBuild(...a: Parameters<RunCycle['resumePlanBuild']>): void { this.cycle.resumePlanBuild(...a); }
  private agentWorkspace(...a: Parameters<RunCycle['agentWorkspace']>): ReturnType<RunCycle['agentWorkspace']> { return this.cycle.agentWorkspace(...a); }

  /** La única escritura del índice que ven los colaboradores (ADR 0014 regla 3): fusiona el patch y guarda. */
  private updateEntry(id: string, patch: Partial<MessageEntry>): void {
    // El dueño baja por herencia: los hijos que crean edit-runs, brand-runs y variants no lo escriben, lo hereda el que persiste
    // (A2), del padre o, si no hay padre (un restore sin HEAD), de la raíz del ws. El raíz lo escribe run-cycle con la sesión.
    const owner = this.index[id]?.owner ?? patch.owner ?? (patch.parentId ? this.index[patch.parentId]?.owner : undefined) ?? (patch.ws ? this.index[patch.ws]?.owner : undefined);
    this.index[id] = { ...this.index[id], ...patch, ...(owner !== undefined ? { owner } : {}) } as MessageEntry;
    this.save();
  }


  /** Lo dictado que la versión del padre todavía tiene en src/ (preserve.pinned). Sin commit legible, nada fijo. */
  private pinsAt(parentId: string, dictated: { messageId: string; literals: string[] }[]): Pin[] {
    const { commit, ws } = this.index[parentId] ?? {};
    if (!commit || !ws) return [];
    try {
      const dir = this.wsDir(ws);
      const files = Object.fromEntries(listFiles(dir, commit, ['src']).filter((f) => /\.(tsx|ts|jsx|js)$/.test(f)).map((f) => [f, showFile(dir, commit, f)]));
      return pinsFrom(dictated, files);
    } catch {
      return [];
    }
  }


  private agentAt(id: string): { summary?: string; files?: string[] } | undefined {
    const { commit, ws, asked } = this.index[id] ?? {};
    if (asked !== undefined) return { ...(asked ? { summary: asked } : {}), files: [] };
    if (!commit || !ws) return undefined;
    try {
      const agent = (JSON.parse(showFile(this.wsDir(ws), commit, PAGE_FILE)) as { agent?: { summary?: unknown; files?: unknown } }).agent;
      return {
        ...(typeof agent?.summary === 'string' && agent.summary ? { summary: agent.summary } : {}),
        ...(Array.isArray(agent?.files) ? { files: agent.files.filter((f): f is string => typeof f === 'string') } : {}),
      };
    } catch {
      return undefined;
    }
  }





  /** `auto: true` (el server o el puente vivo del builder): un arreglo automático por versión y nunca sobre otro arreglo. */
  private assertAutoRepairable(parent: MessageEntry): void {
    // Con el server en manual el puente vivo del builder tampoco puede lanzarlo: el interruptor es del proceso, no del cliente.
    if (this.opts.autoRepair === false) throw new HttpError(409, 'el auto-repair está apagado en este server: usa el arreglo manual', { code: 'auto-repair-off' });
    if (isRepairEntry(parent)) throw new HttpError(409, 'la versión ya es un arreglo: el auto-repair no se encadena', { code: 'auto-repair-of-repair' });
    // Misma regla que autoRepairAfter (plan-mode.md): el builder trata este 409 como silencio y deja el botón manual.
    if (parent.plan) throw new HttpError(409, 'la versión es la fase build de un plan aprobado: usa el arreglo manual', { code: 'auto-repair-plan' });
    if (parent.autoRepaired) throw new HttpError(409, `la versión ya tuvo su auto-repair (${parent.autoRepaired})`, { code: 'auto-repair-used', childId: parent.autoRepaired });
  }


  private rememberDirection(key: string, id: string): void {
    this.directions = { ...this.directions, [key]: [...(this.directions[key] ?? []), id].slice(-RECENT_KEEP) };
    writeFileSync(this.directionsPath, JSON.stringify(this.directions, null, 2));
  }

  /** GET|PUT /brands/:id/instructions → {instructions}. PUT reemplaza la lista entera, con los topes de las del chat. */
  private async handleBrandInstructions(req: IncomingMessage, raw: string, owner: string): Promise<{ instructions: string[] }> {
    let id: string;
    try { id = decodeURIComponent(raw); } catch { throw new HttpError(400, 'id de marca inválido'); }
    if (!isBrandId(id)) throw new HttpError(400, 'id de marca inválido');
    if (req.method === 'GET') return { instructions: this.brands.instructions(owner, id) };
    if (req.method !== 'PUT') throw new HttpError(405, 'método no permitido');
    const b = (await readBody(req)) as Record<string, unknown> | null;
    const instructions = parseInstructions(b?.instructions);
    if (!instructions) throw new HttpError(400, 'falta instructions');
    if (!(await this.brands.ids()).includes(id)) throw new HttpError(404, `la marca "${id}" no existe`);
    this.brands.writeInstructions(owner, id, instructions);
    return { instructions };
  }

  /** GET|PUT /brands/:id/memory → {text}. La memoria de la marca (M2): los hechos que el agente guarda con `remember` y la
   * persona edita en el panel. PUT reemplaza el archivo entero con los topes de memory-edit (40 líneas, 4 KiB, sin datos
   * personales); el `code` del rechazo va en el cuerpo para que la UI distinga too_many_lines de pii sin parsear el texto. */
  private async handleBrandMemory(req: IncomingMessage, raw: string, owner: string): Promise<{ text: string }> {
    let id: string;
    try { id = decodeURIComponent(raw); } catch { throw new HttpError(400, 'id de marca inválido'); }
    if (!isBrandId(id)) throw new HttpError(400, 'id de marca inválido');
    // La lectura va dentro de la cadena: un GET que llega durante un remember/PUT ve el archivo ya escrito, no uno a medias.
    if (req.method === 'GET') return { text: await this.brands.withMemory(owner, id, (current) => current) };
    if (req.method !== 'PUT') throw new HttpError(405, 'método no permitido');
    const b = (await readBody(req)) as Record<string, unknown> | null;
    if (typeof b?.text !== 'string') throw new HttpError(400, 'falta text');
    const valid = validateMemoryEdit(b.text);
    if (!valid.ok) throw new HttpError(400, valid.error, { code: valid.code });
    if (!(await this.brands.ids()).includes(id)) throw new HttpError(404, `la marca "${id}" no existe`);
    // Serializado con los `remember` de corridas vivas de la misma marca (read-modify-write sobre el mismo archivo).
    await this.brands.withMemory(owner, id, () => this.brands.writeMemory(owner, id, valid.text));
    return { text: valid.text };
  }

  private directEditDeps(): DirectEditDeps {
    return { ...(this.opts.typescript ? { typescript: this.opts.typescript } : {}), ...(this.opts.tsc ? { tsc: this.opts.tsc } : {}), uploads: this.uploads };
  }

  private wsDir(ws: string): string {
    return join(this.opts.root, 'ws', ws);
  }

  private entry(id: string): MessageEntry {
    if (!MESSAGE_ID.test(id)) throw new HttpError(400, `messageId inválido "${id}"`);
    // hasOwn: `constructor` o `__proto__` son ids válidos por la regex y existirían por el prototipo.
    const e = Object.hasOwn(this.index, id) ? this.index[id] : undefined;
    if (!e) throw new HttpError(404, `no hay mensaje ${id}`);
    return e;
  }



  /** Cierre del proceso (SIGTERM/SIGINT): corta las corridas en curso como un cancel y espera a que suelten su workspace.
   * El CLI del agente es un hijo con su propio stdin; si el transport sale sin abortarlo, el turno sigue escribiendo en el
   * workspace y gastando después de muerto el server (corrida en vivo de variantes: dos AutoFix huérfanos). */
  async shutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    this.closing = true;
    // Las variantes en cola no se cierran: su run.queued queda en el log y el próximo arranque las reanuda (R3.2).
    this.variants.clear();
    for (const [id, run] of this.cancels) { this.stopReasons.set(id, SHUTDOWN_REASON); run.abort(); }
    for (const check of this.lateChecks.values()) check.abort();
    const deadline = Date.now() + graceMs;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  }





  /** Cierre de toda corrida (run-close.ts). */
  private end(...a: Parameters<RunClose['end']>): void {
    this.close.end(...a);
  }

  /** Sin escrituras del turno (run-checks.ts). */
  private untouched(messageId: string, dir: string): boolean {
    return this.checks.untouched(messageId, dir);
  }

  /** Cancel de la persona: lo que el agente alcanzó a escribir queda como versión, sin gates (run-close.ts). */
  private keepStopped(...a: Parameters<RunClose['keepStopped']>): undefined {
    return this.close.keepStopped(...a);
  }

  /** Cierre de un turno de plan (run-close.ts). */
  private keepPlan(...a: Parameters<RunClose['keepPlan']>): undefined {
    return this.close.keepPlan(...a);
  }

  /** PUT /chats/:chat/plans/:messageId {plan}: guarda un borrador de la edición mientras el plan está pendiente (coordinado
   * con ec). 409 si no hay plan pendiente. */
  private async putPlan(req: IncomingMessage, chat: string, id: string): Promise<{ ok: true; userLines: number }> {
    if (!this.opts.agent) throw new HttpError(404, 'este transport no tiene modo plan');
    const entry = this.entry(id);
    // :chat tiene que ser del mismo workspace que el mensaje del plan; si no, es otro chat y no edita este plan.
    // El mismo texto que un id inexistente: el id de otro chat no se confirma (identidad §5).
    if (this.entry(chat).ws !== entry.ws) throw new HttpError(404, `no hay mensaje ${id}`);
    const plan = entry.plan;
    if (!plan || plan.status !== 'pending') throw new HttpError(409, `el plan de ${id} no espera edición`);
    const { plan: text } = ((await readBody(req)) ?? {}) as { plan?: unknown };
    if (typeof text !== 'string') throw new HttpError(400, 'falta plan (texto editado)');
    return { ok: true, userLines: this.agentMcp.writePlanEdit(id, entry, plan, text) };
  }



  /** El pin del registry con el que se construyó una versión (su request.json). */
  private pinOf(dir: string, commit: string): string | undefined {
    return this.requestField(dir, commit, 'registryPin');
  }

  /** page.brand de una versión; undefined si la página no tiene marca o la versión no trae page.json. */
  private brandOf(ws: string, commit: string): string | undefined {
    const dir = this.wsDir(ws);
    if (!listFiles(dir, commit, [PAGE_FILE]).length) return undefined;
    const brand = (JSON.parse(showFile(dir, commit, PAGE_FILE)) as PageModel).page?.brand;
    return typeof brand === 'string' ? brand : undefined;
  }

  private requestField(dir: string, commit: string, key: RequestKey): string | undefined {
    if (!listFiles(dir, commit, [REQUEST_FILE]).length) return undefined;
    const value = (JSON.parse(showFile(dir, commit, REQUEST_FILE)) as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }

  /** La allowlist del índice de ese pin, leída del store la primera vez que hace falta. */
  private async allowAt(pin: string): Promise<Allowlist> {
    const cached = this.allowByPin.get(pin);
    if (cached) return cached;
    const open = this.opts.registry;
    if (!open) return {};
    try {
      const source = await open(pin);
      const allow = source.loadIndex ? await source.loadIndex() : {};
      this.allowByPin.set(pin, allow);
      return allow;
    } catch (e) {
      throw new HttpError(502, `registry ${pin}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async connectApps(slugs: readonly string[], log: EventLog, runToken?: string): Promise<ConnectorMcp> {
    return stepAsync(log, 'transport:connectors', ['Connecting apps', 'Connected apps'], async () => {
      const { apps, readOnlyTools, failed } = await (this.opts.connectors ?? this.opts.connectorsRemote)!.mcp(slugs, runToken);
      return { value: { apps, readOnlyTools }, detail: { kind: 'action' as const, name: 'connectors', summary: `${apps.join(', ') || 'ninguna'}: ${readOnlyTools.length} tools de lectura${failed.length ? `; sin respuesta: ${failed.join(', ')}` : ''}` } };
    });
  }

  /** Pin del registry por corrida: se abre una vez y el composer y el runner leen el mismo índice. El
   * pin queda en el log, así la corrida es reproducible. Si el store no responde la corrida falla; no hay
   * vuelta al vault. */
  private async withRegistry<T>(log: EventLog, stepId: string, labels: [string, string], fn: () => Promise<{ value: T; paths: string[] }>): Promise<T> {
    log.emit({ type: 'step.start', stepId, kind: 'read', label: labels[0] });
    try {
      const { value, paths } = await fn();
      log.emit({ type: 'step.end', stepId, label: labels[1], status: 'ok', detail: { kind: 'read', paths } });
      return value;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.emit({ type: 'step.end', stepId, label: 'Registry unavailable', status: 'error', error: { type: 'execution-error', message } });
      throw e;
    }
  }

  private parseAttachments(v: unknown): Upload[] {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MAX_ATTACHMENTS) throw new HttpError(400, `attachments debe ser un array de hasta ${MAX_ATTACHMENTS}`);
    return v.map((a) => {
      const url = typeof a === 'object' && a !== null ? (a as { url?: unknown }).url : undefined;
      const hit = typeof url === 'string' ? this.uploads.resolve(url) : null;
      if (!hit) throw new HttpError(400, 'cada attachment debe citar una url de POST /uploads');
      return { url: hit.url, name: hit.name, contentType: hit.contentType, size: hit.size };
    });
  }

  private parseModel(v: unknown): string | undefined {
    if (v !== undefined && typeof v !== 'string') throw new HttpError(400, 'model debe ser string');
    const models = this.opts.models;
    if (!models) return v;
    // 'auto' no es un modelo: el composer lo lee como "sin elegir" y decide el default del server. Viaja como cadena para
    // que reparaciones y reintentos hereden el modo del turno original.
    if (v === AUTO_MODEL) return v;
    if (v === undefined) return models[0]?.id;
    if (!models.some((m) => m.id === v)) throw new HttpError(400, 'model desconocido; ver GET /models');
    return v;
  }

  private parseImageGeneration(v: unknown): { modelId: string } | undefined {
    if (v === undefined) return undefined;
    const modelId = typeof v === 'object' && v !== null ? (v as { modelId?: unknown }).modelId : undefined;
    if (typeof modelId !== 'string' || !(this.opts.imageModels ?? []).some((m) => m.id === modelId)) {
      throw new HttpError(400, `imageGeneration.modelId desconocido; ver GET /image-models`);
    }
    return { modelId };
  }


  /** Instala lo que fija el package.json + lockfile del workspace (run-checks.ts). */
  private async installDeps(...a: Parameters<RunChecks['installDeps']>): Promise<void> {
    return this.checks.installDeps(...a);
  }



  /** De una página ya decidida a una versión: workspace, build, commit y preview (run-close.ts). */
  private async materialize(...a: Parameters<RunClose['materialize']>): ReturnType<RunClose['materialize']> {
    return this.close.materialize(...a);
  }

  /** POST /runs/:id/sections/:slug/suggestions: ideas de una sección solo cuando la persona la elige (síntesis B; Stitch
   * genera las de una pantalla a pedido y no repite mientras carga: stitch-ui/deob/webcrack/DesignPage-DeNbrR8l/
   * deobfuscated.js:8472-8486). Lee la sección del commit de esa versión, no del workspace, que puede ir por otro turno. */
  private async sectionSuggestions(id: string, slug: string): Promise<Suggestion[]> {
    const entry = this.entry(id);
    if (!SECTION_SLUG.test(slug)) throw new HttpError(400, `slug inválido "${slug}"`);
    if (!entry.commit) throw new HttpError(409, `el mensaje ${id} no tiene versión`);
    const hook = (this.opts.compose as Composer & { suggestSection?: SectionSuggestHook }).suggestSection;
    if (!hook) throw new HttpError(503, 'este transport no tiene modelo de sugerencias');
    const key = `${id}:${slug}`;
    const known = this.sectionIdeas.get(key);
    if (Array.isArray(known)) return known;
    if (known) throw new HttpError(409, 'las ideas de esta sección ya se están generando');
    const dir = this.wsDir(entry.ws);
    let source: string;
    try { source = showFile(dir, entry.commit, `src/sections/${slug}.tsx`); } catch { throw new HttpError(404, `la versión no tiene la sección ${slug}`); }
    let lang = 'es';
    try { const doc = JSON.parse(showFile(dir, entry.commit, PAGE_FILE)) as { page?: { lang?: unknown } }; if (typeof doc.page?.lang === 'string') lang = doc.page.lang; } catch { /* sin page.json la sección igual se lee */ }
    const job = hook({ prompt: entry.prompt ?? '', lang, slug, role: slug.slice(3), source });
    this.sectionIdeas.set(key, job);
    try {
      const ideas = await job;
      this.sectionIdeas.set(key, ideas);
      return ideas;
    } catch (e) {
      this.sectionIdeas.delete(key);
      throw new HttpError(502, `sugerencias de ${slug}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.router.handle(req, res);
  }

  listen(port: number, host = '127.0.0.1'): Server {
    return this.router.listen(port, host);
  }
}
