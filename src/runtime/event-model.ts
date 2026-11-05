// Modelo puro del contrato de eventos: tipos, validación por línea y fold al estado que pinta la UI.
// Separado de events.ts porque el builder (navegador) lo importa y no puede cargar node:fs.

export const EVENT_VERSION = 1;

/** Mapea 1:1 a los parts de v0: thinking, file-read, file-edit, bash, search, tool-call, agent-action. */
export type StepKind = 'thinking' | 'read' | 'write' | 'bash' | 'search' | 'tool' | 'action';
const STEP_KINDS: readonly StepKind[] = ['thinking', 'read', 'write', 'bash', 'search', 'tool', 'action'];

/** Un par antes/después de una edición. Un Write de archivo entero lleva solo `after`. Make muestra old/new de cada
 * edición en el chat (make-chat deob 3277 :40042-40063 handleCodeDiffVisualization); nosotros lo cerramos con el paso. */
export interface EditPair { before?: string; after: string; replaceAll?: true }

export type StepDetail =
  | { kind: 'read'; paths: string[] }
  // edits: lo que cambió, recortado por lado (EDIT_PAIR_MAX en agent-stream) para no inflar el log ni page.json; truncated lo marca.
  | { kind: 'write'; path: string; op: 'create' | 'update' | 'delete' | 'rename'; stat?: { additions: number; deletions: number }; edits?: EditPair[]; truncated?: true }
  | { kind: 'bash'; command: string; exitCode?: number }
  | { kind: 'search'; scope: 'repo' | 'web'; query: string }
  // shots: capturas que la tool devolvió al agente (browser), guardadas en .wt/shots del workspace; solo el nombre.
  | { kind: 'tool'; name: string; input?: unknown; output?: unknown; shots?: string[] }
  // notes: lo que una edición directa hizo de más o no pudo hacer; followUps: el pedido para arreglar lo que quedó.
  // childId/autoRepair: el mensaje hijo que lanzó el auto-repair, para que el builder se enganche a su stream.
  | { kind: 'action'; name: string; summary: string; notes?: string[]; followUps?: Suggestion[]; childId?: string; autoRepair?: 'runtime' };

/** Un chip de siguiente paso, como featureSuggestions de Lovable: el chip muestra `title` y el clic manda `message`. */
export interface Suggestion { title: string; message: string }

export const isSuggestion = (v: unknown): v is Suggestion =>
  typeof v === 'object' && v !== null && typeof (v as Suggestion).title === 'string' && typeof (v as Suggestion).message === 'string';

/** Por qué falló un paso. Solo acompaña a status 'error': una sección que no pasa validación es un
 * paso 'ok' con las violaciones en detail.output, no un error. */
export interface StepError {
  type: string;
  message: string;
  code?: string;
}

// restore: volver a una versión sin llamar al modelo (v0: finishReason 'block-restore', VERIFIED).
// patch: valores editados a mano sobre page.json o texto editado en el código, también sin modelo (RE-design-mode-patch.md, Edit Text de Stitch).
export type FinishReason = 'stop' | 'error' | 'stopped' | 'restore' | 'patch';
/** Desenlace de la corrida (ADR 0013, regla común 3): finishReason dice cómo cerró el stream; outcome, qué quedó. `asked` es
 * la pregunta del agente sin versión nueva; `failed` puede traer versión si el turno alcanzó a escribir (nosotros.md §7.8). */
export type Outcome = 'ok' | 'stopped' | 'failed' | 'asked';
export const OUTCOMES: readonly Outcome[] = ['ok', 'stopped', 'failed', 'asked'];

