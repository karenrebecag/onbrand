import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyEvent, emptyMessage, type EngineEvent, type MessageState } from '@engine/runtime/event-model'
import { fixtureEvents, fixturePrompt } from '@/fixtures/run'
import { workspaceFiles } from '@/fixtures/workspace'
import { fixtureAccounts, fixtureApps } from '@/fixtures/connectors'
import { usePreviewHeartbeat } from './preview-heartbeat'
import { cancelRun, cancelVariants as cancelVariantsRun, steerRun, decideApproval, revokeAlways, fetchBrands, fetchCanvas, fetchDiff, fetchFiles, fetchImageModels, fetchModels, fetchThread, fetchVersions, isDirectEdit, threadDs, type ChatDs, startAutoRepair, startRun, startVariants, StatusError, streamRun, threadInstructions, threadVariants, uploadFile, type ApprovalAnswer, type BrandSummary, type CanvasDoc, type ConnectorAccount, type ConnectorAppsPage, type DiffFile, type ImageModel, type PermissionMode, type RunElement, type RunRequest, type ThreadMessage, type ThinkingEffort, type Upload, type VariantsRequest, type Version, type Viewport, type WorkspaceFile } from './run-client'
import { groupsFromThread, type VariantGroup, type VariantRun } from './variant-layout'
import { chatBase } from './chat-routes'
import { useChatBase, useOwnerCalls, type OwnerCall } from './chat-start'
import { shotPath, useMediaUrls, type MediaUrls } from './media-urls'
import { useReplay } from './replay'
import { newRuntimeErrors, runtimeContextOf, usePreviewRuntime, withContrastDefects, type ContrastDefect, type RuntimeContext, type RuntimeError } from './runtime-errors'
import { autofixOf, cancelPendingPlan, rejectPlanLocally, endFlagsOf, previewIssueMessages, previewOf, touchesPublic, type Autofix, type AutoRepairKind } from './run-state'
import { chatFromUrl, parentAfter, threadThinking } from './thread'
import type { ThemeParamsBody } from './theme-draft'

const THREAD_LOST = 'No se pudo cargar el historial de este chat. Recarga la página para seguir'

export interface Turn {
  messageId: string
  prompt: string
  state: MessageState
  /** Tiempo de la corrida según los `at` del log. */
  elapsedMs: number
  /** El pedido tal como salió, para que Run again repita lo mismo (un restore sigue siendo restore). */
  request: TurnRequest
  /** Llegó settled: el cierre de la corrida, después de las sugerencias y la revisión del preview. */
  settled?: boolean
  /** El stream se cortó y espera para reconectar; la corrida sigue en el transport, no es un error. */
  reconnecting?: boolean
  /** Arreglo que lanzó el sistema y no la persona: se pinta como estado "Arreglando…", no como pedido suyo. */
  auto?: AutoRepairKind
  /** El Runtime dijo al cargar el hilo que su log ya cerró (`done`). Mientras se replega desde emptyMessage() su estado pasa por
   * 'streaming', y eso no es un turno vivo: un mensaje mandado ahí salía como steer y volvía con 409. */
  closed?: boolean
}

export const CONTINUE_PROMPT = 'Continuar'

/** El turno que de verdad corre en el Runtime: en curso según su log y no cerrado según el hilo. */
export const liveTurn = (turns: readonly Turn[]): Turn | undefined => turns.findLast((t) => !t.closed && t.state.status === 'streaming')

/** Un mensaje de GET /chats como turno, antes de replegar su log. */
export function turnFromThread(m: ThreadMessage): Turn {
  const prompt = m.continueOf ? m.prompt || CONTINUE_PROMPT : m.prompt
  const auto = m.autoRepair === 'runtime' || m.autoRepair === 'render' ? { auto: m.autoRepair } : {}
  const thinking = threadThinking(m.thinking)
  return {
    messageId: m.messageId, prompt, state: emptyMessage(), elapsedMs: 0,
    request: { prompt, ...(m.model ? { model: m.model } : {}), ...(m.continueOf ? { continue: true } : {}), ...(m.brand ? { brand: m.brand } : {}), ...(thinking ? { thinking } : {}) },
    ...auto, ...(m.done ? { closed: true } : {}),
  }
}

/** Reject con feedback (plan-mode.md §3): el plan queda rechazado con la nota a la vista y el transport abre un mensaje
 * nuevo en plan, hijo del rechazado, con prompt = feedback. Entra al hilo como un turno en plan enviado por la persona;
 * sin `messageId` (transport anterior o reject sin nota) solo cambia la tarjeta. */
export function rejectWithFollowUp(turns: readonly Turn[], target: string, callId: string, feedback: string | undefined, messageId: string | undefined): Turn[] {
  const plan = turns.find((t) => t.messageId === target)
  const note = feedback?.trim()
  const patched = turns.map((t) => (t.messageId === target ? { ...t, state: rejectPlanLocally(t.state, callId, note) } : t))
  if (!plan || !note || !messageId || turns.some((t) => t.messageId === messageId)) return patched
  const request: TurnRequest = { prompt: note, mode: 'plan', ...(plan.request.model ? { model: plan.request.model } : {}) }
  return [...patched, { messageId, prompt: note, state: emptyMessage(), elapsedMs: 0, request }]
}

/** Run again repite el pedido con el padre vigente; una continuación no tiene pedido propio y el transport la rechaza
 * con 409 (ya se continuó, o el padre vigente no es continuable), así que no se ofrece. */
// Un auto-repair no tiene pedido propio que repetir: si quedó rojo, el botón Arreglar es el reintento.
export const canRestart = (turn: Turn): boolean => !turn.request.continue && !turn.auto

/** Qué ofrece un turno que no terminó bien (R4.3, PROGRAM §R4.3): Continuar si el transport lo marcó continuable,
 * aunque sea un failed con escrituras; Reenviar el pedido si se interrumpió sin poder retomarse (un T1 cortado antes de
 * tener página). Solo el último turno y sin corrida en curso: una continuación ya es un turno posterior, y el 409 del
 * transport cubre el resto. */
