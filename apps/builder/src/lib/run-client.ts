import { parseEvent, type EngineEvent } from '@engine/runtime/event-model'
import { splitNdjson } from './ndjson'
import type { RuntimeContext, RuntimeError } from './runtime-errors'
import type { ThemeParamsBody } from './theme-draft'
import { apiFetch, isAuthRejection, sessionProblem, sessionProvider } from './session-provider'
import { chatRoutes as R, rootRoutes, type ChatBase } from './chat-routes'
import { formatMB, hostCap, UPLOAD_MAX_BYTES } from './upload-limit'

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type PermissionMode = 'ask' | 'auto'

export interface Upload { url: string; name: string; contentType: string; size: number }
/** Un elemento elegido en el lienzo con su origen en el código: con estos el transport prueba la vía de parche (H5). */
export interface RunElement { source: { file: string; line: number; col: number }; kind: 'text' | 'image'; tagName: string; text: string; src?: string; section?: string }
export interface ImageModel { id: string; name?: string }

/** Subir, bajar, duplicar o quitar una sección sin modelo (transport `sectionOp`). */
export type SectionOp = { op: 'move'; slug: string; to: 'up' | 'down' } | { op: 'remove'; slug: string } | { op: 'duplicate'; slug: string }

export interface RunRequest {
  /** Falta solo en un restore: no hay pedido al modelo. */
  prompt?: string
  model?: string
  messageId: string
  parentId?: string
  /** El motor hereda las del padre si falta; [] las borra. Siempre se manda la lista vigente. */
  instructions?: string[]
  attachments?: Upload[]
  imageGeneration?: { modelId: string }
  /** Presente = razonamiento extendido, como modelConfiguration.thinking/thinkingEffort de v0. */
  thinking?: { effort: ThinkingEffort }
  /** Preferencia de la página, no del mensaje: en v0 es toolConfiguration.webSearch. */
  tools?: { webSearch: boolean }
  /** Apps conectadas (slugs de Pipedream) cuyas herramientas el motor puede usar en esta corrida. */
  connectors?: string[]
  /** Por chat: 'ask' pide aprobación de toda tool de conector; 'auto' deja pasar lecturas, una escritura siempre pregunta. */
  permissionMode?: PermissionMode
  /** Marca del pack para el primer pedido (T1). En un follow-up solo vale la misma de la versión: otra responde 409 (#436). */
  brand?: string
  /** data-wt-slug de las secciones elegidas, como selectedNodeIds de Stitch (DesignPage wakaru l.43216). */
  selectedSections?: string[]
  /** Los elementos del pedido, además de su descripción en el texto, que es lo que lee el agente si el parche no aplica. */
  elements?: RunElement[]
  /** Chip "Plan" del composer (H6, como Add context → Plan de Make): el agente escribe un plan y espera aprobación antes de construir. */
  mode?: 'plan'
  /** Retoma la sesión del padre interrumpido (R2.6): sin prompt, el modelo sigue donde quedó. 409 si ya no se puede. */
  continue?: boolean
  /** Arreglar los errores que el preview-check encontró en la versión padre; el transport arma el pedido con ellos. */
  repair?: 'runtime'
  /** Con repair: los errores del preview vivo que el preview-check no vio (puente del scaffold, #278). */
  runtimeErrors?: RuntimeError[]
  /** Con repair: lo lanza el builder solo, sin clic. El server cuenta uno por versión, el suyo y este juntos. */
  auto?: true
  /** Turnos con modelo: logs, requests y errores del preview vivo que la persona mira (H10, como Lovable). */
  runtimeContext?: RuntimeContext
  /** messageId de la versión a restaurar: commit nuevo con sus archivos, sin modelo. */
  restoreFrom?: string
  /** Lleva el DS del padre al `latest` del registry en una corrida tipo restore, sin modelo (síntesis re-contexto §2.3).
   * 409 si ya está en ese pin. */
  updateDs?: true
  /** La versión pasa a la marca <id> (pack del registry) sin modelo: reescribe la identidad y construye. 409 si ya es esa. */
  applyBrand?: string
  /** "Aplicar" del panel Tema: la marca de la versión con estos params, sin modelo. 422 si no pasan el schema v2 o AA. */
  applyTheme?: ThemeParamsBody
  /** Tamaño del marco que la persona mira al mandar el follow-up (síntesis re-contexto §2.1); el transport lo valida. */
  viewport?: Viewport
  /** Edit Text de Stitch: el texto visible antes y después; el transport lo busca en el código, sin modelo. */
  textEdit?: { before: string; after: string }
  /** Delete de Stitch: el elemento por su texto o su src; el transport lo quita del código, sin modelo. */
  deleteElement?: { kind: 'text'; text: string } | { kind: 'image'; src: string }
  sectionOp?: SectionOp
  /** Cambiar imagen de Stitch: la imagen por su src y la nueva, una URL (Enter URL) o un archivo de POST /uploads. */
  replaceImage?: { src: string; url: string } | { src: string; upload: string }
}

export interface Viewport { width: number; height: number }

/** Las ediciones directas de Stitch: no pasan por el modelo, así que repetirlas con otro modelo no cambia nada. */
export const isDirectEdit = (r: Omit<RunRequest, 'messageId'>): boolean => !!(r.textEdit || r.deleteElement || r.replaceImage || r.sectionOp)

/** Diffstat de una versión contra su padre, como el diffSummary (+N −N) que Make guarda en cada mensaje
 * (MAKE-CHAT:40021-40031); el transport lo calcula por par base..commit y no lo persiste. */
