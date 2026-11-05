// Ciclo de corrida (ADR 0014 Enmienda 1, PR 2): cómo nace, corre, se corta y se libera un turno. Runtime conserva el
// ESTADO del ciclo (index, running, live, cancels, finished, late, lateChecks, stopReasons) y su persistencia (save,
// updateEntry); este colaborador lo recibe por referencia o por getter en `deps`. Toda escritura del índice pasa por
// `updateEntry` (regla 3) y se relee después (regla 5). Cómo se cierra un turno vive en run-close.ts y las comprobaciones en
// run-checks.ts; ni este archivo ni run-close se importan entre sí: el cierre llega por callback.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { config } from '../config';
import { join } from 'node:path';
import { openEventLog, readEvents, type EventLog } from './events';
import { commitAll, headSha, isRepo, restoreTree, showFile } from './git-workspace';
import type { VariantRuns } from './variants';
import type { BrandRuns } from './brand-runs';
import type { PreviewPool } from './preview';
import type { EditRuns } from './edit-runs';
import type { AgentMcp } from './agent-mcp';
import { type Allowlist, type PageModel } from './runner';
import { prepareWorkspace } from './workspace';
import { step } from './step';
import { parseElements } from './patch-ai';
import { mountingLog } from './run-cycle-mount';
import { localizeAssets } from './assets';
import { hasRuntimeErrors, previewCheckOf } from './runtime-repair';
import { parseRuntimeContext, runtimeContextBlock } from './runtime-context';
import type { FollowUpHistory, ThreadTurn, Viewport } from './follow-up-context';
import { MAX_HISTORY_TURNS, toolStepsOf, type ToolHistoryTurn } from './tool-history';
import { materializeItems, resolveItems, type RegistrySource } from './registry';
import { writeBrandVariants, type BrandPack } from '../brand';
import { brandSkillParts } from '../brand-skill';
import type { ExtensionPoints } from '../extension-points';
import type { ConnectorMcp } from './connector-mcp';
import { briefKey, installFailedNote, RUNS_DISABLED } from './run-cycle-text';
import { HttpError } from './http';
import { LOCAL_OWNER, owns, scopeDenied, STRONG_MESSAGE_ID, type Session } from './session';
import { createInfer } from './infer';
import { foldThread, THREAD_KEEP } from './thread-fold';
import { planLiterals, quotedLiterals, type Pin } from './pinned';
import { type RuntimeOptions, isIanaZone, isRepairEntry, lastSessionId, MESSAGE_ID, PAGE_FILE, parseInstructions, stepAsync, titleOf, type AutoRepairKind, type LiveTurn, type MessageEntry, type RunInput, type ComposeRequest } from './shared';
import { detectBrand, localBrandIds } from '../brand-detect';
import { briefTags } from '../brief-tags';
import { writeWaSdk } from '../wa-sdk';
import { planPathFor } from './plan-exit';
import { planBuildPrompt } from './agent-prompt';
import { AGENT_SKILL_DIR } from '../skill-registry';
import { placeAttachments, type UploadStore, type Upload } from './uploads';
import { buildFailedPrompt, createSteer } from './agent-loop';
import type { BrandStore } from './brand-store';
import { parseBrand, parseConnectors, parsePermissionMode, parseSelectedSections, parseThinking, parseTools, parseViewport } from './run-input';
import type { RunReads } from './run-reads';
import { dsSkillOf, openPinned, requestRecord, type RequestKey, type RunChecks, SUPERSEDED } from './run-checks';
import type { RunClose } from './run-close';

// El composer del builder corta en 4000; 20 mensajes por turno sobra para corregir el rumbo sin inundar el stdin.
const MAX_STEER_CHARS = 4000;
const MAX_STEERS = 20;

export interface RunCycleDeps {
  readonly opts: RuntimeOptions;
  readonly logDir: string;
  /** El índice se lee siempre por aquí y se escribe solo con `updateEntry` (ADR 0014 regla 3). */
  readonly index: Readonly<Record<string, Readonly<MessageEntry>>>;
  readonly closing: boolean;
  readonly maxRunning: number;
  readonly directions: Record<string, string[]>;
  readonly port: number | undefined;
  running: Set<string>;
  finished: Set<string>;
  late: Map<string, Promise<unknown>>;
  lateChecks: Map<string, AbortController>;
  cancels: Map<string, AbortController>;
  stopReasons: Map<string, string>;
  live: Map<string, LiveTurn>;
  imageUse: Map<string, { attempts: number; made: number; inFlight: number }>;
  allowByPin: Map<string, Allowlist>;
  agentMcp: AgentMcp;
  brandRuns: BrandRuns;
  brands: BrandStore;
  edits: EditRuns;
  reads: RunReads;
  uploads: UploadStore;
  variants: VariantRuns;
  updateEntry: (id: string, patch: Partial<MessageEntry>) => void;
  entry: (id: string) => Readonly<MessageEntry>;
  wsDir: (ws: string) => string;
  pinsAt: (parentId: string, dictated: { messageId: string; literals: string[] }[]) => Pin[];
  agentAt: (id: string) => { summary?: string; files?: string[] } | undefined;
  allowAt: (pin: string) => Promise<Allowlist>;
  brandOf: (ws: string, commit: string) => string | undefined;
  pinOf: (dir: string, commit: string) => string | undefined;
  requestField: (dir: string, commit: string, key: RequestKey) => string | undefined;
  connectApps: (slugs: readonly string[], log: EventLog, runToken?: string) => Promise<ConnectorMcp>;
  withRegistry: <T>(log: EventLog, stepId: string, labels: [string, string], fn: () => Promise<{ value: T; paths: string[] }>) => Promise<T>;
  parseAttachments: (v: unknown) => Upload[];
  parseModel: (v: unknown) => string | undefined;
  parseImageGeneration: (v: unknown) => { modelId: string } | undefined;
  rememberDirection: (key: string, id: string) => void;
  /** Los cierres llegan por callback con enlace tardío (`(...a) => this.end(...a)`): ADR 0014 6.9, el test parchea `end`. */
  end: (...a: Parameters<RunClose['end']>) => void;
  keepPlan: (...a: Parameters<RunClose['keepPlan']>) => undefined;
  keepStopped: (...a: Parameters<RunClose['keepStopped']>) => undefined;
  materialize: (...a: Parameters<RunClose['materialize']>) => ReturnType<RunClose['materialize']>;
  untouched: (messageId: string, dir: string) => boolean;
  installDeps: (...a: Parameters<RunChecks['installDeps']>) => Promise<void>;
}

export class RunCycle {
  constructor(private deps: RunCycleDeps) {}