/** A qué mensaje va la decisión: al que pidió la aprobación. Desde #563 el transport ubica el plan por ws + callId y el id
 * de la URL fija el workspace; una variante tiene ws propio, así que su aprobación (gasto o plan) solo se encuentra con el
 * id de su mensaje y no con el del chat. */
export function approvalTarget(turns: readonly Turn[], callId: string, chatId: string | undefined): string | undefined {
  return turns.find((t) => t.state.approvals?.some((a) => a.callId === callId))?.messageId ?? chatId
}

export function resumeActionOf(turn: Turn, turns: Turn[], busy: boolean): 'continue' | 'resend' | null {
  if (busy || turn !== turns.at(-1) || turn.state.status === 'streaming') return null
  const { interrupted, continuable } = endFlagsOf(turn.state)
  if (continuable) return 'continue'
  return interrupted ? 'resend' : null
}

export type TurnRequest = Omit<RunRequest, 'messageId' | 'parentId'>

const AUTO_REPAIR_DELAY_MS = 1500
const AUTO_RUNTIME_LABEL = 'Arreglando errores de runtime'

/** Si el último turno puede lanzar el auto-repair de los errores del preview vivo. El tope real lo pone el server (uno
 * por versión, nunca sobre un arreglo); esto evita pedidos que ya se sabe que van a dar 409. Espera a settled porque el
 * server decide su propio auto-repair justo antes, y su hijo llega como turno nuevo. */
export function autoLiveEligible(last: Turn, busy: boolean, committed: string | undefined, tried: ReadonlySet<string>): boolean {
  return !busy && Boolean(last.settled) && committed === last.messageId && !last.auto && !last.request.repair && !tried.has(last.messageId)
}

/** Las instructions solo viajan cuando el panel sabe cuáles son las vigentes: las hidrató el hilo o la persona las
 * guardó en esta vista. Antes, un [] vacío pisaba el `?? inherited` del transport (transport.ts:1495) y las borraba;
 * sin el campo, el transport hereda las del padre. */
export function instructionsToSend(rules: string[], touched: boolean, hydrated: boolean): string[] | undefined {
  return touched || hydrated ? rules : undefined
}

/** Lo que el composer del chat tiene elegido ahora. */
export type ComposerChoice = Pick<TurnRequest, 'model' | 'imageGeneration' | 'thinking'>

/** El esfuerzo viaja siempre que el composer muestra uno: en el composer de Arc el nivel vive en el menú del modelo
 * (composer-parts.tsx:263-307), aparte del chip "Extended thinking" (:220-223), y el transport lo traduce a --effort
 * (src/runtime/agent-loop.ts:175). Con el chip apagado y "High" a la vista, ee252db7 corrió sin --effort. */
export function composerChoice(model: string, imageModelId: string | null, effort: ThinkingEffort): ComposerChoice {
  return { model, ...(imageModelId ? { imageGeneration: { modelId: imageModelId } } : {}), thinking: { effort } }
}

/** Continuar lleva modelo y esfuerzo solo si la persona los eligió en el composer (QA R4.3). Tras recargar el composer
 * arranca en los defaults y mandarlos pisaba los del turno cortado (cierre fila 1, #754): sin elección no van y el
 * transport hereda model y thinking del turno interrumpido. */
export function continueRequest(model: string | undefined, chosen: ThinkingEffort | undefined): TurnRequest {
  return { continue: true, ...(model ? { model } : {}), ...(chosen ? { thinking: { effort: chosen } } : {}) }
}

/** Las variantes corren con el modelo, el modelo de imagen y el razonamiento que el composer tiene elegidos. No salen
 * del último turno: uno de reparación, restore o patch no lleva thinking (A8 en c7c7ec26 corrió en default) y, sin
 * imageGeneration, una variante no puede generar sus fotos (V2 b5a6614e). */
export function variantsRequest(options: VariantOptions, sourceId: string, from: ComposerChoice | undefined): VariantsRequest {
  return {
    ...options,
    sourceId,
    ...(from?.model ? { model: from.model } : {}),
    ...(from?.imageGeneration ? { imageGeneration: from.imageGeneration } : {}),
    ...(from?.thinking ? { thinking: from.thinking } : {}),
  }
}

/** Una variante como turno, para que el panel muestre su chat propio y no el último del hilo principal. */
export function variantTurn(run: VariantRun): Turn {
  const prompt = run.state.variant?.prompt ?? run.state.variant?.title ?? ''
  return { messageId: run.messageId, prompt, state: run.state, elapsedMs: run.elapsedMs ?? 0, request: { prompt }, settled: run.settled }
}

/** Lo que el menú + agrega al pedido, con la forma de POST /runs. */
export interface RunExtras {
  /** Ausente: el transport hereda las del padre. */
  instructions?: string[]
  attachments: Upload[]
  imageModelId: string | null
  /** null = sin razonamiento extendido. */
  thinking: ThinkingEffort | null
  webSearch: boolean
  /** Slugs de las apps conectadas que el motor puede usar. */
  connectors: string[]
  permissionMode: PermissionMode
  /** data-wt-slug de las secciones elegidas en el lienzo o del chip de sección. */
  selectedSections?: string[]
  /** Elementos del lienzo con su origen en el código (vía de parche de Editar con IA). */
  elements?: RunElement[]
  /** Tamaño del marco que la persona mira; solo viaja en un follow-up, que es donde el transport lo usa. */
  viewport?: Viewport
  /** Los defectos del aviso de contraste cuando el turno lo manda su botón: viajan en runtimeContext junto al texto (#898). */
  contrastDefects?: ContrastDefect[]
  /** Chip "Plan": el turno planifica y espera aprobación antes de construir. */
  plan?: boolean
}

export interface Connectors {
  /** Una página del catálogo; `after` es el `next` de la anterior. */
  apps: (q: string, after?: string) => Promise<ConnectorAppsPage>
  accounts: () => Promise<ConnectorAccount[]>
  /** URL de Pipedream Connect para abrir en otra pestaña; la cuenta aparece al volver. */
  connect: (app: string) => Promise<string>
  disconnect: (accountId: string) => Promise<void>
}

