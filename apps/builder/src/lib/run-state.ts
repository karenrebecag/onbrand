import type { EngineEvent, MessageState, StepState, Suggestion } from '@engine/runtime/event-model'
import type { AgentRunState, RunStep, StepMark } from '@/components/arc/blocks/agent-run/agent-run'
import type { ToolApproval } from '@/components/arc/blocks/agent-run/agent-run-types'
import { RUNTIME_KINDS } from '@engine/runtime/runtime-kinds'
import type { ContrastDefect } from './runtime-errors'
import { stepLabelEs } from './step-labels'

const PKG = /^(npm|bun|pnpm|yarn)\b/

function markOf(step: StepState): StepMark {
  const d = step.detail
  if (step.kind === 'thinking') return 'think'
  if (step.kind === 'read') return 'read'
  if (step.kind === 'write') return 'edit'
  if (step.kind === 'search' || step.kind === 'tool') return 'search'
  if (d?.kind === 'bash' && PKG.test(d.command)) return 'npm'
  return 'terminal'
}

const lines = (text: string) => text.split('\n').map((l) => l.trimEnd()).filter(Boolean)
const json = (v: unknown) => (v === undefined ? '' : JSON.stringify(v))

/** Arc escribe verbo + objetivo; si el label del motor ya nombra el objetivo ("Compuso hero"), repetirlo se lee "hero hero". */
const unlessNamed = (label: string, target: string | undefined) =>
  target && !label.toLowerCase().endsWith(target.toLowerCase()) ? target : undefined

/** La línea de desborde que mide la tool browser (#258), para leerla sin abrir la salida entera. */
const overflowLine = (text: string) => text.split('\n').find((l) => /desborde horizontal/i.test(l))

function toStep(step: StepState, shotUrl?: ShotUrl): RunStep {
  const d = step.detail
  const label = stepLabelEs(step.label)
  const browser = d?.kind === 'tool' && d.name === 'browser'
  const output = d?.kind === 'tool' && typeof d.output === 'string' ? d.output : undefined
  // Sin URL firmada todavía la captura no se pinta: llega con el repintado que trae la firma (media-urls.ts).
  const shots = browser && shotUrl ? (d.shots ?? []).flatMap((f, i, all) => ((src) => (src ? [{ src, alt: all.length > 1 ? `${label} (${i + 1} de ${all.length})` : label }] : []))(shotUrl(f))) : []
  return {
    ...(browser && output && overflowLine(output) ? { note: overflowLine(output) } : {}),
    ...(shots.length ? { shots } : {}),
    id: step.id,
    mark: markOf(step),
    // El motor manda un label por tiempo verbal (start y end); el fold se queda con el último.
    verb: label,
    doneVerb: label,
    target: d?.kind === 'search' ? (label.includes(d.query) ? undefined : `“${d.query}”`) : d?.kind === 'write' ? unlessNamed(label, d.path) : d?.kind === 'read' ? (d.paths.length === 1 && step.label.includes(d.paths[0]!) ? undefined : `${d.paths.length} ${d.paths.length === 1 ? 'archivo' : 'archivos'}`) : undefined,
    // 'rejected' en Arc es "el humano lo devolvió"; un paso que falló o quedó cortado es 'failed'.
    status: step.status === 'running' ? 'running' : step.status === 'ok' ? 'done' : 'failed',
    ms: step.finishedAt !== undefined ? step.finishedAt - step.startedAt : undefined,
    // El resumen de una acción puede ser el arco entero del plan: en la etiqueta desborda, va al cuerpo plegable como en v0.
    text: step.kind === 'thinking' ? step.output : d?.kind === 'action' ? d.summary : undefined,
    reason: step.error?.message,
    io: d?.kind === 'bash' ? { input: d.command, output: lines(step.output) }
      // Los pares antes/después de una edición, como el old/new del chat de Make (MAKE-CHAT:40042-40063): entrada = lo
      // reemplazado, salida = lo nuevo; "…" marca el recorte del motor.
      : d?.kind === 'write' && d.edits?.length ? { input: d.edits.map((e) => e.before ?? '').join('\n---\n'), output: [...lines(d.edits.map((e) => e.after).join('\n---\n')), ...(d.truncated ? ['…'] : [])] }
      : d?.kind === 'read' ? { input: d.paths.join('\n'), output: lines(step.output) }
      : d?.kind === 'tool' ? { input: json(d.input), output: lines(output ?? json(d.output)) }
      // Una búsqueda web cierra con la respuesta y sus fuentes como salida, como finished-web-search de v0.
      : d?.kind === 'search' ? { input: d.query, output: lines(step.output) }
      : undefined,
  }
}