  /** Token de la última corrida lanzada por mensaje (condición 5). `runCounter` es global y monótono: con un contador por id
   * que vuelve a empezar, un settle viejo que capturó 1 coincidiría con una tercera corrida que recibe 1. Se limpia solo en
   * el finally de settle, y solo si sigue siendo el vigente; release no lo toca. */
  private runSeq = new Map<string, number>();
  private runCounter = 0;

  /** El hilo hasta el padre: cada pedido de la persona con el resumen de su versión, y los pasos del agente en el turno
   * del padre leídos de su log. Restores y ediciones directas no tienen pedido y no entran. */
  private historyOf(parentId: string, viewport?: Viewport): FollowUpHistory {
    const thread: ThreadTurn[] = [];
    const dictated: { messageId: string; literals: string[] }[] = [];
    const seen = new Set<string>();
    for (let id: string | undefined = parentId; id && !seen.has(id) && this.deps.index[id]; id = this.deps.index[id].parentId) {
      seen.add(id);
      const { prompt, plan, ws } = this.deps.index[id];
      if (!prompt) continue;
      const summary = this.deps.agentAt(id)?.summary;
      thread.unshift({ messageId: id, prompt, ...(summary ? { summary } : {}) });
      // Antes del plegado (H18): un pedido viejo resumido sigue fijando lo que dictó.
      const planFile = plan?.status === 'approved' ? join(this.deps.wsDir(ws), plan.path) : undefined;
      const fromPlan = planFile && existsSync(planFile) ? planLiterals(readFileSync(planFile, 'utf8')) : [];
      dictated.unshift({ messageId: id, literals: [...quotedLiterals(prompt), ...fromPlan] });
    }
    const pinned = dictated.some((d) => d.literals.length) ? this.deps.pinsAt(parentId, dictated) : [];
    const tools = toolStepsOf(readEvents(this.deps.logDir, parentId).events);
    const parent = this.deps.agentAt(parentId);
    const previewCheck = previewCheckOf(readEvents(this.deps.logDir, parentId).events);
    return { thread, tools, toolHistory: this.toolHistoryOf(thread), lastFiles: parent?.files ?? [], ...(parent?.summary ? { lastSummary: parent.summary } : {}), ...(previewCheck ? { previewCheck } : {}), ...(viewport ? { viewport } : {}), ...(pinned.length ? { pinned } : {}) };
  }

  /** Los pasos de cada turno del hilo (los últimos MAX_HISTORY_TURNS), leídos de sus logs: la memoria de tools de v0. */
  private toolHistoryOf(thread: readonly ThreadTurn[]): ToolHistoryTurn[] {
    return thread.slice(-MAX_HISTORY_TURNS).map((t) => ({ messageId: t.messageId, prompt: t.prompt, tools: toolStepsOf(readEvents(this.deps.logDir, t.messageId).events) }));
  }

  /** historyOf con el hilo plegado a los últimos THREAD_KEEP turnos (H18); los viejos entran como un resumen. */
  private async foldedHistory(parentId: string, viewport: Viewport | undefined, signal?: AbortSignal): Promise<FollowUpHistory> {
    const h = this.historyOf(parentId, viewport);
    if (h.thread.length <= THREAD_KEEP) return h;
    const infer = this.deps.opts.threadSummary ?? createInfer({ model: process.env.WT_THREAD_SUMMARY_MODEL ?? 'haiku' });
    const { thread, folded } = await foldThread(h.thread, infer, signal);
    return { ...h, thread, ...(folded ? { folded } : {}) };
  }

  claim(ws: string): void {
    this.supersede(ws);
    this.deps.running.add(ws);
  }

  supersede(ws: string): void {
    this.deps.lateChecks.get(ws)?.abort(SUPERSEDED);
    this.deps.lateChecks.delete(ws);
  }