export interface Builder {
  /** Base del transport; undefined en el modo de ejemplo. */
  api?: string
  /** El chat (= messageId de su primera corrida); `ownerBase` sirve también antes, con un chat reservado; `media`: imágenes firmadas (§4). */
  chatId?: string
  ownerBase?: OwnerCall
  media?: MediaUrls
  turns: Turn[]
  busy: boolean
  error: string | null
  /** El ?chat= no cargó su hilo ni con el reintento: enviar se bloquea hasta recargar. Sin transport no aplica. */
  threadLost?: boolean
  previewUrl: string | null
  /** Cambia cuando un turno levanta el preview de nuevo, aunque la url sea la misma. */
  previewVersion: number
  /** Remontes del iframe: restauraciones y actualizaciones de DS terminadas (escriben y borran muchos archivos de golpe) y turnos que
   * reescribieron imágenes de public/, que vite no actualiza por HMR. */
  restores: number
  /** Pasos agent:images cerrados: cada uno avisa al preview que aplique los src diferidos (wt-reveal-bridge). */
  imagesReady: number
  files: WorkspaceFile[]
  diff: DiffFile[]
  /** Vacío mientras el motor no tenga un modelo de imagen: el selector se muestra apagado. */
  imageModels: ImageModel[]
  models: ImageModel[]
  /** Solo existe con transport; sin él los adjuntos quedan en la simulación de Arc. */
  upload?: (file: File, onProgress: (p: number) => void, signal: AbortSignal) => Promise<Upload>
  /** undefined: sin transport, el dictado queda en la simulación de Arc. null: el transport no transcribe, sin micrófono. */
  transcribe?: ((audio: Blob) => Promise<string>) | null
  connectors: Connectors
  /** Versiones del workspace (un commit por mensaje), de la más vieja a la actual. */
  versions: Version[]
  /** Las instructions del chat al rehidratar. Sin esto, el primer follow-up después de recargar mandaba [] y borraba
   * las heredadas (C6): el contrato es mandar siempre la lista vigente (run-client RunRequest.instructions). */
  instructions?: string[] | null
  /** C3: DS fijado y el último del registry; null sin registry o sin transport. */
  ds?: ChatDs | null
  send: (prompt: string, model: string, extras: RunExtras) => void
  /** Commit nuevo con los archivos de esa versión; la historia solo avanza, como el restore de v0. */
  restore: (version: Version) => void
  /** Versión nueva con el DS del `latest`, sin modelo; el chat sigue fijado, ahora al pin nuevo. */
  updateDs: () => void
  /** "Aplicar" del panel Tema: versión nueva con la marca vigente y estos params. Solo con transport. */
  applyTheme?: (params: ThemeParamsBody) => Promise<boolean>
  /** Una versión nueva con el texto reemplazado en el código. Resuelve false si no se pudo, para devolver el texto viejo. */
  editText: (before: string, after: string) => Promise<boolean>
  /** Una versión nueva sin el elemento. Resuelve false si no se pudo, para volver a mostrarlo. */
  deleteElement: (target: NonNullable<RunRequest['deleteElement']>, label: string) => Promise<boolean>
  /** Una versión nueva con la imagen cambiada: una URL o un archivo que primero se sube. Resuelve false si no se pudo. */
  replaceImage: (src: string, next: { url: string } | { file: File }) => Promise<boolean>
  sectionOp: (op: NonNullable<RunRequest['sectionOp']>) => Promise<boolean>
  /** Una corrida que arregla los errores del preview de la versión actual (Fix with v0). */
  repair: (issues: number, model: string, runtimeErrors: RuntimeError[]) => void
  /** El builder está por lanzar solo el arreglo de los errores del preview vivo: el botón manual espera. */
  autoPending?: boolean
  /** Repite el pedido de un turno. En vivo es una corrida nueva colgada del último mensaje. */
  retry: (turn: Turn, model: string) => void
  /** URL de una captura que una tool devolvió al agente en ese mensaje. Solo con transport. */
  shotUrl?: (messageId: string, file: string) => string | undefined
  /** Permite u omite una tool que espera dentro del turno. Solo con transport. Lanza con el motivo si no entró. */
  decide?: (callId: string, decision: ApprovalAnswer) => Promise<void>
  /** Url estable por chat (principal y variantes) que trajo el latido del preview; manda sobre la del log. */
  previewUrls?: Record<string, string>
  /** Contador por chat para remontar su iframe cuando el preview cambió de versión o volvió (R4.6). */
  previewRemounts?: Record<string, number>
  /** src con el token de preview del latido para un montaje (preview-access.ts). */
  previewSrc?: (ws: string, slot: string, mountKey: string, url: string) => string
  previewToken?: (ws: string) => string | undefined
  /** Adelanta un latido: un marco que no reporta puede tener el preview caído. */
  pokePreview?: (silentChat?: string) => void
  /** Retoma un turno interrumpido o fallido continuable (R4.3); resuelve false si el transport no lo aceptó. */
  continueTurn?: (turn: Turn, model: string | undefined, chosen: ThinkingEffort | undefined) => Promise<boolean>
  /** Quita el "Permitir siempre" de una tool de gasto en el transport. */
  revoke?: (toolName: string) => Promise<void>
  /** Detiene la corrida en curso; lo que alcanzó a escribir queda como versión. Solo con transport. */
  stop?: () => void
  /** Mensaje con la corrida en curso: entra a ese turno (como Lovable), no abre otro. Si el turno ya no lo recibe, sale
   * como mensaje nuevo al terminar (como la cola de Make) en vez de perderse. Solo con transport. */
  steer?: (prompt: string, model: string, extras: RunExtras) => void
  /** Grupos de variantes de esta sesión (S5): cada variante es un chat propio que el lienzo pone al lado de la fuente.
   * Solo con transport. */
  variants?: VariantGroup[]
  /** N variantes de la versión vigente, con las opciones del panel. Resuelve false si no arrancó. */
  generateVariants?: (options: VariantOptions, from: ComposerChoice | undefined) => Promise<boolean>
  cancelVariant?: (messageId: string) => void
  cancelVariants?: (groupId: string) => void
  /** Lienzo del chat tal como lo guardó el transport; el `rev` es el que exige el próximo PUT. */
  canvas?: CanvasDoc
  setCanvas?: (doc: CanvasDoc) => void
  /** Panel de Tema. Solo con transport: las marcas salen de GET /brands. */
  theme?: Theme
}