/** El turno del agente cuelga sus pasos de un paso padre (parentStepId, 'agent:write'); sin anidar, sus decenas de
 * lecturas y ediciones tapan los pasos del motor. Un hijo cuyo padre no llegó al log queda arriba, no se pierde. */
export type ShotUrl = (file: string) => string | undefined

export function nestSteps(states: StepState[], shotUrl?: ShotUrl): RunStep[] {
  const ids = new Set(states.map((s) => s.id))
  const parentOf = (s: StepState) => (s.parentStepId && s.parentStepId !== s.id && ids.has(s.parentStepId) ? s.parentStepId : undefined)
  const build = (s: StepState, seen: ReadonlySet<string>): RunStep => {
    // seen corta un ciclo de parentStepId (a → b → a) que un log corrupto podría traer.
    const kids = states.filter((c) => parentOf(c) === s.id && !seen.has(c.id))
    const step = toStep(s, shotUrl)
    return kids.length ? { ...step, children: kids.map((c) => build(c, new Set([...seen, c.id]))) } : step
  }
  return states.filter((s) => !parentOf(s)).map((s) => build(s, new Set([s.id])))
}

// Los siguientes pasos del resumen ya salen como chips (agent.suggestions); repetirlos en el texto duplica la lista.
const NEXT_STEPS = /\n+[^\n]*Siguientes pasos[^\n]*\n(?:\s*[-*].*(?:\n|$))*/i

/** El resumen como texto: sin la marca de markdown que no se pinta y sin la lista que ya son chips. */
/** Avisos de los pasos del motor (`notes`): lo que el turno resolvió de otra forma de la pedida, p. ej. hechos de la marca
 * de la caché porque la fuente no respondió (D1). Van en el cuerpo del turno, no escondidos en "Ver pasos". */
export function notesOf(message: MessageState): string[] {
  return message.steps.flatMap((s) => (!s.parentStepId && s.status === 'ok' && s.detail?.kind === 'action' ? s.detail.notes ?? [] : []))
}