export interface VersionStats { additions: number; deletions: number; files: { path: string; additions: number; deletions: number }[] }

export interface Version {
  messageId: string
  parentId: string | null
  commit: string
  title: string
  at: number | null
  restoreFrom: string | null
  /** Versión hecha por "Actualizar DS": el pin del que venía (falta si no tenía) y el `latest` al que pasó. */
  updatedDs?: { from?: string; to: string } | null
  appliedBrand?: { from?: string; to: string } | null
  head: boolean
  /** null cuando la versión no tiene commit padre con el que comparar. */
  stats?: VersionStats | null
}


// El transport responde los errores como {error}: la persona lee el motivo, no el JSON. Un rechazo de sesión (401/403
// con code) sale con el copy de session.ts, el mismo en todas las rutas.
async function errorText(res: Response): Promise<string> {
  const raw = await res.text()
  try {
    const body = JSON.parse(raw) as { error?: unknown; code?: unknown }
    const problem = sessionProblem(res.status, body)
    if (problem) return problem.message
    // El orquestador contesta 404/405 de su allowlist solo con code (spec §1.2): sin esto la persona leería el JSON.
    if (body.code === 'not-found') return 'Este servidor no tiene esa ruta o ese chat.'
    if (body.code === 'method-not-allowed') return 'Este servidor no acepta esa operación.'
    return typeof body.error === 'string' ? body.error : raw
  } catch {
    return raw
  }
}
/** Un 401/403 de sesión lleva el copy de session.ts en cualquier ruta; lo demás, el texto propio de cada llamada. */
const failure = async (res: Response, fallback: string): Promise<string> => (isAuthRejection(res.status) ? errorText(res) : fallback)

// El 409 de updateDs que no es de workspace ocupado es "el DS ya está en <pin>" (transport startUpdateDs).
const DS_CURRENT = /^el DS ya está/

/** Zona IANA del navegador (como user_timezone de Lovable): el agente fecha y agenda en la hora de la persona. */
function browserTimezone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof tz === 'string' && tz ? tz : undefined
  } catch {
    return undefined
  }
}

/** Cuerpo de POST /runs con la zona; sin ella el campo no viaja y el server usa su default. */
export function runBody(body: object): string {
  const timezone = browserTimezone()
  return JSON.stringify(timezone ? { ...body, timezone } : body)
}

export async function startRun(base: ChatBase, req: RunRequest): Promise<string> {
  const res = await apiFetch(R.runs(base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: runBody(req) })
  if (res.status === 409 && req.updateDs && DS_CURRENT.test(await errorText(res.clone()))) throw new Error('El diseño ya usa la última versión del DS.')
  // En una edición directa el 409 dice por qué no se encontró el elemento; en el resto, que el workspace está ocupado.
  if (res.status === 409 || (res.status === 422 && req.sectionOp)) throw new Error(isDirectEdit(req) ? await errorText(res) : 'Ya hay una corrida en curso en este workspace.')
  if (res.status === 429) throw new Error('Ya hay 3 corridas en curso; espera a que termine una.')
  if (res.status === 400 || res.status === 422) throw new Error(`El transport rechazó el pedido: ${await errorText(res)}`)
  // Con status: la primera corrida de un chat recién creado reintenta un 404 con otro chat (chat-start.ts).
  if (res.status === 404) throw new StatusError(404, await errorText(res))
  if (!res.ok) throw new Error(await failure(res, `No se pudo iniciar la corrida (${res.status})`))
  const body = (await res.json()) as { messageId?: unknown }
  return typeof body.messageId === 'string' ? body.messageId : req.messageId
}

/** POST /runs con auto:true desde el puente vivo. Un 409 no es un fallo para la persona: la versión ya tuvo su
 * auto-repair (lo lanzó el server y su hijo ya llegó por transport:autofix), es ella misma un arreglo, o el workspace
 * está ocupado. En los tres casos queda el botón manual; null = no se lanzó nada. */
export async function startAutoRepair(base: ChatBase, req: RunRequest): Promise<string | null> {
  const res = await apiFetch(R.runs(base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: runBody(req) })
  if (res.status === 409) return null
  if (!res.ok) throw new Error(`No se pudo lanzar el arreglo automático (${res.status}): ${await errorText(res)}`)
  const body = (await res.json()) as { messageId?: unknown }
  return typeof body.messageId === 'string' ? body.messageId : req.messageId
}

export interface WorkspaceFile { path: string; content: string }
export interface DiffFile { path: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; patch: string }

async function getJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url)
  // Con status: al recargar, un hilo que da 404 es un chat solo reservado (chat-start adopt), no un error que mostrar.
  if (!res.ok) throw new StatusError(res.status, await failure(res, `${url} respondió ${res.status}`))
  return (await res.json()) as T
}

export const fetchFiles = (base: ChatBase, messageId: string) => getJson<{ commit: string; files: WorkspaceFile[] }>(R.files(base, messageId))

export const fetchDiff = (base: ChatBase, messageId: string) => getJson<{ base: string; head: string; files: DiffFile[] }>(R.diff(base, messageId))

const UPLOAD_ERRORS: Record<number, string> = { 413: `Supera ${formatMB(hostCap(UPLOAD_MAX_BYTES))}`, 415: 'Tipo no admitido' }