// Una tool de conector que espera decisión dentro del turno (--permission-prompt-tool): el turno no se corta. read
// = la tool declara readOnlyHint; sin él es write, y una escritura pide aprobación también en modo auto.
// spend = la tool gasta créditos (generar o editar una imagen): Stitch lo pide aparte con nota de costo
// (MediaGenerationApprovalCard deob :186-196, registry :4855).
// plan = la tarjeta del plan de modo plan (H6): exit_plan_mode, diferida (no bloquea el turno) y nunca autoaprobada.
export type ApprovalKind = 'read' | 'write' | 'spend' | 'plan';
export type ApprovalDecision = 'allow' | 'skip' | 'timeout';
/** Por qué se cerró una decisión sin que la persona la tomara: un mensaje nuevo con el plan pendiente o un cancel del turno. */
export type ApprovalReason = 'user-message' | 'stopped';
export interface ApprovalRequest { callId: string; toolName: string; app: string; reason?: string; input: unknown; kind: ApprovalKind }

export type EventBody =
  | { type: 'message.start'; parentId?: string }
  // tool: la herramienta del agente (Read, Write, Edit, Glob, Grep, Bash, typecheck, browser, ask_user, generate_image,
  // edit_image), para que la UI pinte pendiente/hecho por tipo como v0 (textActive/textComplete por parte, V0:13738-13750).
  | { type: 'step.start'; stepId: string; kind: StepKind; label: string; parentStepId?: string; tool?: string }
  | { type: 'step.output'; stepId: string; text: string }
  | { type: 'step.end'; stepId: string; label: string; status: 'ok' | 'error'; detail?: StepDetail; error?: StepError }
  | { type: 'text.delta'; text: string }
  // Mensaje de la persona con el turno en curso: entra a ese turno, no abre otro mensaje.
  /** `selectedSections`: las del mensaje en vuelo; preserve.files las une a las de request.json. */
  | { type: 'steer'; text: string; selectedSections?: string[] }
  | ({ type: 'approval.request' } & ApprovalRequest)
  /** `scope: 'always'`: "Permitir siempre" de la tarjeta de gasto; la decisión de esta llamada sigue siendo allow.
   * `reason`: la decisión no la tomó la persona (un mensaje nuevo canceló el plan pendiente, o un cancel del turno). */
  | { type: 'approval.decision'; callId: string; decision: ApprovalDecision; scope?: 'always'; reason?: ApprovalReason }
  // Modo plan (H6): el turno escribe un plan y lo manda a aprobar sin crear versión. plan.start al arrancar; plan.ready
  // cuando exit_plan_mode validó (tras approval.request kind:'plan'); plan.resumed al aprobar (arranca la fase build del
  // mismo mensaje); plan.cancelled al rechazar, al cancelarlo un mensaje nuevo o al cortar el turno.
  | { type: 'plan.start'; path: string }
  | { type: 'plan.ready'; callId: string; path: string; summary: string }
  | { type: 'plan.resumed'; callId: string; edited: boolean }
  // `feedback`: el texto con que la persona rechazó; va también como prompt del mensaje hijo que itera el plan.
  | { type: 'plan.cancelled'; callId: string; reason: 'rejected' | 'user-message' | 'stopped'; feedback?: string }
  // M2 (C4): lo que `page-plan.md` declara como inventado (`inventado:` por sección) al cerrar la versión. Cada turno trae el
  // suyo y reemplaza al anterior: la persona ve qué de esta página es de ejemplo.
  | { type: 'facts.invented'; items: { slug: string; text: string }[] }
  // M2 (contexto del agente): la tool `remember` guardó un hecho de la marca (memory.write, con el hecho sustituido si
  // hubo replaces); cada turno con agente reporta cuánto de su ventana usó (context.usage, de agent.trace.context).
  | { type: 'memory.write'; fact: string; replaced?: string }
  | { type: 'context.usage'; ratio: number; lastTokens: number; floorTokens: number; window: number }
  /** `interrupted`: la corrida estaba viva cuando cayó el transport y la cerró recover (ADR 0013 D2). `continuable`: hay
   * versión y sesión del CLI para seguirla con POST /runs {parentId, continue: true}. */
  | { type: 'message.end'; finishReason: FinishReason; outcome?: Outcome; interrupted?: true; continuable?: boolean; usage?: { credits?: number; inputTokens?: number; outputTokens?: number } }
  | { type: 'error'; message: string; code?: string }
  // Llega DESPUÉS de message.end, como el snapshot de v0 (404 justo al cerrar, 200 segundos después).
  | { type: 'snapshot'; dir: string; files: string[]; commit?: string }
  // Terminal único de toda corrida: después de message.end y snapshot llegan los pasos tardíos (preview-check, sugerencias),
  // como el featureSuggestions de Lovable en asyncRunResult tras el run (dashboard-shared-CKfq1xYq.deob.js:4756-4762).
  | { type: 'settled' }
  // R3 (ADR 0013 §1): la cola de variantes vive en el log y no solo en memoria. run.queued al entrar a la cola, con lo que
  // hace falta para relanzarla tras reiniciar; run.started al salir de ella. Una corrida que no pasó por cola no los lleva.
  | { type: 'run.queued'; variant: VariantInfo }
  | { type: 'run.started' }
  // Variante de un grupo (S5): título y prompt propios de esta variante, como cada pantalla de una sesión de variantes de
  // Stitch (ZAP 26790: campos 8 y 9 de cada screen, escritos por el agente antes de generar).
  | ({ type: 'variant' } & VariantInfo)
  // El dev server del workspace ya responde: el lienzo pinta el marco mientras la página crece, como el placeholder de
  // Stitch que se llena con el HTML parcial (ZAP 26790, snaps 6-140).
  | { type: 'preview'; url: string };