export const summaryText = (text: string): string => text.replace(NEXT_STEPS, '\n').replace(/\*\*|`/g, '').trim()

/** El resumen con su markdown, para el panel que lo pinta (mini-markdown); sin la lista que ya son chips. */
export const summaryMarkdown = (text: string): string => text.replace(NEXT_STEPS, '\n').trim()

/** La línea de estado en itálica del panel, como "Designing a screen" en Stitch: el último paso que sigue abierto. */
export type UpdateStatus = 'started' | 'completed' | 'failed'
export interface ToolUpdate { tool: string; displayName: string; total: number; completed: number; status: UpdateStatus }

/** Stitch muestra hasta cinco herramientas y resume el resto en "+N more…" (MgComponent, kg = 5). */
export const UPDATES_SHOWN = 5

// El texto por herramienta, como el mapa mp de Stitch (design_screen → "Designing screen"): uno por tipo, no por archivo.
const TOOL_NAMES: Record<string, string> = {
  read: 'Leyendo archivos',
  write: 'Escribiendo archivos',
  search: 'Buscando en el código',
  bash: 'Ejecutando comandos',
  typecheck: 'Revisando tipos',
  browser: 'Mirando la página',
}

// Con `tool` en step.start (S4 §6) la herramienta viene dicha; los logs de antes la deducen: read/write/search/bash por
// su kind, y las del MCP del workspace por el verbo de su label (agent-stream stepOf).
function toolOf(step: StepState): string {
  if (step.tool && step.kind === 'tool') return step.tool
  if (step.kind !== 'tool') return step.kind
  if (/^(Revisando tipos|Tipos revisados)/.test(step.label)) return 'typecheck'
  if (/^(Mirando la página|Vio la página)/.test(step.label)) return 'browser'
  return step.label
}

const statusOf = (step: StepState): UpdateStatus | null =>
  step.status === 'running' ? 'started' : step.status === 'ok' ? 'completed' : step.status === 'error' ? 'failed' : null

/** Las herramientas del agente agrupadas como Ag de Stitch (DesignPage, MgComponent): una fila por herramienta en el
 * orden en que apareció, con cuántas llamadas terminaron, y el estado del grupo: falló si alguna falló, en curso si
 * alguna sigue, completo si terminaron todas. Solo cuentan las llamadas del agente (hijas de su paso), no los pasos
 * del motor ni el razonamiento. */
export function toolUpdates(message: MessageState): ToolUpdate[] {
  const groups = new Map<string, { displayName: string; statuses: UpdateStatus[] }>()
  for (const step of message.steps) {
    if (!step.parentStepId || step.kind === 'thinking') continue
    const status = statusOf(step)
    if (!status) continue
    const tool = toolOf(step)
    const group = groups.get(tool)
    if (group) group.statuses.push(status)
    else groups.set(tool, { displayName: TOOL_NAMES[tool] ?? stepLabelEs(step.label), statuses: [status] })
  }
  return [...groups].map(([tool, { displayName, statuses }]) => ({
    tool,
    displayName,
    total: statuses.length,
    completed: statuses.filter((s) => s === 'completed').length,
    status: statuses.includes('failed') ? 'failed' : statuses.includes('started') ? 'started' : 'completed',
  }))
}

// R2.6/R4.3: message.end trae outcome, interrupted y continuable, y el fold de ec los deja en el MessageState. Se leen
// como opcionales para que un log viejo, sin esos campos, se pinte como hasta ahora.
type EndFlags = { outcome?: 'ok' | 'stopped' | 'failed' | 'asked'; interrupted?: boolean; continuable?: boolean }
export const endFlagsOf = (message: MessageState): EndFlags => {
  const { outcome, interrupted, continuable } = message as MessageState & EndFlags
  return { ...(outcome ? { outcome } : {}), ...(interrupted ? { interrupted } : {}), ...(continuable ? { continuable } : {}) }
}

/** Plan mode (plan-mode.md §4): planning → awaiting_plan_approval → building | cancelled. */
export type PlanPhase = 'planning' | 'awaiting_plan_approval' | 'building' | 'cancelled'

// El fold de plan.* es de Secondary (event-model MessageState.plan); se lee como opcional para no depender de su forma
// exacta, y la aprobación kind 'plan' basta para saber la fase si el fold todavía no existe.
type PlanFold = { status?: 'pending' | 'approved' | 'rejected' | 'cancelled'; callId?: string; edited?: boolean; reason?: 'rejected' | 'user-message' | 'stopped'; feedback?: string }
type PlanApprovalFields = { kind: string; decision?: string; cancelReason?: 'user-message' | 'stopped'; edited?: boolean; feedback?: string }
const planFoldOf = (message: MessageState): PlanFold | undefined => (message as MessageState & { plan?: PlanFold }).plan
const planApprovalOf = (message: MessageState) => (message.approvals as PlanApprovalFields[] | undefined)?.find((a) => a.kind === 'plan')

export function planPhaseOf(message: MessageState, mode?: 'plan'): PlanPhase | null {
  const fold = planFoldOf(message)
  const approval = planApprovalOf(message)
  // planMode lo pliega plan.start: un hilo rehidratado no trae el `mode` del pedido.
  if (!fold && !approval) return mode === 'plan' || message.planMode ? 'planning' : null
  if (fold?.status === 'cancelled' || fold?.status === 'rejected' || approval?.decision === 'skip' || approval?.decision === 'timeout') return 'cancelled'
  if (fold?.status === 'approved' || approval?.decision === 'allow') return 'building'
  return approval || fold?.status === 'pending' ? 'awaiting_plan_approval' : 'planning'
}

/** La aprobación de plan con lo que solo dice el fold: por qué se canceló y si se editó antes de aprobar. */
function withPlanFields<A extends PlanApprovalFields>(approval: A, fold: PlanFold | undefined): A {
  if (approval.kind !== 'plan' || !fold) return approval
  const cancelReason = fold.reason === 'user-message' || fold.reason === 'stopped' ? fold.reason : approval.cancelReason
  const feedback = approval.feedback ?? (typeof fold.feedback === 'string' && fold.feedback.trim() ? fold.feedback : undefined)
  return { ...approval, ...(cancelReason ? { cancelReason } : {}), ...(fold.edited ? { edited: true } : {}), ...(feedback ? { feedback } : {}) }
}

/** Un mensaje nuevo con el plan pendiente lo cancela en el transport (§5), pero ese log ya no se sigue: la tarjeta lo
 * refleja al enviar, como el CANCELLED_BY_USER_MESSAGE_AWAITING_APPROVAL de Lovable. */
export function cancelPendingPlan(message: MessageState): MessageState {
  if (!message.approvals?.some((a) => (a as PlanApprovalFields).kind === 'plan' && !a.decision)) return message
  return { ...message, approvals: message.approvals.map((a) => ((a as PlanApprovalFields).kind === 'plan' && !a.decision ? { ...a, decision: 'skip', cancelReason: 'user-message' } : a)) }
}

const PHASE_LINE: Partial<Record<PlanPhase, string>> = { planning: 'Planificando…', building: 'Construyendo el plan…' }

/** Plan aprobado cuya fase build no tocó nada fuera de `.wt/` (planOnly, #554): cierra normal pero sin commit propio. Es
 * un resultado, no un fallo: se dice en tono neutro y el turno no ofrece cambios que ver. */
export const PLAN_ONLY_TEXT = 'El plan se aplicó sin cambios en la página: no hay versión nueva.'

export function planOnlyOf(message: MessageState, parentCommit?: string): boolean {
  if (message.status === 'streaming' || message.error || planPhaseOf(message) !== 'building') return false
  const commit = message.snapshot?.commit
  return !commit || commit === parentCommit
}

/** El veredicto del rechazo se aplica al confirmar el POST, sin esperar a que approval.decision llegue por el stream del
 * plan (que el builder sigue mientras está pendiente): la tarjeta no se queda en "Rechazando el plan…" entre los dos. */
export function rejectPlanLocally(message: MessageState, callId: string, feedback?: string): MessageState {
  if (!message.approvals?.some((a) => a.callId === callId && !a.decision)) return message
  const note = feedback?.trim()
  return { ...message, approvals: message.approvals.map((a) => (a.callId === callId ? { ...a, decision: 'skip', ...(note ? { feedback: note } : {}) } : a)) }
}

export function statusLine(message: MessageState, mode?: 'plan'): string {
  const running = message.steps.filter((s) => s.status === 'running').at(-1)
  const phase = planPhaseOf(message, mode)
  return running ? stepLabelEs(running.label) : (phase && PHASE_LINE[phase]) ?? 'Pensando…'
}

export interface FileStat { path: string; additions: number; deletions?: number }

/** Los archivos del diff solo si el turno dejó su propia versión. El diff se recarga con cada snapshot, así que un Stop o
 * un error sin escrituras se quedaría con el de la versión anterior; Lovable marca el mensaje detenido y no le presta
 * nada del anterior (editor-body-shared-BZvxHyYj/deobfuscated.js:6178-6183, 6196-6204). */
export function ownStats(message: MessageState, stats: FileStat[], parentCommit?: string): FileStat[] {
  return message.snapshot && !planOnlyOf(message, parentCommit) ? stats : []
}

/** Lo que pinta AgentRun, derivado del MessageState plegado. Puro: el mismo fold da la misma tarjeta, sea
 * replay o resume. `files` viene del diff del transport (git --numstat contra el commit padre). */
export function toRunState(message: MessageState, elapsedMs: number, files: FileStat[], shotUrl?: ShotUrl): AgentRunState {
  const steps = nestSteps(message.steps, shotUrl)
  const fold = planFoldOf(message)
  const all = (message.approvals ?? []).map((a) => withPlanFields(a as typeof a & PlanApprovalFields, fold)) as ToolApproval[]
  const approvals = all.length ? { approvals: all } : {}
  if (message.status === 'streaming') return { status: 'working', elapsedMs, steps, ...approvals }
  // La tarjeta resuelta de Lovable sigue en el turno con su veredicto y el prompt, sin botones (MediaGenerationApprovalCard
  // :155-160, :197): al cerrar quedan las decididas.
  // El plan se decide con el turno ya cerrado (exit_plan_mode termina el turno): el pendiente se queda con sus botones.
  const decided = all.filter((a) => a.decision || a.kind === 'plan')
  const summary = message.error?.message ?? summaryText(message.text)
  // Solo los del motor (instalar, compilar): los bash del agente cuelgan de su turno y no son verificaciones.
  const checks = message.steps.filter((s) => s.kind === 'bash' && s.status === 'ok' && !s.parentStepId).map((s) => stepLabelEs(s.label))
  return {
    // Detenido por la persona: lo escrito hasta ahí queda como versión, así que lleva resumen y archivos igual.
    status: message.status === 'stopped' ? 'stopped' : 'done',
    elapsedMs,
    steps,
    result: { summary, files: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions ?? 0 })), checks },
    ...(decided.length ? { approvals: decided } : {}),
  }
}

const PREVIEW_CHECK = 'transport:preview-check'

/** Errores que el preview-check encontró en esta versión (defectos del navegador más los de vite), 0 si no hay. Un check
 * que se cayó no cuenta: ahí no se sabe nada de la página y "Arreglar" no tendría qué arreglar. */
export function previewIssuesOf(message: MessageState): number {
  return previewIssueMessages(message).length
}

// Los kinds de error de runtime los define el server (RUNTIME_KINDS en src/runtime/runtime-kinds.ts, re-exportada por runtime-repair.ts): lo que "Arreglar" cuenta
// es lo mismo que startRuntimeRepair acepta (v0-design-mode deob :41702-41722 y :41764).
// Re-exportada para el test de paridad (tests/builder-runtime-kinds.test.ts).
export { RUNTIME_KINDS }

/** Los errores que "Arreglar" va a atacar: los del preview-check (navegador, montaje, vite) más los del preview vivo. */
export function previewIssueSummary(message: MessageState, liveErrors = 0): string {
  const errors = previewIssueMessages(message).length + liveErrors
  return errors ? `${errors} ${errors === 1 ? 'error' : 'errores'}` : ''
}

/** El texto de cada error del preview-check (defectos del navegador y líneas de vite), para no contar dos veces lo
 * que el puente del preview vivo también manda. */
export function previewIssueMessages(message: MessageState): string[] {
  const step = message.steps.find((s) => s.id === PREVIEW_CHECK)
  if (step?.status !== 'error' || step.detail?.kind !== 'tool' || step.detail.name !== 'preview-runtime') return []
  const out = step.detail.output as { defects?: unknown; server?: unknown } | undefined
  const defects = Array.isArray(out?.defects)
    ? out.defects.filter((d) => RUNTIME_KINDS.has(String((d as { kind?: unknown })?.kind ?? ''))).map((d) => String((d as { message?: unknown })?.message ?? ''))
    : []
  const server = Array.isArray(out?.server) ? out.server.map(String) : []
  return [...defects, ...server]
}

/** Un defecto de contraste del preview-check (#890): una sección con textos bajo WCAG AA, el peor texto, su razón y su par de colores. */
export interface ContrastIssue { slug: string | null; text: string; ratio: number; fg: string; bg: string }

const HEX = /^#[0-9a-f]{6}$/i

/** Los defectos `contrast` del preview-check de la versión. Quedan fuera de RUNTIME_KINDS: no disparan auto-repair ni cuentan para
 * "Arreglar"; el builder los avisa aparte y el arreglo lo pide la persona. Vienen del servidor, así que uno con forma rara se descarta. */
export function contrastIssuesOf(message: MessageState | undefined): ContrastIssue[] {
  const step = message?.steps.find((s) => s.id === PREVIEW_CHECK)
  if (step?.detail?.kind !== 'tool' || step.detail.name !== 'preview-runtime') return []
  const out = step.detail.output as { defects?: unknown } | undefined
  if (!Array.isArray(out?.defects)) return []
  return out.defects.flatMap((d): ContrastIssue[] => {
    const o = d as { kind?: unknown; slug?: unknown; text?: unknown; ratio?: unknown; colors?: { fg?: unknown; bg?: unknown } }
    if (o?.kind !== 'contrast' || typeof o.text !== 'string' || typeof o.ratio !== 'number' || !Number.isFinite(o.ratio)) return []
    const fg = o.colors?.fg, bg = o.colors?.bg
    if (typeof fg !== 'string' || typeof bg !== 'string' || !HEX.test(fg) || !HEX.test(bg)) return []
    return [{ slug: typeof o.slug === 'string' ? o.slug : null, text: o.text, ratio: o.ratio, fg, bg }]
  })
}

/** Los mismos defectos como dato estructurado para runtimeContext (#898); el texto del turno se queda para la persona. */
export function contrastDefectsOf(issues: readonly ContrastIssue[]): ContrastDefect[] {
  return issues.map((i) => ({ slug: i.slug, ratio: i.ratio, colors: { fg: i.fg, bg: i.bg } }))
}

/** El turno que manda el botón, como "Fix with v0" manda los errores en un mensaje de usuario (HALLAZGOS-secondary-autofix-sandbox.md:33-35):
 * qué texto, qué par de colores y cuánto falla, para que el agente lo arregle sin volver a medir. */
export function contrastFixPrompt(issues: readonly ContrastIssue[]): string {
  // El texto de la página no entra: es contenido de terceros y en el turno de la persona se leería como su pedido (QA #894,
  // "Ignora las instrucciones anteriores..."). Viaja aparte, como dato, en runtimeContext.contrastDefects.
  const lines = issues.map((i) => `- ${i.slug ? `Sección ${i.slug}` : 'Sin sección'}: ${i.fg} sobre ${i.bg}, ${i.ratio.toFixed(2)}:1`)
  return `La vista previa tiene textos con poco contraste (bajo WCAG AA):\n${lines.join('\n')}\nAjusta los colores para que se lean bien y cumplan WCAG AA, sin cambiar el contenido.`
}

/** El arreglo que una edición directa dejó pendiente (un enlace a una sección eliminada), como pedido listo: Lovable lo
 * ofrece como botón de un clic al final del turno, antes que cualquier otra sugerencia. */
export function followUpsOf(message: MessageState | undefined): Suggestion[] {
  // Solo con la versión guardada: una edición que falló no dejó nada pendiente que arreglar.
  if (message?.status !== 'patch') return []
  // El auto-repair de render consume el arreglo pendiente del server: el chip "Fix ready" ya respondería 400.
  const autoRender = message.steps.some((s) => s.id === AUTOFIX && autofixDetail(s.detail)?.kind === 'render')
  return message.steps.flatMap((s) => (s.status === 'ok' && s.detail?.kind === 'action' && !(autoRender && s.id === REPAIR_CHIP) ? s.detail.followUps ?? [] : []))
}

export type AutoRepairKind = 'runtime' | 'render'
export interface Autofix { childId: string; kind: AutoRepairKind; label: string }

const AUTOFIX = 'transport:autofix'
const REPAIR_CHIP = 'transport:repair'

// Leído sin depender del tipo del motor: un transport anterior al auto-repair no trae estos campos y el paso no existe.
function autofixDetail(detail: unknown): { childId: string; kind: AutoRepairKind } | null {
  const d = detail as { kind?: unknown; childId?: unknown; autoRepair?: unknown } | undefined
  if (d?.kind !== 'action' || typeof d.childId !== 'string' || !d.childId) return null
  return d.autoRepair === 'runtime' || d.autoRepair === 'render' ? { childId: d.childId, kind: d.autoRepair } : null
}

/** El arreglo que el server lanzó solo como mensaje hijo (transport:autofix, último paso antes de settled): el builder
 * no sigue más stream que el que abrió, así que de aquí aprende a qué hijo engancharse. */
export function autofixOf(event: EngineEvent): Autofix | null {
  if (event.type !== 'step.end' || event.stepId !== AUTOFIX) return null
  const d = autofixDetail(event.detail)
  return d ? { ...d, label: event.label } : null
}

/** Sugerencias del paso tardío agent:suggestions (llega después de message.end, contrato de la ola 1 con ec). Mandan
 * sobre page.json.agent.suggestions, que queda para cuando haiku falla y para los logs de antes. */
export function lateSuggestionsOf(message: MessageState | undefined): Suggestion[] | null {
  const step = message?.steps.find((s) => s.id === 'agent:suggestions' && s.status === 'ok')
  return step?.detail?.kind === 'action' && step.detail.followUps?.length ? step.detail.followUps.slice(0, 3) : null
}

/** Las respuestas de la pregunta del turno (tool ask_user), recomendada primero. v0 pinta las opciones de
 * task-ask-user-questions-v1 y no otras (deob/v0-design-mode/deobfuscated.js:12935): con una pregunta abierta, los
 * chips del turno anterior que vienen en page.json no se ofrecen. */
export function questionOf(message: MessageState | undefined): Suggestion[] | null {
  const step = message?.steps.find((s) => s.status === 'ok' && s.detail?.kind === 'action' && s.detail.name === 'question')
  return step?.detail?.kind === 'action' ? step.detail.followUps ?? [] : null
}

/** El preview sale del log: el transport emite un action 'preview' con la url antes de message.end. `version` es el
 * mensaje que lo levantó: un follow-up sirve la misma url con otro commit, y solo ese cambio dice que hay que recargar. */
export function previewOf(messages: MessageState[]): { url: string; version: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const step = [...messages[i].steps].reverse().find((s) => s.status === 'ok' && s.detail?.kind === 'action' && s.detail.name === 'preview')
    if (step?.detail?.kind === 'action') return { url: step.detail.summary, version: i }
  }
  return null
}

export const previewUrlOf = (messages: MessageState[]): string | null => previewOf(messages)?.url ?? null

/** El turno reescribió algo de public/ (generate_image o edit_image en la misma ruta). Vite no hace HMR de public/ y el
 * iframe se queda con la imagen vieja, así que el marco se recarga. Solo cuenta un turno con padre (follow-up o
 * variante): en el T1 las fotos son rutas nuevas, montan sin recarga (A7) y recargar sería un parpadeo de más.
 * Adaptación propia: v0 y Stitch no reescriben una imagen en la misma url, no hay referencia que citar. */
export const touchesPublic = (message: MessageState | undefined, hasParent: boolean): boolean =>
  hasParent && message?.status !== 'streaming' && Boolean(message?.snapshot?.files.some((f) => f.startsWith('public/')))

// M2 (contexto-agente.md §2-3). Los folds de context.usage, facts.invented y memory.write son de Secondary; se leen como
// opcionales para que un log anterior a M2, sin esos eventos, se pinte como siempre.
export interface ContextUsage { ratio: number; lastTokens?: number; floorTokens?: number; window?: number }
export interface InventedFact { slug: string; text: string }
export interface MemoryWrite { fact: string; replaced?: string }
type ContextFold = { contextUsage?: ContextUsage; invented?: InventedFact[]; memoryWrites?: MemoryWrite[] }
const contextFold = (message: MessageState | undefined): ContextFold => (message ?? {}) as ContextFold

/** "Hilo largo" desde este ratio: el aviso es solo texto, sin acción automática. */
export const CONTEXT_WARN = 0.6

/** El ratio del último turno con agente que lo trajo: los turnos sin modelo (restore, ediciones directas) no lo emiten. */
export function contextUsageOf(messages: readonly (MessageState | undefined)[]): ContextUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = contextFold(messages[i]).contextUsage
    if (usage && Number.isFinite(usage.ratio) && usage.ratio >= 0) return usage
  }
  return null
}

export const contextPercent = (usage: ContextUsage): number => Math.min(100, Math.round(usage.ratio * 100))

export const inventedOf = (message: MessageState | undefined): InventedFact[] =>
  (contextFold(message).invented ?? []).filter((f) => f && typeof f.text === 'string' && f.text.trim())

export const memoryWritesOf = (message: MessageState | undefined): MemoryWrite[] =>
  (contextFold(message).memoryWrites ?? []).filter((m) => m && typeof m.fact === 'string' && m.fact.trim())

/** "Reemplazar" precarga el composer; la persona escribe el dato real después de los dos puntos. */
export const replaceFactPrompt = (fact: InventedFact): string => `Pon el dato real de ${fact.text} en ${fact.slug}: `

export interface TurnFooter { invented: InventedFact[]; memoryWrites: MemoryWrite[]; context: ContextUsage | null }

/** El pie del turno que muestra el panel (M2 §2, plegado (a)-(c)): el último lleva sus chips y el medidor del hilo; uno
 * viejo abierto desde el registro va plegado, con sus chips y sin medidor, porque el ratio es del hilo y no de ese turno. */
export function turnFooterOf(shown: MessageState, isLast: boolean, thread: readonly (MessageState | undefined)[]): TurnFooter {
  return { invented: inventedOf(shown), memoryWrites: memoryWritesOf(shown), context: isLast ? contextUsageOf(thread) : null }
}