/** XHR y no fetch: fetch no informa el progreso de subida, y el anillo del chip lo necesita. */
export function uploadFile(base: ChatBase, file: File, onProgress: (p: number) => void, signal: AbortSignal): Promise<Upload> {
  return sessionProvider().getToken().then((token) => new Promise<Upload>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', R.uploads(base))
    // Multipart es un tipo simple: sin esta cabecera el navegador no hace preflight y la API lo rechaza (guardWrite).
    xhr.setRequestHeader('x-wt-request', '1'); if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status !== 201) return reject(new StatusError(xhr.status, UPLOAD_ERRORS[xhr.status] ?? `Falló la subida (${xhr.status})`))
      try { resolve(JSON.parse(xhr.responseText) as Upload) } catch { reject(new Error('Respuesta de subida inválida')) }
    }
    xhr.onerror = () => reject(new Error('Sin conexión con el transport'))
    xhr.onabort = () => reject(new DOMException('Subida cancelada', 'AbortError'))
    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  }))
}

/** Un mensaje del hilo como lo guarda el transport: `done` dice si su log ya cerró o hay que reengancharlo. */
export interface ThreadMessage { messageId: string; parentId: string | null; prompt: string; model?: string; commit: string | null; brand?: string; at: number | null; done: boolean; continueOf?: string | null; autoRepair?: 'runtime' | 'render'; thinking?: unknown }

/** Una variante del hilo según GET /chats (R3): basta para volver a montar su marco y seguir su log. */
export interface ThreadVariant { messageId: string; groupId: string; sourceId: string; index: number; count: number; title: string; commit: string | null; at: number | null; done: boolean; queued: boolean }

const isThreadVariant = (v: unknown): v is ThreadVariant => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return ['messageId', 'groupId', 'sourceId', 'title'].every((k) => typeof r[k] === 'string' && r[k] !== '')
    && Number.isInteger(r.index) && Number.isInteger(r.count) && typeof r.done === 'boolean' && typeof r.queued === 'boolean'
}

/** Las variantes del hilo, validadas: una entrada rara se descarta sin tirar la rehidratación del resto. */
export const threadVariants = (thread: { variants?: unknown }): ThreadVariant[] =>
  Array.isArray(thread.variants) ? thread.variants.filter(isThreadVariant) : []

/** El hilo entero para rehidratar al recargar; `preview` es la url recién levantada, no la del log. */
export const fetchThread = (base: ChatBase) =>
  getJson<{ chatId: string; messages: ThreadMessage[]; preview: string | null; instructions?: unknown; variants?: unknown; ds?: unknown }>(R.thread(base))

/** Las instructions vigentes del chat (instructions.json del head) que devuelve GET /chats. Viene del transport y se
 * valida: algo que no sea una lista de strings no hidrata nada. */
export function threadInstructions(thread: { instructions?: unknown }): string[] | null {
  const v = thread.instructions
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null
}

export { dsChangeOf, dsStatus, threadDs, type ChatDs } from './chat-ds'

/** Nodo libre del lienzo (imágenes del rail): vive aparte de las versiones, en `.wt/` del workspace (canvas-store.ts). */
export interface CanvasNode { id: string; kind: 'image'; src: string; name: string; x: number; y: number; width: number; height: number }
/** `favorites`: messageIds con estrella (H14); solo viene si hay alguno. */
export interface CanvasDoc { rev: number; nodes: CanvasNode[]; favorites?: string[] }
/** El PUT conserva lo que no viaja: el autosave manda nodes, la estrella manda favorites. */
export type CanvasPut = { rev: number; nodes?: CanvasNode[]; favorites?: string[] }

/** `rev` es el que el PUT tiene que devolver; vacío o inválido llega como `{ rev: 0, nodes: [] }`. */
export const fetchCanvas = (base: ChatBase) => getJson<CanvasDoc>(R.canvas(base))

export const fetchVersions = (base: ChatBase, messageId: string) => getJson<{ versions: Version[] }>(R.versions(base, messageId))

// Conectores: el transport reenvía a companion-apps (Pipedream Connect), cuya llave no puede llegar al navegador.
export interface ConnectorApp { slug: string; name: string; description: string | null; icon: string | null }
export interface ConnectorAccount { id: string; app: string; name: string | null; state: 'connected' | 'reconnect' }

/** 501 connectors-unavailable (orquestador sin puerto, Runtime sin Pipedream desde #887): la UI lo dice en vez de fallar. */
export class NotConnectedError extends Error {}

async function connectorJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init)
  if (res.status === 501 && (await bodyCode(res.clone())) === 'connectors-unavailable') throw new NotConnectedError('Los conectores no están disponibles en este servidor.')
  if (!res.ok) throw new Error(await failure(res, `${url} respondió ${res.status}`))
  return (await res.json()) as T
}

export interface ConnectorAppsPage { apps: ConnectorApp[]; next: string | null }

export const fetchConnectorApps = (api: string, q: string, after?: string) =>
  connectorJson<ConnectorAppsPage & { total: number }>(rootRoutes.connectorApps(api, q, after))

export const fetchConnectorAccounts = (api: string) => connectorJson<{ accounts: ConnectorAccount[] }>(rootRoutes.connectorAccounts(api))

export const connectApp = (api: string, app: string) =>
  connectorJson<{ url: string; expiresAt: string | null }>(rootRoutes.connect(api), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app }),
  })

export const disconnectAccount = (api: string, id: string) =>
  connectorJson<{ ok: boolean }>(rootRoutes.disconnect(api, id), { method: 'DELETE', headers: { 'content-type': 'application/json' } })