export interface Theme {
  /** null mientras carga; [] si no hay marcas o /brands falló. */
  brands: BrandSummary[] | null
  /** Marca de la versión vigente, o la elegida para el primer pedido si todavía no hay chat. */
  current?: string
  /** Hay chat: elegir otra marca ya no fija la del T1, la aplica a la versión vigente (applyBrand, sin modelo). */
  locked: boolean
  /** Una corrida en curso tiene el workspace: el transport respondería 409. */
  busy: boolean
  /** Sin chat, undefined = automática (el transport la detecta del pedido). Con chat, aplica `id`. */
  choose: (id: string | undefined) => void
  /** Pide las marcas si todavía no se pidieron. El selector lo llama al abrirse: sin chat, eso reserva uno (A2). */
  load: () => void
}

/** Lo que elige la persona en el panel de variantes; la fuente la pone el builder (la versión vigente). */
export type VariantOptions = Omit<VariantsRequest, 'sourceId' | 'model' | 'imageGeneration' | 'thinking'>

const brandOfTurn = (t: Turn | undefined): string | undefined => t?.request.applyBrand ?? t?.request.brand

const asAdded = (files: WorkspaceFile[]): DiffFile[] =>
  files.map((f) => {
    const lines = f.content.split('\n')
    return { path: f.path, status: 'added', additions: lines.length, deletions: 0, patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n') }
  })

/** Corridas reales contra el transport. Cada mensaje nuevo cuelga del anterior (parentId), como v0. */
function useLiveBuilder(api: string): Builder {
  const [turns, setTurns] = useState<Turn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [diff, setDiff] = useState<DiffFile[]>([])
  const [imageModels, setImageModels] = useState<ImageModel[]>([])
  const [models, setModels] = useState<ImageModel[]>([])
  const [canTranscribe, setCanTranscribe] = useState(false)
  const [versions, setVersions] = useState<Version[]>([])
  const controllers = useRef<AbortController[]>([])
  useEffect(() => () => controllers.current.forEach((c) => c.abort()), [])
  const { chatId, baseOf, ownerBase, startFirst, settle } = useChatBase(api)
  useEffect(() => {
    fetchImageModels(api).then((r) => setImageModels(r.models)).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    // Un transport anterior a /models da 404: el selector se queda con la lista local.
    fetchModels(api).then((r) => { setModels(r.models); setCanTranscribe(r.capabilities?.transcribe === true) }).catch(() => setModels([]))
  }, [api])

  const patchTurn = useCallback((messageId: string, fn: (t: Turn) => Turn) =>
    setTurns((list) => list.map((t) => (t.messageId === messageId ? fn(t) : t))), [])

  const committed = useRef<string | undefined>(undefined)
  // El ?chat= sigue vigente pero su hilo no cargó: sin padre, un envío iría por startFirst a un chat nuevo y el real quedaría
  // abandonado sin aviso (Arq, #874). Se bloquea hasta recargar; el panel lo lee para no vaciar el borrador.
  const [threadLost, setThreadLost] = useState(false)
  // launch lee el contexto del preview al mandar sin rehacerse con cada log que llega.
  const runtime = useRef<RuntimeContext | undefined>(undefined)
  const loadVersion = useCallback((messageId: string) =>
    Promise.all([fetchFiles(baseOf(), messageId), fetchDiff(baseOf(), messageId), fetchVersions(baseOf(), messageId)])
      .then(([f, d, v]) => { setFiles(f.files); setDiff(d.files); setVersions(v.versions) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))), [baseOf])

  // Ids con turno propio: el paso transport:autofix puede repetirse al reconectar el stream del padre.
  const attached = useRef(new Set<string>())
  // follow y attachAuto se llaman entre sí; el ref corta el ciclo de dependencias de useCallback.
  const attachAuto = useRef<(auto: Autofix, signal: AbortSignal) => void>(() => undefined)

  /** Pliega el log de un mensaje en su turno; true si cerró sin error. Al rehidratar, los mensajes ya cerrados no piden
   * archivos en cada snapshot: solo cuenta el último con versión. */
  const follow = useCallback((messageId: string, signal: AbortSignal, loadOnSnapshot: boolean): Promise<boolean> => {
    let firstAt: number | undefined
    let failed = false
    const onEvent = (event: EngineEvent) => {
      firstAt ??= event.at
      if (event.type === 'error') failed = true
      const start = firstAt
      patchTurn(messageId, (t) => ({ ...t, state: applyEvent(t.state, event), elapsedMs: event.at - start, ...(event.type === 'settled' ? { settled: true } : {}) }))
      committed.current = parentAfter(committed.current, messageId, event)
      if (event.type === 'snapshot' && loadOnSnapshot) void loadVersion(messageId)
      // Al rehidratar un log cerrado el hijo ya viene en GET /chats; solo en vivo hay que abrirle turno.
      const auto = loadOnSnapshot ? autofixOf(event) : null
      if (auto) attachAuto.current(auto, signal)
    }
    const onReconnecting = (on: boolean) => patchTurn(messageId, (t) => ({ ...t, reconnecting: on }))
    return streamRun(baseOf(), messageId, onEvent, signal, { onReconnecting }).then(({ settled }) => {
      // Cerró después de message.end sin settled (recover, bld §1): cuenta como cierre, para que el aviso de lista y
      // ran.current del lienzo no queden esperando un evento que no va a llegar.
      if (!settled && !signal.aborted) patchTurn(messageId, (t) => (t.state.status === 'streaming' ? t : { ...t, settled: true, reconnecting: false }))
      return !failed
    })
  }, [baseOf, patchTurn, loadVersion])
  attachAuto.current = (auto, signal) => {
    if (attached.current.has(auto.childId)) return
    attached.current.add(auto.childId)
    setTurns((list) => [...list, { messageId: auto.childId, prompt: auto.label, state: emptyMessage(), elapsedMs: 0, request: auto.kind === 'runtime' ? { repair: 'runtime' } : {}, auto: auto.kind }])
    void follow(auto.childId, signal, true).catch(() => false)
  }

  // Recargar vuelve al mismo hilo (paso 11 de la QA): el transport devuelve los mensajes y cada log se vuelve a plegar
  // con el mismo applyEvent del stream; el que sigue abierto queda enganchado por events?cursor.
  const [rehydrated, setRehydrated] = useState<{ url: string; version: number } | null>(null)
  const [canvas, setCanvas] = useState<CanvasDoc>({ rev: 0, nodes: [] })
  const [instructions, setInstructions] = useState<string[] | null>(null)
  const [ds, setDs] = useState<ChatDs | null>(null)
  // Los grupos del hilo esperan aquí a que exista followVariant (más abajo) para seguir el log de cada variante.
  const [threadGroups, setThreadGroups] = useState<VariantGroup[] | null>(null)
  useEffect(() => {
    const chat = chatFromUrl(window.location.search)
    if (!chat) return
    const controller = new AbortController()
    controllers.current = [...controllers.current, controller]
    // En paralelo con el hilo: las imágenes del lienzo no son versiones. Si falla, el lienzo queda vacío pero el hilo carga.
    fetchCanvas(chatBase(api, chat)).then((doc) => { if (!controller.signal.aborted) setCanvas(doc) }).catch(() => undefined)
    // Un error que no es 404 (500 transitorio, red) no dice si el chat tiene corridas: se pregunta una vez más antes de decidir.
    const notFound = (e: unknown) => e instanceof StatusError && e.status === 404
    fetchThread(chatBase(api, chat))
      .catch((e: unknown) => {
        if (controller.signal.aborted || notFound(e)) throw e
        return fetchThread(chatBase(api, chat))
      })
      .then(async (thread) => {
        if (!controller.signal.aborted) setThreadLost(false)
        if (!controller.signal.aborted && !settle(chat, thread.messages.length > 0)) return
        thread.messages.forEach((m) => attached.current.add(m.messageId))
        setTurns(thread.messages.map(turnFromThread))
        if (thread.preview) setRehydrated({ url: thread.preview, version: thread.messages.length - 1 })
        setInstructions(threadInstructions(thread))
        setDs(threadDs(thread))
        const groups = groupsFromThread(threadVariants(thread), (id) => thread.messages.find((m) => m.messageId === id)?.commit)
        if (groups.length) setThreadGroups(groups)
        // Los cerrados en orden, para que el padre del próximo envío termine en el último con versión.
        // Un log ilegible deja ese turno vacío, no el hilo entero sin cargar.
        for (const m of thread.messages.filter((x) => x.done)) await follow(m.messageId, controller.signal, false).catch(() => false)
        if (committed.current) void loadVersion(committed.current)
        for (const m of thread.messages.filter((x) => !x.done)) void follow(m.messageId, controller.signal, true)
      })
      .catch((e: unknown) => {
        // Abortado (StrictMode, cambio de chat): el veredicto lo da el fetch que sigue. Solo un 404 lo vuelve reserva: un chat con
        // corridas adoptado como reserva haría que el envío saliera con messageId = chatId, el servidor respondiera 404 (la primera
        // corrida exige que no exista) y el mensaje se fuera a un chat nuevo, dejando el hilo real sin aviso.
        if (controller.signal.aborted) return
        if (notFound(e)) { settle(chat, false); return }
        setThreadLost(true)
        settle(chat, true)
        setError(THREAD_LOST)
      })
    return () => controller.abort()
  }, [api, follow, loadVersion, settle])

  const launch = useCallback((prompt: string, request: TurnRequest, continueOf?: string, contrastDefects?: readonly ContrastDefect[]): Promise<boolean> => {
    // Continuar cuelga del interrumpido aunque no haya dejado versión: es su sesión la que se retoma.
    const parentId = continueOf ?? committed.current
    if (threadLost) {
      setError(THREAD_LOST)
      return Promise.resolve(false)
    }
    // Sin padre es la primera corrida de un chat nuevo, con lienzo vacío: messageId = chatId (spec §3.2); hasta POST /chats el turno
    // lleva un id provisional, como el `pending-` de v0 (HALLAZGOS-frontend-v0.md:87).
    let messageId: string = crypto.randomUUID()
    const controller = new AbortController()
    controllers.current = [...controllers.current, controller]
    setError(null)
    setTurns((list) => [...list, { messageId, prompt, state: emptyMessage(), elapsedMs: 0, request }])
    if (!parentId) setCanvas({ rev: 0, nodes: [] })
    // Solo el turno normal con prompt (contrato con el transport, #435): repair arma su pedido con runtimeErrors propios,
    // continue retoma la sesión sin prompt nuevo, y las ediciones directas no pasan por el modelo.
    const modelTurn = !!request.prompt && !!request.model && !request.repair && !request.continue && !isDirectEdit(request) && !request.restoreFrom && !request.updateDs
    const runtimeContext = modelTurn ? withContrastDefects(runtime.current, contrastDefects) : undefined
    const body = (id: string) => ({ ...request, messageId: id, parentId, ...(runtimeContext ? { runtimeContext } : {}) })
    return (parentId ? startRun(baseOf(), body(messageId)) : startFirst((base, chat) => {
      const provisional = messageId
      messageId = chat
      setTurns((list) => list.map((t) => (t.messageId === provisional ? { ...t, messageId: chat } : t)))
      return startRun(base, body(chat))
    })).then((id) => follow(id, controller.signal, true))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        setError(message)
        patchTurn(messageId, (t) => (t.state.status === 'streaming' ? { ...t, state: { ...t.state, status: 'error', error: { message } } } : t))
        return false
      })
  }, [baseOf, startFirst, patchTurn, follow, threadLost])

  const [pickedBrand, setPickedBrand] = useState<string | undefined>(undefined)
  const [brands, setBrands] = useState<BrandSummary[] | null>(null)
  // A2: /brands cuelga del chat y sin ?chat= pedirlo reserva uno (POST /chats). Una visita que no toca nada no deja un chat vacío
  // en la lista del dueño: se pide al primer gesto que las necesita (abrir el selector), como v0 guarda el borrador local y crea el
  // chat recién al usarlo (deob/v0-layers/deobfuscated.js:34002-34037). Con ?chat= o tras la primera corrida no se reserva nada.
  const [brandsWanted, setBrandsWanted] = useState(() => Boolean(chatFromUrl(window.location.search)))
  const loadBrands = useCallback(() => setBrandsWanted(true), [])
  // Un booleano y no chatId en las deps: pasa a true una sola vez y las marcas no se vuelven a pedir cuando la primera corrida fija el chat.
  const brandsActive = brandsWanted || Boolean(chatId)
  useEffect(() => {
    if (!brandsActive) return
    const controller = new AbortController()
    // Sin marcas el panel lo dice; un /brands caído no tiene que romper el builder.
    ownerBase(fetchBrands).then((r) => { if (!controller.signal.aborted) setBrands(r.items) }).catch(() => { if (!controller.signal.aborted) setBrands([]) })
    return () => controller.abort()
  }, [ownerBase, brandsActive])

  const send = useCallback((prompt: string, model: string, extras: RunExtras) => {
    setTurns((list) => list.map((t) => ({ ...t, state: cancelPendingPlan(t.state) })))
    return launch(prompt, {
    prompt, model,
    instructions: extras.instructions,
    attachments: extras.attachments.length ? extras.attachments : undefined,
    imageGeneration: extras.imageModelId ? { modelId: extras.imageModelId } : undefined,
    thinking: extras.thinking ? { effort: extras.thinking } : undefined,
    tools: { webSearch: extras.webSearch },
    connectors: extras.connectors.length ? extras.connectors : undefined,
    permissionMode: extras.permissionMode,
    selectedSections: extras.selectedSections?.length ? extras.selectedSections : undefined,
    elements: extras.elements?.length ? extras.elements : undefined,
    viewport: committed.current ? extras.viewport : undefined,
    mode: extras.plan ? 'plan' : undefined,
    // Solo el T1 elige marca; un follow-up conserva la de su versión.
    brand: committed.current ? undefined : pickedBrand,
  }, undefined, extras.contrastDefects)
  }, [launch, pickedBrand])

  const repair = useCallback((issues: number, model: string, runtimeErrors: RuntimeError[]) =>
    launch(`Arreglar ${issues} ${issues === 1 ? 'error' : 'errores'}`, { model, repair: 'runtime', ...(runtimeErrors.length ? { runtimeErrors } : {}) }), [launch])

  const restore = useCallback((version: Version) =>
    launch(`Restaurar «${version.title}»`, { restoreFrom: version.messageId }), [launch])

  const updateDs = useCallback(() => void launch('Actualizar DS', { updateDs: true }), [launch])
  const applyTheme = useCallback((params: ThemeParamsBody) => launch('Aplicar tema', { applyTheme: params }), [launch])

  const applyBrand = useCallback((id: string, name: string) => void launch(`Aplicar marca ${name}`, { applyBrand: id }), [launch])

  const editText = useCallback((before: string, after: string) =>
    launch(`Editar texto: «${after}»`, { textEdit: { before, after } }), [launch])

  const deleteElement = useCallback((target: NonNullable<RunRequest['deleteElement']>, label: string) =>
    launch(`Eliminar ${label}`, { deleteElement: target }), [launch])

  const replaceImage = useCallback(async (src: string, next: { url: string } | { file: File }) => {
    if ('url' in next) return launch('Cambiar imagen', { replaceImage: { src, url: next.url } })
    try {
      const up = await uploadFile(baseOf(), next.file, () => undefined, new AbortController().signal)
      return await launch(`Cambiar imagen: ${up.name}`, { replaceImage: { src, upload: up.url } })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [baseOf, launch])

  const sectionOp = useCallback((op: NonNullable<RunRequest['sectionOp']>) =>
    launch(op.op === 'move' ? `${op.to === 'up' ? 'Subir' : 'Bajar'} la sección ${op.slug}` : op.op === 'remove' ? `Eliminar la sección ${op.slug}` : `Duplicar la sección ${op.slug}`, { sectionOp: op }), [launch])

  const [waiting, setWaiting] = useState<{ prompt: string; model: string; extras: RunExtras }[]>([])
  const busy = Boolean(liveTurn(turns))
  // Versiones que ya intentaron su auto-repair desde el builder; el tick re-renderiza al marcar una.
  const autoTried = useRef(new Set<string>())
  const [, setAutoTick] = useState(0)
  // El paso 10 de la QA: lo que quedó del mensaje en vuelo sale apenas termina la corrida, de a uno.
  useEffect(() => {
    if (busy || !waiting.length) return
    const [next, ...rest] = waiting
    setWaiting(rest)
    void send(next.prompt, next.model, next.extras)
  }, [busy, waiting, send])
  // Restore y las ediciones directas no pasan por el modelo: repetirlos con otro modelo no cambia nada.
  const retry = useCallback((turn: Turn, model: string) =>
    void launch(turn.prompt, turn.request.restoreFrom || turn.request.updateDs || turn.request.applyBrand || turn.request.applyTheme || isDirectEdit(turn.request) ? turn.request : { ...turn.request, model }), [launch])
  const continueTurn = useCallback((turn: Turn, model: string | undefined, chosen: ThinkingEffort | undefined) =>
    launch(CONTINUE_PROMPT, continueRequest(model, chosen), turn.messageId), [launch])
  // El pin sale de la versión HEAD: un Actualizar DS o un restore lo cambian, así que se relee con cada HEAD nuevo.
  const headId = versions.find((v) => v.head)?.messageId
  useEffect(() => {
    if (!chatId || !headId) return
    let live = true
    fetchThread(chatBase(api, chatId)).then((t) => { if (live) setDs(threadDs(t)) }).catch(() => undefined)
    return () => { live = false }
  }, [api, chatId, headId])
  const decide = useCallback(async (callId: string, decision: ApprovalAnswer) => {
    const target = approvalTarget(turns, callId, chatId)
    if (!target) throw new Error('No hay chat al que responder.')
    const result = await decideApproval(baseOf(), callId, decision)
    // Aprobado, la fase build corre sobre el mismo messageId (plan-mode.md §4) y su log ya se cerró: se vuelve a plegar
    // desde el principio para seguir la corrida nueva.
    if (typeof decision === 'string') return
    if (decision.decision === 'reject') {
      setTurns((list) => rejectWithFollowUp(list, target, callId, decision.feedback, result.messageId))
      if (!result.messageId || !decision.feedback?.trim()) return
      const controller = new AbortController()
      controllers.current = [...controllers.current, controller]
      void follow(result.messageId, controller.signal, true).catch(() => false)
      return
    }
    const turn = turns.find((t) => t.messageId === target)
    if (!turn) return
    const controller = new AbortController()
    controllers.current = [...controllers.current, controller]
    patchTurn(turn.messageId, (t) => ({ ...t, state: emptyMessage(), elapsedMs: 0, settled: false, closed: false }))
    void follow(turn.messageId, controller.signal, true).catch(() => false)
  }, [baseOf, chatId, turns, patchTurn, follow])
  const revoke = useCallback((toolName: string) => revokeAlways(api, toolName), [api])
  const steer = useCallback((prompt: string, model: string, extras: RunExtras) => {
    const live = liveTurn(turns)
    const later = () => setWaiting((list) => [...list, { prompt, model, extras }])
    if (!live) return later()
    steerRun(baseOf(), live.messageId, prompt, extras.selectedSections)
      .then((r) => { if (r === 'closed') later() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [baseOf, turns])
  const stop = useCallback(() => {
    const live = liveTurn(turns)
    if (live) cancelRun(baseOf(), live.messageId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [baseOf, turns])
  const [variants, setVariants] = useState<VariantGroup[]>([])
  const patchRun = useCallback((groupId: string, messageId: string, fn: (r: VariantRun) => VariantRun) =>
    setVariants((groups) => groups.map((g) => (g.groupId === groupId ? { ...g, runs: g.runs.map((r) => (r.messageId === messageId ? fn(r) : r)) } : g))), [])
  // Cada variante se lee con el mismo /runs/<id>/events que un turno; el grupo no tiene stream propio (contrato S5).
  const followVariant = useCallback((groupId: string, messageId: string) => {
    const controller = new AbortController()
    controllers.current = [...controllers.current, controller]
    streamRun(baseOf(), messageId, (event) => patchRun(groupId, messageId, (r) => {
      const startedAt = r.startedAt ?? event.at
      return { ...r, state: applyEvent(r.state, event), settled: r.settled || event.type === 'settled', startedAt, elapsedMs: event.at - startedAt }
    }), controller.signal)
      .then(({ settled }) => {
        // Mismo cierre sin settled que follow: sin esto el grupo no llega a groupSettled y el pan no ocurre.
        if (!settled && !controller.signal.aborted) patchRun(groupId, messageId, (r) => (r.state.status === 'streaming' ? r : { ...r, settled: true }))
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        // Sin stream no llega su settled: se cierra aquí para que el grupo no espere para siempre el pan.
        patchRun(groupId, messageId, (r) => ({ ...r, settled: true, state: r.state.status === 'streaming' ? { ...r.state, status: 'error', error: { message } } : r.state }))
      })
  }, [baseOf, patchRun])
  // R4.4: al recargar vuelven los marcos de variante del hilo; reproducir su log trae el desenlace de las cerradas y
  // reengancha las que siguen en cola (run.queued) o corriendo.
  useEffect(() => {
    if (!threadGroups) return
    setThreadGroups(null)
    setVariants((current) => [...threadGroups.filter((g) => !current.some((c) => c.groupId === g.groupId)), ...current])
    threadGroups.forEach((g) => g.runs.forEach((r) => followVariant(g.groupId, r.messageId)))
  }, [threadGroups, followVariant])
  const generateVariants = useCallback(async (options: VariantOptions, from: ComposerChoice | undefined) => {
    const sourceId = committed.current
    if (!sourceId) { setError('Todavía no hay una versión de la que sacar variantes.'); return false }
    setError(null)
    try {
      const started = await startVariants(baseOf(), variantsRequest(options, sourceId, from))
      const sourceCommit = versions.find((v) => v.messageId === started.sourceId)?.commit
      setVariants((groups) => [...groups, { groupId: started.groupId, sourceId: started.sourceId, runs: started.variants.map((v) => ({ messageId: v.messageId, index: v.index, state: emptyMessage(), settled: false, ...(sourceCommit ? { sourceCommit } : {}) })) }])
      started.variants.forEach((v) => followVariant(started.groupId, v.messageId))
      return true
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [baseOf, followVariant, versions])
  const cancelVariant = useCallback((messageId: string) => {
    cancelRun(baseOf(), messageId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [baseOf])
  const cancelVariants = useCallback((groupId: string) => {
    cancelVariantsRun(baseOf(), groupId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [baseOf])
  const media = useMediaUrls(chatId ? chatBase(api, chatId) : undefined)
  const shotUrl = useCallback((messageId: string, file: string) => media?.url(shotPath(messageId, file)), [media])
  const { upload, transcribeAudio, connectors } = useOwnerCalls(api, ownerBase)
  const watched = useMemo(() => [...(chatId ? [chatId] : []), ...variants.flatMap((g) => g.runs.map((r) => r.messageId))], [chatId, variants])
  const heartbeat = usePreviewHeartbeat(chatId ? chatBase(api, chatId) : undefined, watched)
  const fromLog = previewOf(turns.map((t) => t.state))
  // La url del log de un hilo rehidratado puede ser de un dev server que ya no existe; manda la recién levantada hasta
  // que un turno nuevo traiga la suya.
  const preview = rehydrated && (fromLog?.version ?? -1) <= rehydrated.version ? rehydrated : fromLog
  const previewUrl = (chatId && heartbeat.urls[chatId]) || (preview?.url ?? null)
  // Misma llave de versión que el botón Arreglar (chat-panel): el último turno.
  const liveRuntime = usePreviewRuntime(previewUrl, turns.at(-1)?.messageId)
  useEffect(() => { runtime.current = runtimeContextOf(liveRuntime) }, [liveRuntime])
  // Errores que solo vio el navegador: el server no los conoce, así que el auto-repair de estos lo lanza el builder.
  const lastTurn = turns.at(-1)
  const liveOnly = lastTurn ? newRuntimeErrors(liveRuntime.runtimeErrors, previewIssueMessages(lastTurn.state)) : []
  const autoTarget = lastTurn && autoLiveEligible(lastTurn, busy, committed.current, autoTried.current) && liveOnly.length ? lastTurn : undefined
  useEffect(() => {
    if (!autoTarget) return
    // El puente manda los errores de a uno mientras la página monta: se espera a que dejen de llegar.
    const timer = setTimeout(() => {
      autoTried.current.add(autoTarget.messageId)
      setAutoTick((n) => n + 1)
      const controller = new AbortController()
      controllers.current = [...controllers.current, controller]
      startAutoRepair(baseOf(), { messageId: crypto.randomUUID(), parentId: autoTarget.messageId, repair: 'runtime', auto: true, runtimeErrors: liveOnly, ...(autoTarget.request.model ? { model: autoTarget.request.model } : {}) })
        .then((id) => { if (id) attachAuto.current({ childId: id, kind: 'runtime', label: AUTO_RUNTIME_LABEL }, controller.signal) })
        // Sin auto-repair queda el botón manual con los mismos errores; el motivo va a consola, no a la persona.
        .catch((e: unknown) => console.warn('[builder] auto-repair', e))
    }, AUTO_REPAIR_DELAY_MS)
    return () => clearTimeout(timer)
    // liveOnly cambia de identidad en cada render; la llave es la versión y cuántos errores hay.
  }, [autoTarget?.messageId, liveOnly.length, baseOf])
  // El primer turno del hilo es el T1, el único sin padre.
  const restores = turns.filter((t, i) => ((t.request.restoreFrom || t.request.updateDs || t.request.applyBrand || t.request.applyTheme) && t.state.status !== 'streaming') || touchesPublic(t.state, i > 0)).length
  // Con error también: el paso cierra en error si alguna imagen faltó, pero las que se generaron ya existen.
  const imagesReady = turns.reduce((n, t) => n + t.state.steps.filter((s) => s.id === 'agent:images' && s.status !== 'running').length, 0)
  const theme = useMemo<Theme>(() => ({
    brands,
    // Un applyBrand fallido vuelve al padre (transport): la marca vigente sigue siendo la anterior.
    current: turns.length ? brandOfTurn(turns.findLast((t) => brandOfTurn(t) && t.state.status !== 'error')) : pickedBrand,
    locked: turns.length > 0,
    busy,
    choose: (id) => {
      if (!turns.length) return setPickedBrand(id)
      if (id) applyBrand(id, brands?.find((b) => b.id === id)?.name ?? id)
    },
    load: loadBrands,
  }), [brands, turns, pickedBrand, busy, applyBrand, loadBrands])
  return { api, chatId, ownerBase, media, turns, busy, error, threadLost, previewUrl, theme, previewUrls: heartbeat.urls, previewRemounts: heartbeat.remounts, previewSrc: heartbeat.srcFor, previewToken: heartbeat.tokenFor, pokePreview: heartbeat.poke, previewVersion: preview?.version ?? -1, restores, imagesReady, instructions, ds, files, diff, imageModels, models, upload, transcribe: canTranscribe ? transcribeAudio : null, connectors, versions, send, repair, autoPending: Boolean(autoTarget), restore, updateDs, applyTheme, editText, deleteElement, replaceImage, sectionOp, retry, continueTurn, decide, revoke, shotUrl, stop, steer, canvas, setCanvas, variants, generateVariants, cancelVariant, cancelVariants }
}

// Sin transport, el builder reproduce la corrida de ejemplo: sirve para trabajar la UI sin motor.
const FIXTURE_PREVIEW = import.meta.env.VITE_PREVIEW_URL ?? 'http://localhost:5190'
const FIXTURE_DIFF = asAdded(workspaceFiles)

// En memoria: conectar marca la cuenta como conectada sin salir de la página.
let fixtureState = fixtureAccounts
const FIXTURE_CONNECTORS: Connectors = {
  apps: async (q) => ({ apps: fixtureApps.filter((a) => a.name.toLowerCase().includes(q.toLowerCase())), next: null }),
  accounts: async () => fixtureState,
  connect: async (app) => {
    fixtureState = [...fixtureState.filter((a) => a.app !== app), { id: `apn_${app}`, app, name: null, state: 'connected' }]
    return 'about:blank'
  },
  disconnect: async (id) => { fixtureState = fixtureState.filter((a) => a.id !== id) },
}

function useFixtureBuilder(): Builder {
  const replay = useReplay(fixtureEvents)
  const [notice, setNotice] = useState<string | null>(null)
  const turns = useMemo<Turn[]>(() => [{ messageId: 'fixture', prompt: fixturePrompt, state: replay.state, elapsedMs: replay.elapsedMs, request: { prompt: fixturePrompt } }], [replay.state, replay.elapsedMs])
  const done = replay.state.status !== 'streaming'
  return {
    turns,
    busy: !done,
    error: notice,
    previewUrl: done ? FIXTURE_PREVIEW : null,
    previewVersion: 0,
    // El fixture no restaura ni genera imágenes: los contadores quedan en cero.
    restores: 0,
    imagesReady: 0,
    files: workspaceFiles,
    diff: FIXTURE_DIFF,
    imageModels: [],
    models: [],
    connectors: FIXTURE_CONNECTORS,
    versions: [],
    repair: () => setNotice('Sin transport no hay corrida que arregle el preview.'),
    restore: () => setNotice('Sin transport no hay versiones que restaurar.'),
    updateDs: () => setNotice('Sin transport no hay DS que actualizar.'),
    editText: async () => { setNotice('Sin transport no hay código donde guardar el texto.'); return false },
    deleteElement: async () => { setNotice('Sin transport no hay código de donde quitar el elemento.'); return false },
    replaceImage: async () => { setNotice('Sin transport no hay código donde cambiar la imagen.'); return false },
    sectionOp: async () => { setNotice('Sin transport no hay código donde mover la sección.'); return false },
    send: () => setNotice('Sin transport (VITE_RUN_API vacío): este modo solo reproduce la corrida de ejemplo.'),
    retry: () => replay.restart(),
  }
}

const API = import.meta.env.VITE_RUN_API as string | undefined

export const useBuilder: () => Builder = API ? () => useLiveBuilder(API) : useFixtureBuilder