  /** Cierre único de toda corrida (contrato con el builder, ola 1): espera los pasos tardíos y emite settled. El writer se
   * abre recién aquí, con los demás ya cerrados: dos writers del mismo log repetirían seq. */
  async settle(messageId: string): Promise<void> {
    // Síncrono y antes de cualquier await: todos los llamadores invocan settle sin esperar, así que esto es el token de la
    // corrida que lo pidió. Las corridas sin launch (edit-runs, brand-runs) dan undefined === undefined.
    const mine = this.runSeq.get(messageId);
    const pending = this.deps.late.get(messageId);
    await pending?.catch(() => undefined);
    // Solo la espera propia: si el mensaje volvió a correr (build de un plan aprobado) y ya registró sus pasos tardíos, son de esa corrida.
    if (this.deps.late.get(messageId) === pending) this.deps.late.delete(messageId);
    // El mensaje volvió a correr mientras este cierre esperaba (ADR 0014 condición 5): terminado y settled los pone el cierre de
    // esa corrida. Si no, el stream se corta en pleno build. Va antes del try/finally para que finished.add, settled y el
    // auto-repair no corran para el cierre viejo.
    if (this.runSeq.get(messageId) !== mine) return;
    let auto: { childId: string; kind: AutoRepairKind } | undefined;
    try {
      auto = this.autoRepairAfter(messageId);
    } catch (e) {
      // Un auto-repair que no arranca (modelo fuera del catálogo, cupo) deja la versión como estaba: el botón manual sigue.
      console.error(`[transport] auto-repair ${messageId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const log = openEventLog(this.deps.logDir, messageId);
      // Antes de settled: el builder solo sigue el stream que lanzó, y aquí aprende el id del hijo para engancharse a él.
      if (auto) {
        const label = auto.kind === 'runtime' ? 'Arreglando errores de runtime' : 'Arreglando secciones';
        log.emit({ type: 'step.start', stepId: 'transport:autofix', kind: 'action', label });
        log.emit({ type: 'step.end', stepId: 'transport:autofix', label, status: 'ok', detail: { kind: 'action', name: 'auto-repair', summary: auto.childId, childId: auto.childId, autoRepair: auto.kind } });
      }
      log.emit({ type: 'settled' });
    } catch (e) {
      // Se llama sin await desde cada cierre: un rechazo aquí es un unhandledRejection, que scripts/serve.ts:183 convierte
      // en exit 1 del servidor de todos los chats (auditoría #1). Un log que no se puede escribir (disco lleno, EMFILE) se
      // reporta y el mensaje igual queda terminado para el stream.
      console.error(`[transport] settle ${messageId}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.deps.finished.add(messageId);
      if (this.runSeq.get(messageId) === mine) this.runSeq.delete(messageId);
    }
  }

  // HACK: tope fijo de un auto-repair por versión y ninguno sobre un arreglo (ningún referente publica el suyo; figma-make
  // no verificado). Pasar a N intentos con backoff si la tasa de arreglos que siguen rojos tras el primero lo pide.
  /** Tras cerrar una versión: si su preview-check vio errores de runtime, lanza el arreglo como mensaje hijo sin esperar
   * el clic. Lo que no cumple las guardas queda para el botón manual. */
  private autoRepairAfter(parentId: string): { childId: string; kind: AutoRepairKind } | undefined {
    const e = this.deps.index[parentId];
    if (this.deps.opts.autoRepair === false || this.deps.closing || this.deps.opts.runsDisabled || !e?.commit) return undefined;
    // Detenida, caída, pregunta, variante o corrida sin agente (patch, edición directa, restore): no hay turno que arreglar.
    if (e.outcome !== 'ok' || e.interrupted || e.asked !== undefined || e.variantOf || e.kind || isRepairEntry(e) || e.autoRepaired) return undefined;
    // Fase build de un plan (plan-mode.md): la persona aprobó ese plan; un arreglo automático sería otro cambio y otro gasto
    // que no aprobó. Queda el arreglo manual.
    if (e.plan) return undefined;
    if (this.deps.running.has(e.ws) || this.deps.running.size >= this.deps.maxRunning) return undefined;
    const body = { parentId, auto: true, ...(e.model ? { model: e.model } : {}) };
    const check = this.deps.opts.agent ? previewCheckOf(readEvents(this.deps.logDir, parentId).events) : undefined;
    if (check && hasRuntimeErrors(check, [])) return { childId: this.deps.edits.startRuntimeRepair(body).messageId, kind: 'runtime' };
    return undefined;
  }

  /** Trabajo de fondo de una corrida (sin await desde un handler HTTP): su rechazo se reporta y no llega al
   * unhandledRejection que tumba el proceso (scripts/serve.ts:183; auditoría #1-#3). */
  background(what: string, messageId: string, work: Promise<unknown>): void {
    void work.catch((e: unknown) => console.error(`[transport] ${what} ${messageId}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
  }

  /** Un id del cuerpo (parentId, restoreFrom, variants.sourceId) de un chat ajeno se ve igual que uno inexistente (spec §5). */
  private assertOwns(session: Session, id: unknown): void {
    if (id === undefined) return;
    // Los handlers coaccionan con String(): un arreglo ['x'] llegaba a 'x' sin pasar por este chequeo (security-reviewer C1).
    if (typeof id !== 'string') throw new HttpError(400, 'el id debe ser un string');
    if (!Object.hasOwn(this.deps.index, id)) return;
    if (!owns(session, this.deps.index[id] as Readonly<MessageEntry>)) throw new HttpError(404, `no hay mensaje ${id}`);
  }

  /** POST /runs: registra el mensaje y arranca el job sin esperarlo. `session` ausente = llamada interna del propio runtime
   * (la aprobación de un plan lanza un turno en nombre del chat): el hijo hereda el dueño del padre en updateEntry. Desde HTTP
   * el router siempre la pasa. */
  async start(body: unknown, session?: Session, runToken?: string): Promise<{ messageId: string; queued?: true } | ReturnType<VariantRuns['start']>> {
    if (this.deps.closing) throw new HttpError(503, 'el transport se está cerrando');
    if (this.deps.opts.runsDisabled) throw new HttpError(503, RUNS_DISABLED);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    // Con identidad real, el id que elige el cliente no puede ser corto: el 409 de "ya existe" confirmaría ids ajenos como
    // `my-page` y permitiría ocuparlos. Con el dueño implícito 'local' no hay a quién esconder el 409 y los ids cortos siguen.
    if (session && session.owner !== LOCAL_OWNER && b.messageId !== undefined && !(typeof b.messageId === 'string' && STRONG_MESSAGE_ID.test(b.messageId))) throw new HttpError(400, 'messageId debe tener al menos 128 bits: un uuid o 26+ caracteres [a-z0-9-] aleatorios');
    // Antes de cualquier rama: todas las operaciones (restore, parche, variantes, continuar…) cuelgan de uno de estos ids.
    if (session) for (const id of [b.parentId, b.restoreFrom, (b.variants as { sourceId?: unknown } | undefined)?.sourceId]) this.assertOwns(session, id);
    // Después del dueño (spec §5): un parentId ajeno es 404 aunque la sesión no tenga spend.
    // Generar imágenes gasta créditos (spec §7): el cuerpo se lee aquí, no en el router, y cubre el turno normal y las variantes.
    if (session && b.imageGeneration !== undefined && !session.scopes.has('spend')) throw scopeDenied();
    // Modo plan (H6): flag por turno, validado antes del dispatch para que una combinación prohibida sea 400 y no caiga
    // por otra rama (variantes, continue, parche…).
    const planRequested = this.parsePlanMode(b);
    if (b.restoreFrom !== undefined) return this.deps.edits.startRestore(b);
    if (b.updateDs !== undefined) return this.deps.brandRuns.startUpdateDs(b);
    if (b.applyBrand !== undefined) return this.deps.brandRuns.startApplyBrand(b);
    if (b.applyTheme !== undefined) return this.deps.brandRuns.startApplyTheme(b);
    if (b.textEdit !== undefined || b.deleteElement !== undefined || b.replaceImage !== undefined || b.sectionOp !== undefined) return this.deps.edits.startDirectEdit(b);
    if (b.repair === 'runtime') return this.deps.edits.startRuntimeRepair(b);
    if (b.repair === 'render') throw new HttpError(400, 'el arreglo por render se retiró (C5): la edición por parche o con IA lo reemplaza');
    // Sin este rechazo un {patch} con prompt cae al turno con modelo: gasta y descarta el parche en silencio.
    if (b.patch !== undefined) throw new HttpError(400, 'la edición por {patch} se retiró (C5): usa textEdit/deleteElement/sectionOp o Editar con IA');
    if (b.variants !== undefined) return this.deps.variants.start(b);
    if (b.continue === true) return this.deps.edits.startContinue(b);
    if (typeof b.prompt !== 'string' || !b.prompt.trim()) throw new HttpError(400, 'falta prompt');
    const model = this.deps.parseModel(b.model);
    const instructions = parseInstructions(b.instructions);
    const attachments = this.deps.parseAttachments(b.attachments);
    const imageGeneration = this.deps.parseImageGeneration(b.imageGeneration);
    const thinking = parseThinking(b.thinking);
    const timezone = b.timezone === undefined ? undefined : String(b.timezone);
    if (timezone !== undefined && !isIanaZone(timezone)) throw new HttpError(400, `timezone inválida "${timezone}": debe ser una zona IANA (p. ej. America/Mexico_City)`);
    const tools = parseTools(b.tools);
    const connectors = parseConnectors(b.connectors);
    const selectedSections = parseSelectedSections(b.selectedSections);
    const viewport = parseViewport(b.viewport);
    const brand = parseBrand(b.brand);
    const permissionMode = parsePermissionMode(b.permissionMode);
    // Contexto de runtime del preview (H10): dato no confiable del navegador, solo en un turno con modelo. Va al prompt
    // que ve el modelo, NO al prompt guardado ni al título: así no se replica en continue/resume ni ensucia lo que se ve.
    let runtimeContext: ReturnType<typeof parseRuntimeContext>;
    try { runtimeContext = parseRuntimeContext(b.runtimeContext); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
    const messageId = b.messageId === undefined ? crypto.randomUUID().replaceAll('-', '') : String(b.messageId);
    if (!MESSAGE_ID.test(messageId)) throw new HttpError(400, `messageId inválido "${messageId}"`);
    if (Object.hasOwn(this.deps.index, messageId)) throw new HttpError(409, `el mensaje ${messageId} ya existe`);
    const parentId = b.parentId === undefined ? undefined : String(b.parentId);
    const parent = parentId ? this.deps.entry(parentId) : undefined;
    // Antes del chequeo de versión: el padre puede ser el mismo turno vivo, que todavía no tiene commit.
    const live = parent ? this.deps.live.get(parent.ws) : undefined;
    if (live) {
      const steered = this.steerLive(live, b.prompt, attachments.length > 0, selectedSections);
      if (timezone) this.deps.updateEntry(live.messageId, { timezone });
      return steered;
    }
    // §5: un mensaje nuevo con el plan del padre pendiente (su turno de plan ya terminó) lo cancela y arranca iterando
    // sobre la misma sesión del CLI. El padre es el mensaje del plan, que no tiene versión: se admite como parentId porque
    // el turno nuevo reanuda su sesión, no restaura su árbol. Sin mode explícito, el turno nuevo sale también en plan.
    const iterPlan = parent?.plan && parent.plan.status === 'pending' ? parent.plan : undefined;
    if (iterPlan) this.deps.agentMcp.cancelPlan(parentId as string, parent as Readonly<MessageEntry>, 'user-message');
    // El builder marca el mensaje en vuelo: si el turno cerró entre su envío y este POST, abrir una corrida que el builder
    // no sigue sería peor que el 409; el builder lo reenvía como mensaje nuevo.
    if (b.steer === true) throw new HttpError(409, 'el turno en curso ya no recibe mensajes: envíalo cuando termine');
    if (parent && !parent.commit && !iterPlan) throw new HttpError(409, `el mensaje padre ${parentId} no tiene versión`);
    // El follow-up conserva la identidad de la versión (keepIdentity): con otra marca cambiaría logo y page.brand sobre los
    // tokens viejos, una página con dos marcas. Cambiar de marca es otra operación, no un turno.
    if (brand && parent?.commit && brand !== this.deps.brandOf(parent.ws, parent.commit)) throw new HttpError(409, `la versión ${parentId} no es de la marca "${brand}": un follow-up no cambia de marca`);
    const ws = parent ? parent.ws : messageId;
    // Una sesión acotada a chats (VM bajo el orquestador) no abre otro: gastaría y escribiría en un chat que luego owns() oculta.
    // Mismo 404 que uno ajeno; sin `chats` (local) no cambia.
    if (session?.chats && !session.chats.has(ws)) throw new HttpError(404, `no hay mensaje ${parentId ?? messageId}`);
    // Un chat de otro DS (uno de Arc en el core tras #852) sigue en su pin: si este proceso no lo tiene, 409 antes de abrir la
    // corrida, como updateDs, y no un turno que muere con "falta index@<pin>" (QA B9 paso 4).
    if (parent?.commit && this.deps.opts.registry) {
      const dir = this.deps.wsDir(ws);
      const pin = this.deps.pinOf(dir, parent.commit);
      const skill = dsSkillOf(pin, this.deps.requestField(dir, parent.commit, 'dsSkill'));
      if (skill && skill !== config().agentSkillId) await openPinned(this.deps.opts.registry, pin, skill);
    }
    if (this.deps.running.has(ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso');
    if (this.deps.running.size >= this.deps.maxRunning) throw new HttpError(429, `ya hay ${this.deps.maxRunning} corridas en curso`);
    // Por chat: sin modo en la petición sigue el del mensaje padre, y sin padre 'ask'.
    const mode = permissionMode ?? parent?.permissionMode ?? 'ask';
    // H5: un pedido sobre elementos con origen en el código, sin adjuntos, imagen generada, conectores ni búsqueda,
    // prueba primero la vía de parche; lo demás es el turno de siempre. La decisión fina la toma el infer (route full).
    const elements = parent?.commit && !attachments.length && !imageGeneration && !connectors?.length && !tools?.webSearch ? parseElements(b.elements) : undefined;
    // Iterar un plan hereda el modo plan aunque el cuerpo no lo pida; el plan explícito en página nueva o follow-up normal
    // también. Un follow-up corriente (sin iterar) no es plan salvo que lo pida.
    const planTurn = planRequested || Boolean(iterPlan);
    this.deps.updateEntry(messageId, { ws, ...(session && session.owner !== LOCAL_OWNER ? { owner: session.owner } : {}), ...(parentId ? { parentId } : {}), title: titleOf(b.prompt), prompt: b.prompt, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(timezone ? { timezone } : {}), at: Date.now(), permissionMode: mode, ...(planTurn ? { mode: 'plan' as const } : {}), ...(planTurn && viewport ? { viewport } : {}), ...(elements ? { kind: 'direct-edit' as const } : {}) });
    this.claim(ws);
    // Iterar reanuda la sesión del plan cancelado y avisa al agente de que el plan anterior no se aplicó.
    const promptBase = iterPlan ? `El plan anterior no se aplicó; ajústalo con este mensaje.\n\n${b.prompt}` : b.prompt;
    const promptForModel = runtimeContext ? `${promptBase}\n\n${runtimeContextBlock(runtimeContext)}` : promptBase;
    const input: RunInput = { prompt: promptForModel, attachments, ...(runToken ? { runToken } : {}), ...(model ? { model } : {}), ...(instructions ? { instructions } : {}), ...(imageGeneration ? { imageGeneration } : {}), ...(thinking ? { thinking } : {}), ...(tools ? { tools } : {}), ...(connectors?.length ? { connectors } : {}), ...(selectedSections?.length ? { selectedSections } : {}), ...(viewport ? { viewport } : {}), ...(brand ? { brand } : {}), ...(iterPlan?.sessionId ? { resume: iterPlan.sessionId } : {}), ...(planTurn ? { plan: { mode: 'plan' as const } } : {}) };
    if (elements && parent?.commit) this.background('patch-ai', messageId, this.deps.edits.runPatchAi(messageId, ws, parent.commit, input, elements));
    else this.launch(messageId, ws, input);
    return { messageId };
  }

  /** Valida `mode` de POST /runs y que no se combine con otra operación. Devuelve true si el turno es de plan. */
  private parsePlanMode(b: Record<string, unknown>): boolean {
    if (b.mode === undefined || b.mode === 'build') return false;
    if (b.mode !== 'plan') throw new HttpError(400, "mode debe ser 'plan' o 'build'");
    if (!this.deps.opts.agent) throw new HttpError(400, 'el modo plan necesita el agente (--agent)');
    if (this.deps.port === undefined) throw new HttpError(400, 'el modo plan necesita el endpoint de aprobación');
    const combo = ['variants', 'restoreFrom', 'patch', 'applyBrand', 'applyTheme', 'updateDs', 'textEdit', 'deleteElement', 'replaceImage', 'sectionOp', 'repair', 'elements'].find((k) => b[k] !== undefined) ?? (b.continue === true ? 'continue' : b.runtimeRepair !== undefined ? 'runtimeRepair' : undefined);
    if (combo) throw new HttpError(400, `el modo plan no se combina con ${combo}`);
    return true;
  }

  /** Corre el mensaje. */
  launch(messageId: string, ws: string, input: RunInput): void {
    this.runSeq.set(messageId, ++this.runCounter);
    this.deps.cancels.set(messageId, new AbortController());
    // La liberación del workspace, settle y la cola van en finally: antes, un throw dentro del handler de éxito (índice
    // ausente, save() sin disco) se saltaba todo eso y además rechazaba sin catch (auditoría #2).
    this.background('run', messageId, this.run(messageId, input).finally(() => this.release(messageId, ws)));
  }

  /** Cierre de toda corrida lanzada: suelta el workspace, emite settled y deja pasar la cola. No lanza (settle no rechaza y
   * pumpVariants se reporta aparte): corre dentro de un finally sin nadie que espere su promesa. */
  release(messageId: string, ws: string): void {
    this.deps.cancels.delete(messageId);
    this.deps.imageUse.delete(messageId);
    this.deps.running.delete(ws);
    void this.settle(messageId);
    try {
      this.deps.variants.pumpVariants();
    } catch (e) {
      console.error(`[transport] cola de variantes tras ${messageId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Mensaje con el turno en curso, como el chat en vuelo de Lovable: entra a ese turno y queda en su log, no abre otro
   * mensaje ni otra versión. Sin turno que lo lea (el composer no es el agente, o el CLI ya dio su último resultado) es 409. */
  private steerLive(live: LiveTurn, text: string, attachments: boolean, selectedSections?: string[]): { messageId: string; queued: true } {
    // Un adjunto necesita copiarse al workspace antes del turno: con el turno ya corriendo no hay dónde ponerlo.
    if (attachments) throw new HttpError(400, 'un mensaje con el turno en curso lleva solo texto; los adjuntos van en el próximo');
    if (text.length > MAX_STEER_CHARS) throw new HttpError(400, `un mensaje con el turno en curso tiene hasta ${MAX_STEER_CHARS} caracteres`);
    // Cada uno queda en el stdin del CLI y en el log: sin tope, un cliente desbocado llena memoria y disco hasta que el turno cierra.
    if (live.steers >= MAX_STEERS) throw new HttpError(429, `ya van ${MAX_STEERS} mensajes en este turno: espera a que termine`);
    if (!live.steer.send(text)) throw new HttpError(409, 'el turno en curso ya no recibe mensajes: envíalo cuando termine');
    live.steers += 1;
    live.log.emit({ type: 'steer', text, ...(selectedSections?.length ? { selectedSections } : {}) });
    return { messageId: live.messageId, queued: true };
  }

  /** POST /runs/:id/cancel: corta la corrida de ese mensaje. Lo escrito hasta ahí queda como versión (keepStopped);
   * restore, patch y ediciones directas no pasan por aquí porque no tienen nada que cortar. */
  cancel(id: string): { messageId: string } {
    const entry = this.deps.entry(id);
    if (this.deps.variants.cancelQueued(id)) return { messageId: id };
    const run = this.deps.cancels.get(id);
    if (!run) {
      // Sin corrida viva, un plan pendiente sí se puede cancelar (§8): el turno de plan ya cerró, el pendiente vive en el índice.
      if (entry.plan?.status === 'pending') { this.deps.agentMcp.cancelPlan(id, entry, 'stopped'); return { messageId: id }; }
      throw new HttpError(409, `el mensaje ${id} no tiene una corrida en curso`);
    }
    this.deps.stopReasons.set(id, `POST /runs/${id}/cancel`);
    run.abort();
    return { messageId: id };
  }

  /** Precondiciones de la fase build, sin efectos: lo que decidePlan comprueba antes de registrar el allow, para no
   * anunciar una decisión que no va a arrancar nada. resumePlanBuild las vuelve a exigir (defensa). */
  assertCanBuildPlan(id: string): void {
    const entry = this.deps.index[id];
    const plan = entry?.plan;
    if (!plan) throw new HttpError(409, `el mensaje ${id} no tiene plan`, { code: 'plan-missing' });
    if (!plan.sessionId) throw new HttpError(409, `el plan de ${id} no tiene sesión que reanudar`, { code: 'plan-no-session' });
    // El code distingue el único 409 que se resuelve esperando: los demás no cambian al reintentar y el builder no debe pedirlo.
    if (this.deps.running.has(entry.ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso', { code: 'workspace-busy' });
    if (this.deps.running.size >= this.deps.maxRunning) throw new HttpError(429, `ya hay ${this.deps.maxRunning} corridas en curso`);
  }

  /** Fase build (§Fase build): otra corrida sobre el MISMO mensaje, reanudando la sesión del plan con las tools completas.
   * Esta sí crea la versión. */
  resumePlanBuild(id: string, edited: boolean, fresh?: Viewport): void {
    this.assertCanBuildPlan(id);
    const entry = this.deps.index[id];
    const plan = entry.plan as NonNullable<MessageEntry['plan']>;
    const ws = entry.ws;
    this.deps.updateEntry(id, { plan: { ...plan, status: 'approved' } });
    // Regla 5: updateEntry reemplazó el objeto; lo que sigue lee el vigente.
    const now = this.deps.index[id];
    // El de la aprobación gana: la persona pudo cambiar de ancho mientras leía el plan.
    const viewport = fresh ?? now.viewport;
    const input: RunInput = { prompt: planBuildPrompt(plan.path, edited), attachments: [], resume: plan.sessionId, plan: { mode: 'build', path: plan.path, edited }, ...(now.model ? { model: now.model } : {}), ...(viewport ? { viewport } : {}) };
    this.claim(ws);
    // El settle del turno de plan lo marcó terminado y stream() corta el SSE en cuanto isFinished: el build es otra corrida.
    this.deps.finished.delete(id);
    this.launch(id, ws, input);
  }

  private async run(messageId: string, input: RunInput): Promise<void> {
    const { ws, parentId } = this.deps.index[messageId];
    const dir = this.deps.wsDir(ws);
    const log = openEventLog(this.deps.logDir, messageId);
    log.emit({ type: 'message.start', ...(parentId ? { parentId } : {}) });
    if (input.variant) log.emit({ type: 'variant', ...input.variant });
    // Modo plan (H6): un turno de plan abre con plan.start; la fase build de un plan aprobado, con plan.resumed en el
    // mismo log, para que el builder la siga desde el cursor en el que quedó.
    if (input.plan?.mode === 'plan') log.emit({ type: 'plan.start', path: planPathFor(messageId) });
    else if (input.plan?.mode === 'build') { const p = this.deps.index[messageId].plan; if (p) log.emit({ type: 'plan.resumed', callId: p.callId, edited: input.plan.edited }); }
    try {
      let parentPage: PageModel | undefined;
      let parentPin: string | undefined;
      let parentFacts: string | undefined;
      let parentSkill: string | undefined;
      let inherited: string[] = [];
      // Un parentId sin commit es el mensaje de un plan (iterar, §5): no hay árbol que restaurar; el turno reanuda su
      // sesión del CLI y vuelve a planear sobre el workspace tal cual.
      if (parentId && this.deps.index[parentId].commit) {
        const commit = this.deps.index[parentId].commit as string;
        // Construir sobre un mensaje viejo es volver a su versión: el árbol vuelve a su commit y el
        // nuevo commit cuelga de HEAD, sin reescribir historia. Con HEAD ya en el padre también se limpia, sin paso visible:
        // lo que dejó una corrida fallida no entra a este turno (R2.1; nosotros.md §7.7).
        if (headSha(dir) !== commit) {
          step(log, 'transport:restore', 'action', ['Restoring version', 'Restored version'], () => {
            restoreTree(dir, commit);
            return { value: undefined, detail: { kind: 'action', name: 'restore', summary: commit } };
          });
        } else restoreTree(dir, commit);
        parentPage = JSON.parse(showFile(dir, commit, PAGE_FILE)) as PageModel;
        inherited = this.deps.reads.instructionsAt(dir, commit);
        // Como v0 monta el DS en un <ref> fijo: la página sigue en el índice de su versión padre.
        parentPin = this.deps.pinOf(dir, commit);
        parentFacts = this.deps.requestField(dir, commit, 'factsVersion');
        // El DS va con el pin: un chat de Arc sigue con arc-agent aunque el default del core ya sea otro.
        parentSkill = dsSkillOf(parentPin, this.deps.requestField(dir, commit, 'dsSkill'));
      }
      const instructions = input.instructions ?? inherited;
      // La marca de la página manda sobre la del proceso (--brand / WT_BRAND_PACK), que queda como fallback local.
      const askedBrand = input.brand ?? (typeof parentPage?.page?.brand === 'string' ? parentPage.page.brand : undefined);
      // Antes de copiar los adjuntos: en el primer mensaje prepareWorkspace vacía el directorio y se los llevaba.
      prepareWorkspace(dir, { ...this.deps.opts, ...(askedBrand ? { brandDir: undefined } : {}), log });
      const attachments = input.attachments.length ? placeAttachments(this.deps.uploads, input.attachments, dir, messageId) : [];
      const open = this.deps.opts.registry;
      const registry = open
        ? await this.deps.withRegistry(log, 'transport:registry-open', ['Opening registry', 'Opened registry'], async () => {
            const source = await openPinned(open, parentPin, parentSkill);
            return { value: source, paths: [`index@${source.pin}.json`] };
          })
        : undefined;
      // El composer elige del índice publicado, no del skill local: validar solo contra el skill
      // rechazaría al escribir un bloque que el índice ya trae y el skill todavía no.
      if (registry?.loadIndex && !this.deps.allowByPin.has(registry.pin)) this.deps.allowByPin.set(registry.pin, await registry.loadIndex());
      // Página nueva sin marca pedida: si el brief nombra un pack publicado ("Acme (acme.com)"), va con ese pack y no
      // con identidad efímera. Un follow-up nunca cambia de marca por el texto.
      const detected = !askedBrand && !parentPage ? detectBrand(input.prompt, registry?.brandIds ? registry.brandIds() : localBrandIds(this.deps.brands.root())) : undefined;
      const brandId = askedBrand ?? detected;
      const points = registry?.extensionPoints ? await registry.extensionPoints() : undefined;
      const applied = brandId ? await this.deps.brandRuns.applyPageBrand(brandId, this.deps.index[messageId]?.owner ?? LOCAL_OWNER, dir, log, registry, points, Boolean(detected), Boolean(parentPage)) : undefined;
      const facts = applied ? await this.deps.brandRuns.liveFacts(applied.brand, dir, log, parentFacts) : undefined;
      // La marca y sus hechos son del transport, no del agente: en página nueva van en un commit base, como hace el runner
      // con la marca del proceso (runner.ts). Sin él identity.css salía como editado y cada typecheck pedía "restaurar" la
      // marca del pack (traza 5b97a973, 9 de 9 typechecks).
      if (applied && !parentPage && isRepo(dir)) commitAll(dir, `base: scaffold + marca ${applied.pack.name}`);
      const brand = facts?.brand;
      const { appearance: _appearance, ...brandSkill } = applied ? brandSkillParts(applied.pack) : { appearance: undefined };
      // Dirección (catálogo, spec §5) solo en página nueva: la elige el composer con esta entrada, fuera del modelo, y sin
      // repetir las últimas de la misma marca o del mismo brief. Un follow-up conserva la del plan.
      const directionKey = parentPage ? undefined : brand ? `brand:${brand.id}` : `brief:${briefKey(input.prompt)}`;
      const direction = directionKey ? { seed: messageId, ...briefTags(input.prompt), recent: this.deps.directions[directionKey] ?? [], ...(brand?.styleSet ? { styleSet: brand.styleSet } : {}) } : undefined;
      // Apps conectadas → servidores MCP del agente, solo los slugs del request; las credenciales no pasan por el log.
      const connectorMcp = input.connectors?.length && (this.deps.opts.connectors ?? this.deps.opts.connectorsRemote) ? await this.deps.connectApps(input.connectors, log, input.runToken) : undefined;
      // Agente (ADR 0011): como v0 monta el DS completo, todo el índice del pin va al workspace antes del turno, y el
      // preview arranca antes para que la tool browser mire la página mientras se escribe.
      const workspace = this.deps.opts.agent ? await this.agentWorkspace(dir, log, registry, points, applied?.pack, this.deps.cancels.get(messageId)?.signal, { tolerateInstall: true, ...(parentSkill ? { skill: parentSkill } : {}) }) : undefined;
      const history = parentId && this.deps.opts.agent ? await this.foldedHistory(parentId, input.viewport, this.deps.cancels.get(messageId)?.signal) : undefined;
      const req: ComposeRequest = {
        prompt: workspace?.installError ? `${input.prompt}\n\n${installFailedNote(workspace.installError)}` : input.prompt,
        messageId,
        ...(input.runToken ? { runToken: input.runToken } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(parentId ? { parentId } : {}),
        ...(history ? { history } : {}),
        ...(parentPage ? { parentPage } : {}),
        ...(instructions.length ? { instructions } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(input.imageGeneration ? { imageGeneration: input.imageGeneration } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(registry ? { registry } : {}),
        ...(input.connectors ? { connectors: input.connectors } : {}),
        ...(input.selectedSections ? { selectedSections: input.selectedSections } : {}),
        ...(input.resume ? { resume: input.resume } : {}),
        ...(brand ? { brand } : {}),
        ...(applied ? { brandSkill } : {}),
        ...(direction ? { direction } : {}),
        ...(connectorMcp ? { connectorMcp } : {}),
        ...(workspace ? { workspace } : {}),
        ...(input.plan ? { plan: input.plan } : {}),
      };
      const approval = workspace ? this.deps.agentMcp.openApprovals(messageId, ws, log, connectorMcp ?? { apps: [], readOnlyTools: [] }, !parentId || Boolean(this.deps.index[messageId].variantOf), input.imageGeneration?.modelId, input.plan?.mode === 'plan' ? 'plan' : 'build', input.viewport, brandId, input.runToken) : undefined;
      const signal = this.deps.cancels.get(messageId)?.signal;
      if (signal?.aborted) return this.deps.keepStopped(messageId, dir, log);
      const steer = createSteer();
      this.deps.live.set(ws, { messageId, steer, log, steers: 0 });
      let fresh: PageModel;
      try {
        fresh = await this.deps.opts.compose({ ...req, ...(approval ? { approval: approval.endpoint } : {}), ...(signal ? { signal } : {}), steer }, this.deps.opts.agent && !parentPage ? mountingLog(log, dir) : log);
      } catch (e) {
        if (signal?.aborted) return this.deps.keepStopped(messageId, dir, log);
        throw e;
      } finally {
        approval?.close();
        // Después del compose ya no hay qué cortar (gates, build, commit): un cancel tardío da 409 en vez de un 202 sin efecto.
        this.deps.cancels.delete(messageId);
        this.deps.live.delete(ws);
      }
      if (signal?.aborted) return this.deps.keepStopped(messageId, dir, log);
      // Modo plan (H6): el turno escribió un plan y lo mandó a aprobar (exit_plan_mode, ya registrado en tools/call). No
      // crea versión: cierra como `asked` colgando del padre. La fase build llega aparte, al aprobar.
      if (input.plan?.mode === 'plan') return this.deps.keepPlan(messageId, dir, log, fresh);
      if (directionKey && fresh.agent?.direction) this.deps.rememberDirection(directionKey, fresh.agent.direction);
      // El estado de página es de la versión, no del mensaje: si el composer no lo reescribe, sigue el del padre.
      const inheritedPage = !fresh.page && parentPage?.page ? { ...fresh, page: parentPage.page } : fresh;
      // La marca aplicada es la que queda en la versión: el siguiente mensaje la hereda de aquí.
      const composed = brand ? { ...inheritedPage, page: { ...(inheritedPage.page ?? {}), brand: brand.id } } : inheritedPage;
      const { page, written: images } = await stepAsync(log, 'transport:images', ['Saving images', 'Saved images'], async () => {
        const r = await localizeAssets(composed, dir, this.deps.opts.fetchAsset);
        return { value: r, detail: { kind: 'action' as const, name: 'images', summary: `${r.written.length}` } };
      }, (r) => r.written.length > 0);
      // Un arreglo que decidió no tocar nada (p. ej. el error es lo que la persona pidió) no es una versión: guardarla
      // duplicaba la del padre y el builder la mostraba como un cambio. El próximo turno sigue colgando del padre.
      if (input.runtimeRepair && page.agent && !page.agent.files.length && isRepo(dir) && this.deps.untouched(messageId, dir)) {
        this.deps.end(messageId, log, 'stop');
        return undefined;
      }
      // El SDK de WhatsApp se inserta al servir (spec wa-sdk §3.4): la versión solo guarda sus datos, en su commit.
      // R6 C2: el compose se vuelve a llamar con la sesión del agente y el error del build; abre su propia aprobación porque
      // la del primer turno se cerró al terminar.
      let resumeStopped = false;
      const resumeOnBuild = workspace
        ? async (error: string): Promise<PageModel | undefined> => {
            if (signal?.aborted) { resumeStopped = true; return undefined; }
            log.emit({ type: 'step.start', stepId: 'transport:build-resume', kind: 'action', label: 'Resuming agent with the build error' });
            // El finally del primer compose ya borró el registro: sin volver a ponerlo, cancel da 409, shutdown() no aborta
            // al CLI y el steer no tiene a quién llegar durante un turno entero con gasto.
            const ctl = new AbortController();
            this.deps.cancels.set(messageId, ctl);
            const resumeSteer = createSteer();
            this.deps.live.set(ws, { messageId, steer: resumeSteer, log, steers: 0 });
            const ap = this.deps.agentMcp.openApprovals(messageId, ws, log, connectorMcp ?? { apps: [], readOnlyTools: [] }, !parentId || Boolean(this.deps.index[messageId].variantOf), input.imageGeneration?.modelId, 'build', input.viewport, undefined, input.runToken);
            try {
              const next = await this.deps.opts.compose({ ...req, prompt: buildFailedPrompt(error), resume: page.agent?.sessionId as string, ...(ap ? { approval: ap.endpoint } : {}), signal: ctl.signal, steer: resumeSteer }, log);
              if (ctl.signal.aborted) { resumeStopped = true; return undefined; }
              log.emit({ type: 'step.end', stepId: 'transport:build-resume', label: 'Agent resumed', status: 'ok', detail: { kind: 'action', name: 'build-resume', summary: `${next.agent?.files.length ?? 0} archivos` } });
              return next;
            } catch (e) {
              if (ctl.signal.aborted) resumeStopped = true;
              log.emit({ type: 'step.end', stepId: 'transport:build-resume', label: 'Resume failed', status: 'error', error: { type: 'execution-error', message: e instanceof Error ? e.message : String(e) } });
              return undefined;
            } finally {
              ap?.close();
              if (this.deps.cancels.get(messageId) === ctl) this.deps.cancels.delete(messageId);
              if (this.deps.live.get(ws)?.messageId === messageId) this.deps.live.delete(ws);
            }
          }
        : undefined;
      writeWaSdk(dir, brand?.facts?.tracking);
      // Como un Stop: lo que el agente alcanzó a escribir antes de morir es una versión, no un error que lo descarta.
      const done = await this.deps.materialize(messageId, dir, log, page, images, page.agent?.interrupted ? 'stopped' : 'stop', { ...requestRecord(req, registry?.pin, parentSkill ?? config().agentSkillId), ...(facts?.version ? { factsVersion: facts.version } : {}) }, instructions, resumeOnBuild, input.viewport).catch((e: unknown) => {
        // Un Stop durante la reanudación no es un fallo del build: lo escrito queda como versión stopped, como un Stop del primer turno.
        if (resumeStopped) return this.deps.keepStopped(messageId, dir, log);
        throw e;
      });
      return done;
    } catch (e) {
      // Un Stop antes del compose (install, montaje del DS, conectores) rompe esos awaits con una excepción: es un corte de la
      // persona, no un fallo. Sin esto cerraba failed con un evento error (QA, hallazgo 2 sobre #596).
      if (this.deps.cancels.get(messageId)?.signal.aborted) return this.deps.keepStopped(messageId, dir, log);
      log.emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      // Un turno que murió sin result (4f140dd) o una excepción a mitad: lo escrito sobre una versión se guarda como versión
      // `failed`, igual que un Stop, porque un error del CLI suele ser una caída de la API a mitad de un turno pagado
      // (nosotros.md §6, §7.8; decisión de Arq). Sin escrituras, o sin page.json (T1), no hay versión.
      const entry = this.deps.index[messageId];
      if (entry && !entry.commit && isRepo(dir)) {
        const sessionId = lastSessionId(dir, entry.at ?? 0);
        if (sessionId) this.deps.updateEntry(messageId, { sessionId });
        return this.deps.keepStopped(messageId, dir, log, { outcome: 'failed' });
      }
      this.deps.end(messageId, log, 'error');
      return undefined;
    }
  }

  /** ADR 0011: deja el DS completo del pin en el workspace (una vez por workspace) y el preview vivo, y devuelve lo
   * que el composer-agente necesita: dónde escribir y dónde mirar. */
  async agentWorkspace(dir: string, log: EventLog, registry: RegistrySource | undefined, points?: ExtensionPoints, pack?: BrandPack, signal?: AbortSignal, o: { tolerateInstall?: boolean; skill?: string } = {}): Promise<NonNullable<ComposeRequest['workspace']>> {
    const marker = registry ? join(dir, '.wt', `ds@${registry.pin}`) : undefined;
    if (registry && marker && !existsSync(marker)) {
      const allow = await this.deps.allowAt(registry.pin);
      await this.deps.withRegistry(log, 'transport:ds', ['Mounting design system', 'Mounted design system'], async () => {
        const items = await resolveItems(Object.keys(allow), registry);
        // Las variantes después de los items, que traen cada .brand.ts en never, y antes del commit del DS: así el diff de la
        // versión no las muestra como obra del agente.
        const written = [...materializeItems(items, dir), ...(points ? writeBrandVariants(dir, points, pack) : [])];
        mkdirSync(join(dir, '.wt'), { recursive: true });
        writeFileSync(join(dir, '.wt', '.gitignore'), '*\n');
        // La lista de lo que puso el registry: la tool typecheck la usa para no atribuirle al agente errores del DS.
        writeFileSync(marker, `${written.join('\n')}\n`);
        // Commit propio del DS: si no, el commit de la versión arrastra la librería (gen 999ea0e0: 444 archivos para 19
        // de secciones) y el diff de la versión deja de mostrar lo que hizo el agente.
        if (isRepo(dir)) commitAll(dir, `base: ds@${registry.pin}`);
        return { value: undefined, paths: [`index@${registry.pin}.json`] };
      });
    }
    if (registry?.skillPack) await this.agentSkill(dir, log, registry, o.skill ?? config().agentSkillId);
    // El agente compila y mira el preview DURANTE su turno: las dependencias tienen que estar antes, no en materialize. Un
    // Stop durante el install lo corta (Arq, R1.3): antes seguía hasta terminar con el turno ya detenido.
    // Con agente, un install que falla aun sin frozen no aborta: el agente corre con el error en contexto y puede arreglar
    // package.json (dep inexistente, versión rota). Abortar dejaba el hilo atascado: ningún turno llegaba al agente.
    let installError: string | undefined;
    try {
      await this.deps.installDeps(dir, log, signal, { retryUnfrozen: true });
    } catch (e) {
      if (!o.tolerateInstall || signal?.aborted) throw e;
      installError = e instanceof Error ? e.message : String(e);
    }
    if (!this.deps.opts.previews) return { dir, ...(installError ? { installError } : {}) };
    let preview: Awaited<ReturnType<PreviewPool['ensure']>>;
    try {
      preview = await this.deps.opts.previews.ensure(dir);
    } catch (e) {
      // Sin dependencias vite no arranca: el turno sigue sin preview vivo en vez de caer por eso.
      if (!installError) throw e;
      return { dir, installError };
    }
    const { url, localUrl } = preview;
    // Stitch muestra el frame desde que el agente empieza y la página se pinta mientras escribe (dinamico-carga.md):
    // el builder recibe la url ya, no al cerrar, y el HMR del dev server lleva cada sección al iframe.
    log.emit({ type: 'step.start', stepId: 'transport:preview-live', kind: 'action', label: 'Opening live preview' });
    log.emit({ type: 'step.end', stepId: 'transport:preview-live', label: 'Live preview', status: 'ok', detail: { kind: 'action', name: 'preview', summary: url } });
    // El marco de una variante pinta este preview mientras crece (contrato con UI, S5); sirve igual a cualquier corrida.
    log.emit({ type: 'preview', url });
    // El agente mira el preview desde la misma máquina: por loopback, no por el dominio público del Sandbox.
    return { dir, previewUrl: localUrl, ...(installError ? { installError } : {}) };
  }

  /** El skill del agente del mismo pin que el DS montado (R6: no del checkout del server). Se reemplaza solo si el pin
   * cambió; con un pin que no lo publica queda el que el composer trae de su skillDir. */
  private async agentSkill(dir: string, log: EventLog, registry: RegistrySource, id: string): Promise<void> {
    const marker = join(dir, '.wt', `skill@${registry.pin}`);
    if (existsSync(marker)) return;
    const src = await this.deps.withRegistry(log, 'transport:skill', ['Reading agent skill', 'Read agent skill'], async () => {
      const value = await registry.skillPack?.(id);
      return { value, paths: value ? [`skills/${id}@${registry.pin}`] : [] };
    });
    if (!src) return;
    const out = join(dir, AGENT_SKILL_DIR);
    rmSync(out, { recursive: true, force: true });
    cpSync(src, out, { recursive: true });
    for (const old of readdirSync(join(dir, '.wt')).filter((f) => f.startsWith('skill@'))) rmSync(join(dir, '.wt', old));
    writeFileSync(marker, '');
  }
}