export type ApprovalAnswer = 'allow' | 'always' | 'skip' | PlanAnswer
/** Plan mode (plan-mode.md §3): approve, reject con feedback opcional, o edit con el plan entero. Sin "siempre". */
export type PlanAnswer = { decision: 'approve' } | { decision: 'reject'; feedback?: string } | { decision: 'edit'; plan: string }

/** Manda un mensaje al turno en curso de ese workspace (parentId = cualquier mensaje del hilo): entra a ese turno y no
 * abre otro. 'closed' si el turno ya no recibe mensajes: el llamador lo reenvía como mensaje nuevo al terminar. */
export async function steerRun(base: ChatBase, parentId: string, prompt: string, selectedSections?: string[]): Promise<'queued' | 'closed'> {
  const res = await apiFetch(R.runs(base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: runBody({ prompt, parentId, steer: true, ...(selectedSections?.length ? { selectedSections } : {}) }) })
  if (res.status === 409) return 'closed'
  if (!res.ok) throw new Error(res.status === 429 ? await errorText(res) : await failure(res, `No se pudo enviar el mensaje (${res.status})`))
  return 'queued'
}

/** Detiene la corrida de ese mensaje; el transport cierra con finishReason 'stopped' y lo escrito queda como versión. */
/** El pedido de variantes de una versión (S5, 6f08d0d): la cantidad y las opciones del panel de Stitch como dato; el
 * transport arma el prompt y bifurca un chat por variante. */
export interface VariantsRequest {
  sourceId: string
  count: number
  creativeRange?: 'refine' | 'medium' | 'yolo'
  aspects?: string[]
  customInstructions?: string
  model?: string
  imageGeneration?: { modelId: string }
  thinking?: { effort: ThinkingEffort }
}
export interface VariantsStarted { groupId: string; sourceId: string; variants: { messageId: string; index: number }[] }

export async function startVariants(base: ChatBase, req: VariantsRequest): Promise<VariantsStarted> {
  const { model, imageGeneration, thinking, ...variants } = req
  const body = { variants, ...(model ? { model } : {}), ...(imageGeneration ? { imageGeneration } : {}), ...(thinking ? { thinking } : {}) }
  const res = await apiFetch(R.runs(base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: runBody(body) })
  if (res.status === 400 || res.status === 409 || res.status === 422) throw new Error(`El transport rechazó las variantes: ${await errorText(res)}`)
  if (!res.ok) throw new Error(await failure(res, `No se pudieron iniciar las variantes (${res.status})`))
  const out = (await res.json()) as Partial<VariantsStarted>
  if (typeof out.groupId !== 'string' || !Array.isArray(out.variants) || !out.variants.every((v) => typeof v?.messageId === 'string' && Number.isInteger(v?.index)))
    throw new Error('El transport respondió las variantes sin groupId o sin ids')
  return { groupId: out.groupId, sourceId: typeof out.sourceId === 'string' ? out.sourceId : req.sourceId, variants: out.variants }
}

export async function cancelVariants(base: ChatBase, groupId: string): Promise<void> {
  const res = await apiFetch(R.variantCancel(base, groupId), { method: 'POST', headers: { 'content-type': 'application/json' } })
  // 404: el grupo ya no existe en el transport (reinicio); no queda nada que detener.
  if (res.status === 404 || res.status === 409) return
  if (!res.ok) throw new Error(await failure(res, `No se pudieron detener las variantes (${res.status})`))
}

export async function cancelRun(base: ChatBase, messageId: string): Promise<void> {
  const res = await apiFetch(R.cancel(base, messageId), { method: 'POST', headers: { 'content-type': 'application/json' } })
  // 409: ya había terminado; no hay nada que detener.
  if (res.status === 409) return
  if (!res.ok) throw new Error(await failure(res, `No se pudo detener la corrida (${res.status})`))
}

/** La decisión entra al turno que espera; el approval.decision llega por el stream. `chatId` es cualquier messageId del hilo. */
export type PreviewStatus = 'live' | 'dist' | 'absent'
/** `url`: la url estable del chat (ADR 0013 §3), absoluta y del origen del transport. No se arma con `api`: en vivo es
 * /api detrás del proxy del builder y el preview quedaría en el origen del builder, con acceso a su DOM. */
/** `previewToken`: solo para un ws del dueño con el gate encendido (identidad-sesion.md §9); va como ?wt_preview= al montar. */
export interface PreviewState { status: PreviewStatus; version: string | null; url?: string; previewToken?: string }

const isHttpUrl = (u: unknown): boolean => {
  try { return typeof u === 'string' && /^https?:$/.test(new URL(u).protocol) } catch { return false }
}

const isPreviewState = (v: unknown): v is PreviewState => {
  if (typeof v !== 'object' || v === null) return false
  const { status, version } = v as Record<string, unknown>
  const { url, previewToken } = v as Record<string, unknown>
  return (status === 'live' || status === 'dist' || status === 'absent') && (version === null || typeof version === 'string') && (url === undefined || isHttpUrl(url))
    && (previewToken === undefined || (typeof previewToken === 'string' && previewToken.length > 0))
}