export interface VariantInfo { groupId: string; sourceId: string; index: number; count: number; title: string; prompt: string }

export type EngineEvent = EventBody & { v: typeof EVENT_VERSION; messageId: string; seq: number; at: number };

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** El nombre de una captura llega a una URL del transport: sin barras ni puntos de más, nada que salga de .wt/shots. */
export const SHOT_FILE = /^[A-Za-z0-9_-]+-\d+\.png$/;

/** Valida una línea ya parseada. Lo que no cumple es un error de datos, no algo que se salta: un log
 * corrupto que se lee "a medias" pinta una corrida que nunca pasó. */
export function parseEvent(raw: unknown): EngineEvent {
  if (typeof raw !== 'object' || raw === null) throw new Error('events: la línea no es un objeto');
  const e = raw as Record<string, unknown>;
  if (e.v !== EVENT_VERSION) throw new Error(`events: versión ${String(e.v)} no soportada`);
  if (!isStr(e.messageId) || !Number.isInteger(e.seq) || typeof e.at !== 'number') throw new Error('events: falta messageId, seq o at');
  const bad = (field: string): never => { throw new Error(`events: ${String(e.type)} sin ${field}`); };
  switch (e.type) {
    case 'message.start':
      break;
    case 'step.start':
      if (!isStr(e.stepId)) bad('stepId');
      if (!STEP_KINDS.includes(e.kind as StepKind)) bad('kind válido');
      if (!isStr(e.label) || !e.label) bad('label');
      if (e.tool !== undefined && !isStr(e.tool)) bad('tool como string');
      break;
    case 'step.output':
      if (!isStr(e.stepId) || !isStr(e.text)) bad('stepId/text');
      break;
    case 'step.end':
      if (!isStr(e.stepId) || !isStr(e.label) || !e.label) bad('stepId/label');
      if (e.status !== 'ok' && e.status !== 'error') bad('status');
      if (isObj(e.detail) && e.detail.shots !== undefined && !(Array.isArray(e.detail.shots) && e.detail.shots.every((f) => isStr(f) && SHOT_FILE.test(f)))) bad('shots como nombres de captura');
      if (isObj(e.detail) && e.detail.followUps !== undefined && !(Array.isArray(e.detail.followUps) && e.detail.followUps.every(isSuggestion))) bad('followUps como {title, message}');
      if (e.error !== undefined) {
        const err = e.error as Record<string, unknown>;
        if (e.status !== 'error') bad('status error para llevar error');
        if (typeof err !== 'object' || err === null || !isStr(err.type) || !isStr(err.message)) bad('error.type/message');
      }
      break;
    case 'text.delta':
      if (!isStr(e.text)) bad('text');
      break;
    case 'steer':
      if (!isStr(e.text)) bad('text');
      if (e.selectedSections !== undefined && !(Array.isArray(e.selectedSections) && e.selectedSections.every(isStr))) bad('selectedSections como string[]');
      break;
    case 'message.end':
      if (!['stop', 'error', 'stopped', 'restore', 'patch'].includes(e.finishReason as string)) bad('finishReason');
      if (e.outcome !== undefined && !OUTCOMES.includes(e.outcome as Outcome)) bad('outcome ok|stopped|failed|asked');
      if (e.interrupted !== undefined && e.interrupted !== true) bad('interrupted solo true');
      if (e.continuable !== undefined && typeof e.continuable !== 'boolean') bad('continuable como boolean');
      break;
    case 'approval.request':
      if (!isStr(e.callId) || !e.callId || !isStr(e.toolName) || !e.toolName || !isStr(e.app)) bad('callId/toolName/app');
      if (e.kind !== 'read' && e.kind !== 'write' && e.kind !== 'spend' && e.kind !== 'plan') bad('kind read|write|spend|plan');
      if (e.reason !== undefined && !isStr(e.reason)) bad('reason como string');
      break;
    case 'approval.decision':
      if (!isStr(e.callId) || !['allow', 'skip', 'timeout'].includes(e.decision as string)) bad('callId/decision');
      if (e.scope !== undefined && (e.scope !== 'always' || e.decision !== 'allow')) bad('scope always solo con allow');
      if (e.reason !== undefined && e.reason !== 'user-message' && e.reason !== 'stopped') bad('reason user-message|stopped');
      break;
    case 'plan.start':
      if (!isStr(e.path) || !e.path) bad('path');
      break;
    case 'plan.ready':
      if (!isStr(e.callId) || !e.callId || !isStr(e.path) || !e.path || !isStr(e.summary)) bad('callId/path/summary');
      break;
    case 'plan.resumed':
      if (!isStr(e.callId) || !e.callId || typeof e.edited !== 'boolean') bad('callId/edited');
      break;
    case 'plan.cancelled':
      if (!isStr(e.callId) || !e.callId || !['rejected', 'user-message', 'stopped'].includes(e.reason as string)) bad('callId/reason');
      if (e.feedback !== undefined && !isStr(e.feedback)) bad('feedback como string');
      break;
    case 'facts.invented':
      if (!Array.isArray(e.items) || !e.items.every((i) => isObj(i) && isStr(i.slug) && isStr(i.text))) bad('items como {slug, text}[]');
      break;
    case 'memory.write':
      if (!isStr(e.fact) || !e.fact) bad('fact');
      if (e.replaced !== undefined && !isStr(e.replaced)) bad('replaced como string');
      break;
    case 'context.usage':
      if (typeof e.ratio !== 'number' || typeof e.lastTokens !== 'number' || typeof e.floorTokens !== 'number' || typeof e.window !== 'number') bad('ratio/lastTokens/floorTokens/window numéricos');
      break;
    case 'error':
      if (!isStr(e.message)) bad('message');
      break;
    case 'snapshot':
      if (!isStr(e.dir) || !Array.isArray(e.files) || !e.files.every(isStr)) bad('dir/files');
      if (e.commit !== undefined && !isStr(e.commit)) bad('commit como string');
      break;
    case 'settled':
      break;
    case 'run.queued': {
      const v = isObj(e.variant) ? e.variant : bad('variant');
      if (!isStr(v.groupId) || !v.groupId || !isStr(v.sourceId) || !v.sourceId || !isStr(v.title) || !isStr(v.prompt)) bad('variant con groupId/sourceId/title/prompt');
      if (!Number.isInteger(v.index) || !Number.isInteger(v.count) || (v.index as number) < 0 || (v.index as number) >= (v.count as number)) bad('variant.index/count');
      break;
    }
    case 'run.started':
      break;
    case 'variant':
      if (!isStr(e.groupId) || !e.groupId || !isStr(e.sourceId) || !e.sourceId || !isStr(e.title) || !isStr(e.prompt)) bad('groupId/sourceId/title/prompt');
      if (!Number.isInteger(e.index) || !Number.isInteger(e.count) || (e.index as number) < 0 || (e.index as number) >= (e.count as number)) bad('index/count');
      break;
    case 'preview':
      if (!isStr(e.url) || !e.url) bad('url');
      break;
    default:
      throw new Error(`events: tipo desconocido "${String(e.type)}"`);
  }
  return e as unknown as EngineEvent;
}