/** POST /preview/heartbeat (contrato R5 con Secondary). Lanza con `status` para que el llamador distinga el 404. */
export async function previewHeartbeat(base: ChatBase, visible: string[], signal?: AbortSignal): Promise<Record<string, PreviewState>> {
  const res = await apiFetch(R.heartbeat(base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visible }), signal })
  if (!res.ok) throw Object.assign(new Error(`latido del preview (${res.status})`), { status: res.status })
  const body: unknown = await res.json()
  const states = typeof body === 'object' && body !== null ? (body as { states?: unknown }).states : undefined
  if (typeof states !== 'object' || states === null) throw new Error('latido del preview: respuesta sin states')
  return Object.fromEntries(Object.entries(states).filter(([, s]) => isPreviewState(s))) as Record<string, PreviewState>
}

/** "Preguntar cada vez" de Lovable (app-lazy-surfaces-DDSyLDbh :1846-1855): quita el "siempre" de una tool de gasto.
 * Es global como el Set del transport (approvals.ts:79). Firma propuesta a ec; 404 = transport sin el endpoint. */
export async function revokeAlways(api: string, toolName: string): Promise<void> {
  const res = await apiFetch(rootRoutes.always(api, toolName), { method: 'DELETE', headers: { 'content-type': 'application/json' } })
  if (res.status === 404) throw new Error('Este servidor todavía no puede volver a preguntar.')
  if (!res.ok) throw new Error(await failure(res, `No se pudo cambiar el permiso (${res.status})`))
}

/** El status (y el `code` de details, si el transport lo manda) viaja con el error y no en el texto: la tarjeta del plan
 * distingue "otra construcción en curso" (409 workspace-busy, 429) de un 409 que reintentar no arregla. */
export class StatusError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    if (code) this.code = code
  }
}

const bodyCode = async (res: Response): Promise<string | undefined> => {
  const body = (await res.json().catch(() => null)) as { code?: unknown } | null
  return typeof body?.code === 'string' ? body.code : undefined
}

/** `messageId`: un reject con feedback abre un mensaje nuevo en plan, hijo del plan rechazado (plan-mode.md §3). */
export interface DecisionResult { messageId?: string }

/** La tarjeta de una tool de conector tal como la registró el orquestador (spec §8.1): es lo único que se pinta. El evento de la
 * VM solo dice que hay una tarjeta; tool, argumentos y patrones salen de aquí, con los que se acuña el permiso. */
export interface ApprovalRecord {
  callId: string
  tool: string
  patterns: string[]
  /** Vacío = la tarjeta no ofrece "Permitir siempre" (v0 :35925-35955 tampoco lo muestra sin patrón recordable). */
  rememberPatterns: string[]
  input: unknown
  expiresAt: number
  decision?: 'allow' | 'always' | 'skip'
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** GET ${base}/approvals/:callId. 404 = sin registro vigente (vencido, o un servidor que todavía no lo expone): la tarjeta no se puede
 * decidir y lo dice, en vez de caer al evento de la VM. */
export async function fetchApproval(base: ChatBase, callId: string, signal?: AbortSignal): Promise<ApprovalRecord> {
  const res = await apiFetch(R.approval(base, callId), { signal })
  if (res.status === 404) throw new StatusError(404, 'No disponible: este servidor no tiene el registro de esta aprobación.')
  if (!res.ok) throw new StatusError(res.status, await failure(res, 'No se pudo leer la aprobación. Intenta de nuevo.'))
  const b = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!b || typeof b.tool !== 'string' || !strings(b.patterns) || !strings(b.rememberPatterns) || typeof b.expiresAt !== 'number') throw new Error('Respuesta de la aprobación incompleta')
  const decision = b.decision === 'allow' || b.decision === 'always' || b.decision === 'skip' ? b.decision : undefined
  return { callId, tool: b.tool, patterns: b.patterns, rememberPatterns: b.rememberPatterns, input: b.input, expiresAt: b.expiresAt, ...(decision ? { decision } : {}) }
}

export async function decideApproval(base: ChatBase, callId: string, decision: ApprovalAnswer): Promise<DecisionResult> {
  const res = await apiFetch(R.approval(base, callId), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(typeof decision === 'string' ? { decision } : decision),
  })
  if (res.status === 409) {
    const code = await bodyCode(res)
    throw new StatusError(409, code === 'already-decided' ? 'Ya decidida: esta aprobación se respondió antes.' : 'Ya no espera tu decisión.', code)
  }
  // Una tool de gasto pide el scope `spend` para aprobarse (§8.1.5): el motivo lo da el servidor, no un "intenta de nuevo".
  if (res.status === 403) throw new StatusError(403, await failure(res, 'No tienes permiso para aprobar esta acción.'))
  if (res.status === 404) throw new StatusError(404, 'Este servidor no tiene aprobaciones.')
  if (!res.ok) throw new StatusError(res.status, 'No se pudo enviar la decisión. Intenta de nuevo.')
  const body = (await res.json().catch(() => null)) as { messageId?: unknown } | null
  return typeof body?.messageId === 'string' && body.messageId ? { messageId: body.messageId } : {}
}

/** POST /prompt-enhancements (H19): el texto mejorado llega en chunks text/plain; `onText` recibe lo acumulado para
 * pintarlo mientras escribe, como usePromptPreview de Stitch. Abortar `signal` es el "cancelar" del enhancer. */
export async function enhancePrompt(base: ChatBase, prompt: string, onText: (text: string) => void, signal: AbortSignal): Promise<string> {
  const res = await apiFetch(R.enhance(base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }), signal })
  if (res.status === 404) throw new StatusError(404, 'Este servidor todavía no mejora prompts.')
  if (res.status === 429) throw new Error('Ya hay una mejora en curso.')
  if (!res.ok) throw new Error(`No se pudo mejorar el prompt (${res.status}): ${await errorText(res)}`)
  if (!res.body) { const text = await res.text(); onText(text); return text }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let text = ''
  for (let c = await reader.read(); !c.done; c = await reader.read()) { text += c.value; onText(text) }
  return text
}