export interface StepState {
  id: string;
  kind: StepKind;
  label: string;
  status: 'running' | 'ok' | 'error' | 'interrupted';
  output: string;
  detail?: StepDetail;
  parentStepId?: string;
  tool?: string;
  startedAt: number;
  finishedAt?: number;
  error?: StepError;
}

export interface MessageState {
  messageId: string | null;
  status: 'streaming' | FinishReason;
  steps: StepState[];
  text: string;
  error?: { message: string; code?: string };
  usage?: Extract<EventBody, { type: 'message.end' }>['usage'];
  snapshot?: { dir: string; files: string[]; commit?: string };
  /** Lo que la persona mandó con este turno en curso, en orden. */
  steers?: string[];
  /** Cada pedido de aprobación del turno con su decisión; sin decision sigue pendiente. */
  approvals?: (ApprovalRequest & { decision?: ApprovalDecision; scope?: 'always' })[];
  variant?: VariantInfo;
  preview?: string;
  outcome?: Outcome;
  interrupted?: true;
  continuable?: boolean;
  /** En la cola de variantes, esperando lugar bajo maxRunning. */
  queued?: true;
  /** Modo plan (H6): este turno escribió un plan. */
  planMode?: true;
  /** El plan pendiente de decisión y su estado. `reason` solo cuando se canceló sin decisión de la persona. La tarjeta la
   * pinta la UI; el `reason` del agente (ToolApproval.reason de la aprobación kind:'plan') es otro campo y no se pisa. */
  /** Lo inventado según el plan de la última versión del turno (facts.invented); reemplaza, no acumula. */
  invented?: { slug: string; text: string }[];
  plan?: { status: 'pending' | 'approved' | 'rejected' | 'cancelled'; callId: string; path: string; summary: string; edited?: boolean; reason?: 'rejected' | 'user-message' | 'stopped'; feedback?: string };
  /** M2: hechos que la tool `remember` guardó en este turno; cuánto de la ventana usó el agente; lo que el plan declaró inventado. */
  memoryWrites?: { fact: string; replaced?: string }[];
  contextUsage?: { ratio: number; lastTokens: number; floorTokens: number; window: number };
}