export interface PlanText { plan: string; edited?: boolean }

/** El plan vigente (`.wt/plans/<messageId>.md`): con un PUT de borrador, ese borrador y `edited`. Manda sobre el
 * input.plan del evento, que es el plan tal como lo escribió el agente y no sobrevive una edición al recargar. */
export async function fetchPlan(base: ChatBase, messageId: string, signal?: AbortSignal): Promise<PlanText> {
  const res = await apiFetch(R.plan(base, messageId), { signal })
  if (res.status === 404) throw new Error('El plan todavía no está disponible.')
  if (!res.ok) throw new StatusError(res.status, 'No se pudo leer el plan. Intenta de nuevo.')
  const body = (await res.json()) as { plan?: unknown; edited?: unknown }
  if (typeof body.plan !== 'string') throw new Error('Respuesta del plan sin texto')
  return { plan: body.plan, ...(body.edited === true ? { edited: true } : {}) }
}

/** Como /api/chat/transcribe de v0: el audio entero en multipart y una sola respuesta {text}. */
export async function transcribe(base: ChatBase, audio: Blob): Promise<string> {
  const form = new FormData()
  form.append('file', audio, audio.type.includes('mp4') ? 'recording.mp4' : 'recording.webm')
  const res = await apiFetch(R.transcribe(base), { method: 'POST', headers: { 'x-wt-request': '1' }, body: form })
  if (res.status === 404) throw new StatusError(404, 'La transcripción todavía no está conectada en el transport.')
  if (!res.ok) throw new Error(await failure(res, `No se pudo transcribir (${res.status})`))
  const body = (await res.json()) as { text?: unknown }
  if (typeof body.text !== 'string') throw new Error('Respuesta de transcripción inválida')
  return body.text
}

export const fetchImageModels = (api: string) => getJson<{ models: ImageModel[] }>(rootRoutes.imageModels(api))
/** Lo que el panel de Tema pinta de una marca (BrandSummary del transport). `preset`: acento del contrato, sin hex. */
export interface BrandSummary { id: string; name: string; accent?: string; preset?: string; background?: string; foreground?: string; fonts?: { display?: string; body?: string }; logoSrc?: string; error?: string }
export const fetchBrands = (base: ChatBase) => getJson<{ brands: string[]; items: BrandSummary[] }>(R.brands(base))
/** Instrucciones de la marca (#444): valen para toda página de esa marca; las del chat mandan si chocan. */
export const fetchBrandInstructions = (base: ChatBase, id: string) =>
  getJson<{ instructions: string[] }>(R.brandInstructions(base, id)).then((r) => r.instructions)
/** PUT reemplaza la lista entera. Devuelve la que guardó el transport, que valida con los topes de las del chat. */
export async function saveBrandInstructions(base: ChatBase, id: string, instructions: string[]): Promise<string[]> {
  const res = await apiFetch(R.brandInstructions(base, id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instructions }) })
  if (!res.ok) throw new StatusError(res.status, await errorText(res))
  return ((await res.json()) as { instructions: string[] }).instructions
}
/** Memoria de la marca (contexto-agente.md §1): `memory.md` en texto, una línea por hecho. La escribe el agente con
 * `remember`; la persona la corrige. PUT reemplaza el archivo y el transport valida los topes (40 líneas, 4 KiB). */