export const emptyMessage = (): MessageState => ({ messageId: null, status: 'streaming', steps: [], text: '' });

const updateStep = (steps: StepState[], id: string, patch: (s: StepState) => StepState): StepState[] =>
  steps.map((s) => (s.id === id ? patch(s) : s));

/** Aplica un evento al estado que pinta la UI. Puro: el mismo fold sirve para el replay completo y
 * para ir aplicando lo que llega de un resume. */
/** El mensaje vuelve a correr: el desenlace del tramo anterior (message.end{asked} del plan) ya no vale. Se quedan el plan, las
 * aprobaciones y los pasos, que son historia del turno. */
function reopened(state: MessageState): MessageState {
  const { outcome, usage, interrupted, continuable, ...open } = state;
  return { ...open, status: 'streaming' };
}

export function applyEvent(state: MessageState, e: EngineEvent): MessageState {
  const base = { ...state, messageId: e.messageId };
  switch (e.type) {
    case 'message.start':
      // Un message.start tras un message.end abre otro tramo del mismo mensaje (la fase build de un plan aprobado), antes de
      // que llegue plan.resumed: el desenlace anterior ya no vale y el builder tiene que ver el mensaje en curso.
      return state.status === 'streaming' ? base : reopened(base);
    case 'step.start':
      return { ...base, steps: [...state.steps, { id: e.stepId, kind: e.kind, label: e.label, status: 'running', output: '', parentStepId: e.parentStepId, ...(e.tool ? { tool: e.tool } : {}), startedAt: e.at }] };
    case 'step.output':
      return { ...base, steps: updateStep(state.steps, e.stepId, (s) => ({ ...s, output: s.output + e.text })) };
    case 'step.end':
      return { ...base, steps: updateStep(state.steps, e.stepId, (s) => ({ ...s, label: e.label, status: e.status, detail: e.detail, error: e.error, finishedAt: e.at })) };
    case 'text.delta':
      return { ...base, text: state.text + e.text };
    case 'steer':
      return { ...base, steers: [...(state.steers ?? []), e.text] };
    case 'message.end':
      // Un paso sin step.end al cerrar el mensaje murió a medias. Sin message.end no se puede
      // distinguir de uno que sigue corriendo, así que ahí se queda 'running'.
      return { ...base, status: e.finishReason, usage: e.usage, ...(e.outcome ? { outcome: e.outcome } : {}), ...(e.interrupted ? { interrupted: true as const } : {}), ...(e.continuable !== undefined ? { continuable: e.continuable } : {}), steps: state.steps.map((s) => (s.status === 'running' ? { ...s, status: 'interrupted' } : s)) };
    case 'approval.request': {
      const { callId, toolName, app, reason, input, kind } = e;
      return { ...base, approvals: [...(state.approvals ?? []), { callId, toolName, app, input, kind, ...(reason ? { reason } : {}) }] };
    }
    case 'approval.decision':
      return { ...base, approvals: (state.approvals ?? []).map((a) => (a.callId === e.callId ? { ...a, decision: e.decision, ...(e.scope ? { scope: e.scope } : {}) } : a)) };
    case 'error':
      return { ...base, error: { message: e.message, code: e.code } };
    case 'snapshot':
      return { ...base, snapshot: { dir: e.dir, files: e.files, ...(e.commit ? { commit: e.commit } : {}) } };
    case 'settled':
      return base;
    case 'run.queued':
      return { ...base, queued: true, variant: e.variant };
    case 'run.started': {
      const { queued: _, ...rest } = base;
      return rest;
    }
    case 'variant': {
      const { groupId, sourceId, index, count, title, prompt } = e;
      return { ...base, variant: { groupId, sourceId, index, count, title, prompt } };
    }
    case 'preview':
      return { ...base, preview: e.url };
    case 'plan.start':
      return { ...base, planMode: true };
    case 'plan.ready':
      return { ...base, plan: { status: 'pending', callId: e.callId, path: e.path, summary: e.summary } };
    case 'plan.resumed': {
      return { ...reopened(base), plan: state.plan ? { ...state.plan, status: 'approved', edited: e.edited } : state.plan };
    }
    case 'facts.invented':
      return { ...base, invented: e.items };
    case 'plan.cancelled':
      return { ...base, plan: state.plan ? { ...state.plan, status: e.reason === 'rejected' ? 'rejected' : 'cancelled', reason: e.reason, ...(e.feedback ? { feedback: e.feedback } : {}) } : state.plan };
    case 'memory.write':
      return { ...base, memoryWrites: [...(state.memoryWrites ?? []), { fact: e.fact, ...(e.replaced ? { replaced: e.replaced } : {}) }] };
    case 'context.usage':
      return { ...base, contextUsage: { ratio: e.ratio, lastTokens: e.lastTokens, floorTokens: e.floorTokens, window: e.window } };
  }
}

export const foldMessage = (events: EngineEvent[], from: MessageState = emptyMessage()): MessageState =>
  events.reduce(applyEvent, from);