// 404 = la marca todavía no tiene memory.md: es memoria vacía, no un error que mostrar.
export async function fetchBrandMemory(base: ChatBase, id: string): Promise<string> {
  const res = await apiFetch(R.brandMemory(base, id))
  if (res.status === 404) return ''
  if (!res.ok) throw new Error(await failure(res, `No se pudo leer la memoria de la marca (${res.status})`))
  const body = (await res.json()) as { text?: unknown }
  return typeof body.text === 'string' ? body.text : ''
}
export async function saveBrandMemory(base: ChatBase, id: string, text: string): Promise<string> {
  const res = await apiFetch(R.brandMemory(base, id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!res.ok) throw new StatusError(res.status, await errorText(res))
  return ((await res.json()) as { text: string }).text
}
export type ExportFormat = 'source' | 'site' | 'design-md' | 'brief' | 'page'
/** Los que se descargan; `page` (HTML en un archivo) se copia al clipboard, no se baja. */
export const EXPORT_FORMATS: Exclude<ExportFormat, 'page'>[] = ['source', 'site', 'design-md', 'brief']
/** Descarga de una versión: el transport responde el archivo con Content-Disposition (H9). */
export const exportUrl = (base: ChatBase, messageId: string, format: ExportFormat) => R.export(base, messageId, format)
export interface ExportAvailability { commit: string; formats: Record<ExportFormat, boolean> }
/** Qué formatos tiene la versión, para no enlazar a un 404: un <a download> no deja atrapar el error. */
export async function fetchExportFormats(base: ChatBase, messageId: string): Promise<ExportAvailability> {
  const res = await apiFetch(R.export(base, messageId))
  if (!res.ok) throw new Error(await errorText(res))
  return (await res.json()) as ExportAvailability
}
/** Códigos estables del gate (publish-check-local.md §3); la UI los muestra tal cual con su archivo. */
export interface PublishIssue { code: string; path?: string; detail?: string }
/** Veredicto de GET /runs/:id/publishable (H1). `unavailable`: un transport sin la ruta, Publicar queda como antes. */
export type PublishGate =
  | { state: 'unavailable' }
  | { state: 'no-build' }
  | { state: 'no-version'; message: string }
  | { state: 'ok'; files: number; bytes: number; externalOrigins: string[] }
  | { state: 'blocked'; errors: PublishIssue[]; files: number; bytes: number }
  | { state: 'error'; message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** Respuesta → estado, sin fetch: el contrato vive en la spec y es lo que se testea. */
/** Export y publish comparten el 409 not-at-commit (#694): el ws no está en el commit de esa versión. */
export const NOT_AT_COMMIT_PUBLISH = 'Solo se puede publicar la última versión de este chat.'

export function publishGate(status: number, body: unknown): PublishGate {
  const b = isRecord(body) ? body : {}
  const message = typeof b.error === 'string' ? b.error : `HTTP ${status}`
  // El router responde 'ruta desconocida' a una ruta que no existe; un 404 del mensaje trae otro texto.
  if (status === 404 && b.error === 'ruta desconocida') return { state: 'unavailable' }
  if (status === 409 && b.code === 'not-at-commit') return { state: 'no-version', message: NOT_AT_COMMIT_PUBLISH }
  if (status === 409) return b.code === 'no-build' ? { state: 'no-build' } : { state: 'no-version', message }
  if (status !== 200) return { state: 'error', message }
  const files = num(b.files)
  const bytes = num(b.bytes)
  if (b.ok === true) return { state: 'ok', files, bytes, externalOrigins: Array.isArray(b.externalOrigins) ? b.externalOrigins.filter((o): o is string => typeof o === 'string') : [] }
  const errors = (Array.isArray(b.errors) ? b.errors : []).filter(isRecord).filter((e) => typeof e.code === 'string')
    .map((e): PublishIssue => ({ code: e.code as string, ...(typeof e.path === 'string' ? { path: e.path } : {}), ...(typeof e.detail === 'string' ? { detail: e.detail } : {}) }))
  return { state: 'blocked', errors, files, bytes }
}

/** Desenlace de POST /runs/:id/publish (run-reads.publishRun). 501: no hay provider en este servidor. */
export type PublishOutcome =
  | { state: 'published'; url: string; files: number; bytes: number }
  | { state: 'disabled' }
  | { state: 'no-build' }
  | { state: 'blocked'; errors: PublishIssue[] }
  | { state: 'error'; message: string }

export function publishOutcome(status: number, body: unknown): PublishOutcome {
  const b = isRecord(body) ? body : {}
  const message = typeof b.error === 'string' ? b.error : `HTTP ${status}`
  if (status === 501) return { state: 'disabled' }
  if (status === 409 && b.code === 'no-build') return { state: 'no-build' }
  if (status === 409 && b.code === 'not-at-commit') return { state: 'error', message: NOT_AT_COMMIT_PUBLISH }
  if (status === 409 && b.code === 'not-publishable') {
    const gate = publishGate(200, { ok: false, errors: b.errors })
    return { state: 'blocked', errors: gate.state === 'blocked' ? gate.errors : [] }
  }
  if (status === 200 && typeof b.url === 'string' && b.url) return { state: 'published', url: b.url, files: num(b.files), bytes: num(b.bytes) }
  return { state: 'error', message }
}

export async function publishVersion(base: ChatBase, messageId: string): Promise<PublishOutcome> {
  // content-type JSON: el router exige una escritura no simple (requireNonSimple).
  const res = await apiFetch(R.publish(base, messageId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const raw = await res.text()
  let body: unknown = null
  try { body = JSON.parse(raw) } catch { body = { error: raw } }
  return publishOutcome(res.status, body)
}

/** La página de la versión como un solo HTML autocontenido (CSS, JS e imágenes inline). */
export async function fetchPageHtml(base: ChatBase, messageId: string): Promise<string> {
  const res = await apiFetch(exportUrl(base, messageId, 'page'))
  if (!res.ok) throw new Error(await errorText(res))
  return res.text()
}
/** Modelos del agente que anuncia el transport; vacío en local, donde el builder usa su propia lista. */
/** `capabilities.transcribe`: el transport tiene /transcribe. Ausente = no (un transport viejo daría 404/415). */
export interface TransportCapabilities { transcribe?: boolean }
export const fetchModels = (api: string) => getJson<{ models: ImageModel[]; capabilities?: TransportCapabilities }>(rootRoutes.models(api))

/** POST /chats (spec §3.1): el id del chat nuevo, que es también el messageId de su primera corrida. */
export async function createChat(api: string): Promise<string> {
  const res = await apiFetch(rootRoutes.chats(api), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  if (res.status === 429) throw new Error('Demasiados chats nuevos seguidos; espera un minuto.')
  if (!res.ok) throw new Error(await failure(res, res.status === 409 ? 'Llegaste al tope de chats.' : `No se pudo crear el chat (${res.status})`))
  const body = (await res.json()) as { chatId?: unknown }
  if (typeof body.chatId !== 'string' || !body.chatId) throw new Error('El servidor creó el chat sin id')
  return body.chatId
}

// Backoff de Stitch: Um = [1000, 2000, 4000, 8000, 16000, 30000] (transport/deob/I18nStore.js:13547), sin tope de
// intentos: el último se repite (:13880) y el contador vuelve a 0 cuando el stream avanza (:13949, :13954).
export const RETRY_MS = [1000, 2000, 4000, 8000, 16000, 30000]
export const retryDelay = (failures: number): number => RETRY_MS[Math.min(Math.max(failures, 1), RETRY_MS.length) - 1]
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = window.setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { window.clearTimeout(t); resolve() }, { once: true })
  })

// settled cierra toda corrida (ola 1): después de message.end y snapshot todavía llegan el preview-check y las sugerencias.
const isTerminal = (e: EngineEvent) => e.type === 'settled'

// Sin bytes en este tiempo se reconecta desde el cursor. Si el transport se reinicia detrás del proxy de Vite,
// la conexión del navegador queda abierta sin datos para siempre; reconectar es barato porque el cursor evita repetir.
const IDLE_MS = 30_000

export interface StreamOptions {
  /** true mientras espera para reconectar después de un corte; false cuando el stream vuelve a traer eventos. */
  onReconnecting?: (on: boolean) => void
  /** La espera entre intentos; los tests la reemplazan. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Lee el log de una corrida y reconecta desde el último seq si el stream se corta, como el resume de v0, con el
 * backoff de Stitch y sin rendirse salvo un error que no se arregla reintentando (4xx). Resuelve con `settled`: false
 * cuando el servidor cerró un log que ya tenía message.end y nunca mandó settled (recover, bld §1). */
export async function streamRun(base: ChatBase, messageId: string, onEvent: (e: EngineEvent) => void, signal: AbortSignal, opts: StreamOptions = {}): Promise<{ settled: boolean }> {
  const wait = opts.wait ?? sleep
  let cursor = -1
  let closed = false
  // Un plan pendiente (plan-mode.md §3-5) cierra su turno con message.end y settled, pero la decisión, la cancelación y la
  // fase build se agregan después al mismo log: mientras haya uno sin decidir, ni el cierre ni el settled terminan la lectura.
  const pendingPlans = new Set<string>()
  let failures = 0
  let reconnecting = false
  const setReconnecting = (on: boolean) => {
    if (on === reconnecting) return
    reconnecting = on
    opts.onReconnecting?.(on)
  }
  while (!signal.aborted) {
    const attempt = new AbortController()
    const stop = () => attempt.abort()
    signal.addEventListener('abort', stop, { once: true })
    let idle = window.setTimeout(stop, IDLE_MS)
    try {
      const res = await apiFetch(R.events(base, messageId, cursor), { signal: attempt.signal })
      if (res.status >= 500) throw new Error(`transport ${res.status}`)
      // 4xx no se arregla reintentando; un 401/403 de sesión dice por qué en vez del status.
      if (!res.ok || !res.body) throw Object.assign(new Error(isAuthRejection(res.status) ? await errorText(res) : `No se pudo leer la corrida (${res.status})`), { fatal: true })
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        window.clearTimeout(idle)
        idle = window.setTimeout(stop, IDLE_MS)
        const { lines, rest } = splitNdjson(buffer + value)
        buffer = rest
        for (const line of lines) {
          const event = parseEvent(JSON.parse(line))
          // Un reintento puede repetir eventos ya vistos si el servidor no respeta el cursor exacto.
          if (event.seq <= cursor) continue
          cursor = event.seq
          failures = 0
          setReconnecting(false)
          if (event.type === 'approval.request' && event.kind === 'plan') pendingPlans.add(event.callId)
          if (event.type === 'approval.decision') pendingPlans.delete(event.callId)
          if (event.type === 'message.start') closed = false
          if (event.type === 'message.end') closed = true
          onEvent(event)
          if (isTerminal(event) && !pendingPlans.size) return { settled: true }
        }
      }
      // El servidor cerró: si el mensaje ya terminó y no habrá snapshot, no hay nada más que leer.
      if (closed) return { settled: false }
      // Cerró sin terminar la corrida: se reintenta con espera para no martillar un transport que corta cada conexión.
      failures += 1
      setReconnecting(true)
      await wait(retryDelay(failures), signal)
    } catch (error) {
      if (signal.aborted) break
      if ((error as { fatal?: boolean }).fatal) throw error
      // Un corte por silencio no es una falla del transport: se reconecta enseguida y no gasta reintentos.
      if (attempt.signal.aborted) continue
      failures += 1
      setReconnecting(true)
      await wait(retryDelay(failures), signal)
    } finally {
      window.clearTimeout(idle)
      signal.removeEventListener('abort', stop)
    }
  }
  return { settled: false }
}

// Escritura del lienzo del chat (imágenes sueltas del rail, transport canvas-store.ts); la lectura es fetchCanvas.
/** Guarda con el rev leído; si otra pestaña escribió antes, devuelve el documento actual en `conflict`. */
export async function putCanvas(base: ChatBase, doc: CanvasPut): Promise<{ saved: CanvasDoc } | { conflict: CanvasDoc }> {
  const res = await apiFetch(R.canvas(base), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })
  if (res.status === 409) return { conflict: ((await res.json()) as { current: CanvasDoc }).current }
  if (!res.ok) throw new Error(await errorText(res))
  return { saved: (await res.json()) as CanvasDoc }
}

/** Sube los bytes de una imagen al lienzo del chat; el server la nombra por su contenido. */
export async function uploadCanvasFile(base: ChatBase, file: File): Promise<{ src: string }> {
  const res = await apiFetch(R.canvasUpload(base, file.name), { method: 'POST', headers: { 'content-type': file.type }, body: file })
  if (!res.ok) throw new Error(await errorText(res))
  return (await res.json()) as { src: string }
}
