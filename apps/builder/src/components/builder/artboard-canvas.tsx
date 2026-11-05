import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { ThemePreview } from '@/lib/theme-draft'
import { nextFrameHeight, parsePageSize, type PageSize } from '@/lib/page-size'
import { StarIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { deleteTargetOf, parsePicked, parseRectElements, parseTextChanged, type PickedElement } from '@/lib/element-context'
import type { SectionOp, Viewport } from '@/lib/run-client'
import type { Suggestion } from '@engine/runtime/event-model'
import { EditPopover } from './edit-popover'
import { ImageNodes } from './canvas-image-nodes'
import { PreviewProgress } from './preview-progress'
import { VariantFrame } from './variant-frame'
import { UPLOAD_MESSAGES } from '@/lib/canvas-upload'
import type { CanvasNodes } from '@/lib/use-canvas-nodes'
import { frameVisible, type Favorites } from '@/lib/use-favorites'
import { createSilenceWatch, settledNow } from '@/lib/silence-watch'
import { groupSettled, sideBySideGroups, variantScreens, variantsToRemount, variantStatus, type Instance, type LayoutResult, type VariantGroup } from '@/lib/variant-layout'
import { boundsWith, type Rect } from '@/lib/canvas-nodes'
import { useCanvasSelection } from './canvas-selection'
import { FrameLabel } from './frame-label'
import { frameA11yTitle } from '@/lib/frame-label'
import styles from './builder.module.css'

export type CanvasTool = 'select' | 'hand' | 'edit' | 'mark'
interface Point { x: number; y: number }
export interface Frame {
  id: string
  label: string
  x: number
  w: number
  h: number
  /** Marco de una variante (S5): su página es otro chat, con su propio preview. Pending mientras se genera. */
  variant?: { pending: boolean }
}

// Cada frame arranca al alto de una pantalla real: la página mide su alto con ese viewport y lo manda por
// 'wt:page-size' (templates/base-scaffold/src/wt-size-bridge.ts); el frame toma ese alto.
const FRAMES: Frame[] = [
  { id: 'desktop', label: 'Escritorio', x: 0, w: 1280, h: 900 },
  { id: 'mobile', label: 'Móvil', x: 1280 + 160, w: 390, h: 844 },
]
const REPORT_WAIT_MS = 2500
// El puente del preview (wt-reveal-bridge) pide el estado al instalarse: sin recargas por archivo, onLoad llega una vez.
// Gn de Stitch (OutageBanner deob l.1727-1741): el aviso de pantallas listas se va solo a los 10 s.
export const READY_TOAST_MS = 10_000

/** El viewport del marco seleccionado para el follow-up (síntesis re-contexto §2.1): su ancho y el alto de pantalla con
 * que arranca, no el alto de página que reportó. Una variante usa el de escritorio; sin selección, escritorio. */
export function frameViewport(selected: string | null, frames: readonly { id: string; w: number }[]): Viewport {
  const f = frames.find((x) => x.id === selected) ?? frames[0] ?? { id: FRAMES[0]!.id, w: FRAMES[0]!.w }
  return { width: f.w, height: (FRAMES.find((x) => x.id === f.id) ?? FRAMES[0]!).h }
}

/** isScreenInView de Stitch (useScreenUtils deob l.725-750): la página entera dentro del lienzo, con 20 px de margen. */
export function frameInView(f: { x: number; w: number; h: number }, cam: { zoom: number; x: number; y: number }, box: { width: number; height: number }): boolean {
  const left = f.x * cam.zoom + cam.x, top = cam.y
  return left >= -20 && top >= -20 && left + f.w * cam.zoom <= box.width + 20 && top + f.h * cam.zoom <= box.height + 20
}

const isBridgeReady = (data: unknown): boolean => typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'wt:bridge-ready'
const MIN_ZOOM = .02
const MAX_ZOOM = 4
const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

// Auto-pan de Stitch (DesignPage deob l.33253-33400): mientras se genera, el encuadre se anima en 600 ms y no pasa
// del 100 % (qj = 1); después del primero de la corrida no vuelve a acercar (preventZoomIn, useScreenUtils l.876-905).
export const AUTO_FIT = { duration: 600, maxZoom: 1 } as const
/** `extra`: cajas de mundo (imágenes) que el encuadre también cubre, como fitView de Stitch tras Ordenar. */
export interface FitOptions { duration?: number; maxZoom?: number; preventZoomIn?: boolean; extra?: readonly Rect[] }

/** El zoom del encuadre: entra entero, sin pasar de maxZoom ni, con preventZoomIn, del zoom actual. */
export function fitZoom(avail: { w: number; h: number }, box: { w: number; h: number }, current: number, o: FitOptions = {}): number {
  const cap = o.preventZoomIn ? Math.min(o.maxZoom ?? MAX_ZOOM, current) : o.maxZoom ?? MAX_ZOOM
  return clamp(Math.min(avail.w / box.w, avail.h / box.h, cap))
}

// d3-transition anima con easeCubic, cúbica de entrada y salida, si no se le pasa otra (d3js.org/d3-transition/timing#transition_ease).
export const easeCubicInOut = (t: number): number => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const bounds = (frames: Frame[]) => {
  const x0 = Math.min(...frames.map((f) => f.x)), x1 = Math.max(...frames.map((f) => f.x + f.w))
  return { x: x0, y: 0, w: x1 - x0, h: Math.max(...frames.map((f) => f.h)) }
}

/** Zona libre de chrome flotante, en px de pantalla: el encuadre y el zoom centran ahí, no detrás de los paneles. */
function insets(width: number) {
  return width < 761 ? { top: 140, right: 12, bottom: 250, left: 12 } : { top: 96, right: 80, bottom: 216, left: 320 }
}

export interface CanvasView {
  viewport: RefObject<HTMLDivElement | null>
  zoom: number
  pan: Point
  tool: CanvasTool
  selected: string | null
  setTool: (tool: CanvasTool) => void
  select: (id: string | null) => void
  frames: Frame[]
  /** Un reporte de tamaño de la página dentro de un frame. */
  onPageSize: (id: string, report: PageSize) => void
  /** Una versión nueva de la página vuelve a medir desde el alto de una pantalla. */
  resetSizes: () => void
  /** La persona ya movió la cámara (zoom, rueda, arrastre): el encuadre deja de seguir los altos nuevos. */
  touched: RefObject<boolean>
  zoomAt: (next: number, anchor?: Point) => void
  panBy: (dx: number, dy: number) => void
  /** Encuadra un frame, varios (el pan de un grupo de variantes) o todos. */
  fit: (id?: string | string[], o?: FitOptions) => void
  /** Aplica lo que calculó sideBySide: marcos de variante nuevos, corrimientos y placeholders que pasan a definitivos. */
  applyLayout: (result: LayoutResult, labels: Record<string, string>) => void
  /** Punto de pantalla (clientX/Y) a px de mundo, como screenToFlowPosition de React Flow en Stitch (DesignPage l.11866). */
  toWorld: (client: Point) => Point
}

export function useCanvasView(): CanvasView {
  const viewport = useRef<HTMLDivElement>(null)
  // Zoom y pan en un solo estado: anclar el zoom al cursor cambia los dos a la vez y el updater queda puro.
  const [cam, setCam] = useState({ zoom: .1, x: 0, y: 0 })
  const touched = useRef(false)
  const [tool, setTool] = useState<CanvasTool>('select')
  const [selected, select] = useState<string | null>('desktop')
  const [sizes, setSizes] = useState<Record<string, { h: number; prev: number; reported: boolean }>>(() => Object.fromEntries(FRAMES.map((f) => [f.id, { h: f.h, prev: f.h, reported: false }])))
  // Marcos de variante y x corridas por SideBySide (I18nStore :22481-22489): lo que estaba a la derecha deja lugar.
  const [variantFrames, setVariantFrames] = useState<Frame[]>([])
  const [movedX, setMovedX] = useState<Record<string, number>>({})
  // Stitch mantiene el placeholder con el alto de la fuente hasta que llega la pantalla (ZAP 26790, snaps 3-140).
  const sourceH = sizes.desktop?.h ?? FRAMES[0]!.h
  const frames = [...FRAMES, ...variantFrames].map((f) => ({
    ...f, x: movedX[f.id] ?? f.x, h: f.variant?.pending ? sourceH : sizes[f.id]?.h ?? (f.variant ? sourceH : f.h),
  }))
  // fit lee los altos del último render sin rehacer los callbacks que dependen de él.
  const framesRef = useRef(frames)
  framesRef.current = frames
  const onPageSize = useCallback((id: string, report: PageSize) => setSizes((all) => {
    const cur = all[id] ?? { h: FRAMES[0]!.h, prev: FRAMES[0]!.h, reported: false }
    const h = nextFrameHeight(cur.h, cur.prev, report)
    return h === cur.h && cur.reported ? all : { ...all, [id]: { h, prev: cur.h, reported: true } }
  }), [])
  // Solo los frames de la página actual: los de variante miden su propio preview.
  const resetSizes = useCallback(() => setSizes((all) => ({ ...all, ...Object.fromEntries(FRAMES.map((f) => [f.id, { h: f.h, prev: f.h, reported: false }])) })), [])
  const applyLayout = useCallback((result: LayoutResult, labels: Record<string, string>) => {
    const commits = new Set(result.mutations.flatMap((m) => (m.type === 'commit' ? [m.id] : [])))
    const moves = result.mutations.flatMap((m) => (m.type === 'move' ? [[m.id, m.x] as const] : []))
    setVariantFrames((list) => [
      ...list.map((f) => (commits.has(f.id) ? { ...f, variant: { pending: false } } : f)),
      ...result.creates.map((c) => ({ id: c.id, label: labels[c.id] ?? 'Variante', x: c.x, w: c.width, h: c.height, variant: { pending: !!c.pending } })),
    ])
    if (moves.length) setMovedX((all) => ({ ...all, ...Object.fromEntries(moves) }))
  }, [])

  const zoomAt = useCallback((next: number, anchor?: Point) => {
    const el = viewport.current
    if (!el) return
    const a = anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
    const n = clamp(next)
    stopAnim()
    touched.current = true
    setCam((c) => ({ zoom: n, x: a.x - (a.x - c.x) * (n / c.zoom), y: a.y - (a.y - c.y) * (n / c.zoom) }))
  }, [])
  const panBy = useCallback((dx: number, dy: number) => {
    stopAnim()
    touched.current = true
    setCam((c) => ({ ...c, x: c.x + dx, y: c.y + dy }))
  }, [])
  const camRef = useRef(cam)
  camRef.current = cam
  const anim = useRef<number | null>(null)
  const stopAnim = () => { if (anim.current !== null) cancelAnimationFrame(anim.current); anim.current = null }
  const fit = useCallback((id?: string | string[], o: FitOptions = {}) => {
    const el = viewport.current
    if (!el) return
    const ids = id === undefined ? [] : Array.isArray(id) ? id : [id]
    const chosen = framesRef.current.filter((f) => ids.includes(f.id))
    const base = bounds(chosen.length ? chosen : framesRef.current)
    const b = o.extra?.length ? boundsWith(base, o.extra) : base
    const pad = insets(el.clientWidth)
    const w = el.clientWidth - pad.left - pad.right, h = el.clientHeight - pad.top - pad.bottom
    const n = fitZoom({ w, h }, b, camRef.current.zoom, o)
    const to = { zoom: n, x: pad.left + (w - b.w * n) / 2 - b.x * n, y: pad.top + (h - b.h * n) / 2 - b.y * n }
    stopAnim()
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (!o.duration || reduced) { setCam(to); return }
    const from = camRef.current, start = performance.now(), d = o.duration
    const step = (now: number) => {
      const t = easeCubicInOut(Math.min(1, (now - start) / d))
      setCam({ zoom: from.zoom + (to.zoom - from.zoom) * t, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
      anim.current = t < 1 ? requestAnimationFrame(step) : null
    }
    anim.current = requestAnimationFrame(step)
  }, [])
  useEffect(() => stopAnim, [])
  const toWorld = useCallback((client: Point): Point => {
    const r = viewport.current?.getBoundingClientRect()
    const c = camRef.current
    return { x: (client.x - (r?.left ?? 0) - c.x) / c.zoom, y: (client.y - (r?.top ?? 0) - c.y) / c.zoom }
  }, [])

  return { viewport, zoom: cam.zoom, pan: { x: cam.x, y: cam.y }, tool, selected, frames, onPageSize, resetSizes, touched, setTool, select, zoomAt, panBy, fit, applyLayout, toWorld }
}

function parseWheel(data: unknown): { deltaX: number; deltaY: number; zoom: boolean; x: number; y: number } | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  if (d.type !== 'wt:wheel' || ![d.deltaX, d.deltaY, d.x, d.y].every(n)) return null
  return { deltaX: d.deltaX as number, deltaY: d.deltaY as number, zoom: d.zoom === true, x: d.x as number, y: d.y as number }
}

/** Deshacer y Rehacer de la página: null si no hay paso al que ir. */
export interface History { undo: (() => void) | null; redo: (() => void) | null }

interface ArtboardCanvasProps {
  view: CanvasView
  url: string | null
  version: number
  restores: number
  imagesReady: number
  busy: boolean
  /** El último turno dejó versión: sin ella (detenido antes de escribir, error) no hay página nueva que anunciar. */
  saved: boolean
  /** La corrida cerró del todo (settled): el aviso de lista sale recién ahí. */
  settled: boolean
  /** "Editar con IA" del popover: el elemento pasa al composer como contexto del próximo pedido. */
  onEditWithAI: (element: PickedElement) => void
  /** Guarda el texto editado en la página como una versión nueva; false si no se pudo. */
  onEditText: (before: string, after: string) => Promise<boolean>
  onDeleteElement: (target: NonNullable<ReturnType<typeof deleteTargetOf>>, label: string) => Promise<boolean>
  onReplaceImage: (src: string, next: { url: string } | { file: File }) => Promise<boolean>
  onSectionOp: (op: SectionOp) => Promise<boolean>
  sectionSuggestions: Record<string, Suggestion[]>
  onSuggest: (element: PickedElement, message: string) => void
  images: CanvasNodes
  /** Grupos de variantes (S5): cada variante es un marco al lado del de escritorio, con el preview de su chat. */
  variants?: VariantGroup[]
  onCancelVariant?: (messageId: string) => void
  /** Estrella de cada variante y filtro del rail (H14). */
  favorites?: Favorites
  /** Deshacer y Rehacer de la página, para el menú del lienzo. */
  history?: History
  /** Título de la pantalla (screenTitle, el mismo del top bar): va encima de los dos marcos de la página. */
  title?: string
  /** Chat del marco principal: la clave de `previewUrls` y `remounts`. */
  chatId?: string | null
  /** Url estable por chat del latido (R4.6); manda sobre la del log de cada variante. */
  previewUrls?: Record<string, string>
  /** Contador por chat: sube cuando el preview cambió de versión o volvió, y remonta su iframe. */
  remounts?: Record<string, number>
  /** src con el token de preview del latido (preview-access.ts); sin él, la url tal cual. */
  previewSrc?: (ws: string, slot: string, mountKey: string, url: string) => string
  /** Un marco cargó y no reportó en REPORT_WAIT_MS: adelanta un latido para saber si el preview cayó. */
  onFrameSilent?: (chat?: string) => void
  /** Vista previa del panel Tema (wt-theme-bridge del scaffold). null la quita; undefined = el panel nunca habló. */
  themePreview?: ThemePreview | null
}

const MARK_MIN = 4
const MARK_EMPTY = 'La región no tiene texto ni imágenes: prueba con otra.'
// Todo preview recibe hoy el puente del Marco (/@wt-bridges, #641), pero un iframe que se remonta con el pedido en vuelo
// (cierre de variante, HMR) pierde la respuesta: sin plazo el recuadro quedaba pintado para siempre. El puente contesta
// en milisegundos; un iframe recién remontado puede tardar más de 1,5 s en tenerlo (QA), de ahí los 3 s.
const MARK_REPLY_MS = 3000
const MARK_NO_REPLY = 'La página no respondió a tiempo: vuelve a marcar la región.'

export function ArtboardCanvas({ view, url, version, restores, imagesReady, busy, saved, settled, onEditWithAI, onEditText, onDeleteElement, onReplaceImage, onSectionOp, sectionSuggestions, onSuggest, images, variants = [], onCancelVariant, chatId, previewUrls = {}, remounts = {}, previewSrc = (_ws, _slot, _key, u) => u, onFrameSilent, themePreview, favorites, history = { undo: null, redo: null }, title = 'Nueva página' }: ArtboardCanvasProps) {
  const { viewport, zoom, pan, tool, selected, frames: allFrames, onPageSize, resetSizes, touched, select, zoomAt, panBy, fit, applyLayout, toWorld } = view
  // El filtro de favoritas solo esconde: las posiciones no cambian, así el lienzo no salta al prenderlo.
  const frames = allFrames.filter((f) => frameVisible(f, favorites?.ids ?? [], favorites?.only ?? false))
  const runs = new Map(variants.flatMap((g) => g.runs.map((r) => [r.messageId, r] as const)))
  const variantLabel = (id: string) => { const r = runs.get(id); return r ? r.state.variant?.title || `Variante ${r.index + 1}` : '' }
  // SideBySide por grupo, cada vez que cambia una variante: es idempotente (no repite lo que ya está en el lienzo),
  // así que crea los placeholders una vez y después solo commitea los que terminaron.
  // Con todos los marcos, también los que esconde el filtro: si no, el layout los volvería a crear.
  const framesNow = useRef(allFrames)
  framesNow.current = allFrames
  useEffect(() => {
    const all = framesNow.current
    const desktop = all.find((f) => f.id === 'desktop')
    if (!desktop || !variants.length) return
    const existing = new Map(all.map((f) => [f.id, { id: f.id, x: f.x, y: 0, width: f.w, height: f.h, ...(f.variant?.pending ? { pending: f.id } : { source: f.id }) } as Instance]))
    const result = sideBySideGroups(variants.map((g) => ({
      source: { id: desktop.id, x: desktop.x, y: 0, width: desktop.w, height: desktop.h, source: g.sourceId },
      screens: variantScreens(g, { width: desktop.w, height: desktop.h }),
    })), existing)
    if (result.creates.length || result.mutations.length) applyLayout(result, Object.fromEntries(variants.flatMap((g) => g.runs.map((r) => [r.messageId, `Variante ${r.index + 1}`]))))
  }, [variants, applyLayout])
  // schedulePan al DONE de la sesión (I18nStore :18587-18597): una vez por grupo, cuando las N cerraron.
  const panned = useRef(new Set<string>())
  useEffect(() => {
    for (const g of variants) {
      // Un grupo rehidratado no mueve la cámara: al recargar la vista se queda en la página, no salta a las variantes.
      if (g.restored) panned.current.add(g.groupId)
      if (panned.current.has(g.groupId) || !groupSettled(g)) continue
      panned.current.add(g.groupId)
      fit(g.runs.map((r) => r.messageId), AUTO_FIT)
    }
  }, [variants, fit])
  // Último puntero sobre el lienzo: pegar coloca ahí, como mRef en el hook de subida de Stitch (DesignPage l.41171).
  const lastPointer = useRef<Point | null>(null)
  const { upload } = images
  // El elemento elegido con el lápiz, en coordenadas de su página; el popover se ubica con la cámara actual.
  const [picked, setPicked] = useState<{ frame: string; element: PickedElement } | null>(null)
  useEffect(() => { if (tool !== 'edit') setPicked(null) }, [tool])
  useEffect(() => setPicked(null), [url, version])
  const drag = useRef<{ id: number; last: Point } | null>(null)
  const pointer = () => {
    const el = viewport.current
    return lastPointer.current ?? (el ? { x: el.getBoundingClientRect().left + el.clientWidth / 2, y: el.getBoundingClientRect().top + el.clientHeight / 2 } : { x: 0, y: 0 })
  }
  const selection = useCanvasSelection({ viewport, toWorld, tool: () => tool, frames: () => frames, fit, images, history, pointer })
  const [dragging, setDragging] = useState(false)
  // Marco (H14, Mark de Stitch): la región se dibuja sobre un marco de la página vigente, en coordenadas de esa página
  // (el mundo es 1:1 con el ancho del preview). Las variantes no: su página es otro chat y el pedido va a este.
  const mark = useRef<{ id: number; frame: string; start: Point } | null>(null)
  const [markBox, setMarkBox] = useState<{ frame: string; x: number; y: number; width: number; height: number } | null>(null)
  const [markNote, setMarkNote] = useState<string | null>(null)
  const addPicked = useRef(onEditWithAI)
  addPicked.current = onEditWithAI
  const markWait = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(markWait.current), [])
  useEffect(() => { if (tool !== 'mark') { window.clearTimeout(markWait.current); setMarkBox(null); setMarkNote(null) } }, [tool])
  const iframes = useRef(new Map<string, HTMLIFrameElement>())
  const heights = frames.map((f) => f.h).join(',')

  // Con la misma url el iframe no se remonta (el HMR trae la versión nueva) y el puente no repite un alto igual al último:
  // reiniciar los altos por versión dejaría el frame en el alto por defecto.
  useLayoutEffect(() => { resetSizes() }, [url, resetSizes])
  // Lo que Lovable llama isLoading: desde que el iframe empieza a cargar (url nueva o remonte por restore) hasta su load.
  const [frameLoading, setFrameLoading] = useState(false)
  useEffect(() => { if (url) setFrameLoading(true) }, [url, restores])
  // El load del iframe llega con el scaffold vacío (App sin secciones), así que el placeholder sigue encima hasta que
  // la página reporta su primera sección. Es el placeholder de Stitch, que no se reemplaza hasta que la pantalla tiene
  // contenido (UPDATE_INSTANCE_WITH_COMMITTED_SOURCE, I18nStore deob :22080-22118). Un puente sin el conteo no bloquea.
  const [firstSection, setFirstSection] = useState(false)
  useEffect(() => { setFirstSection(false) }, [url, restores])
  // Mientras la persona no movió la cámara, el encuadre sigue a los altos que reportan las páginas.
  // u.current de Stitch: el primer encuadre de la corrida puede acercar; los siguientes, no.
  const autoFitted = useRef(false)
  const autoFit = useCallback(() => {
    fit(undefined, { ...AUTO_FIT, preventZoomIn: autoFitted.current })
    autoFitted.current = true
  }, [fit])
  useLayoutEffect(() => { if (!touched.current) autoFit() }, [autoFit, heights, touched])

  // El preview anima lo que entra (wt-reveal-bridge) solo mientras el agente escribe: se le avisa al cambiar y al cargar.
  const tellGenerating = useCallback((el: HTMLIFrameElement | undefined) => {
    if (!url || !el?.contentWindow) return
    let origin: string
    try { origin = new URL(url).origin } catch { return }
    el.contentWindow.postMessage({ type: 'wt:generating', active: busy }, origin)
  }, [url, busy])
  useEffect(() => { for (const el of iframes.current.values()) tellGenerating(el) }, [tellGenerating])

  // El lápiz enciende el modo selección dentro de la página (wt-select-bridge) y le da el puntero al iframe.
  const tellMode = useCallback((el: HTMLIFrameElement | undefined) => {
    if (!url || !el?.contentWindow) return
    let origin: string
    try { origin = new URL(url).origin } catch { return }
    el.contentWindow.postMessage({ type: 'wt:select-mode', active: tool === 'edit' }, origin)
  }, [url, tool])
  useEffect(() => { for (const el of iframes.current.values()) tellMode(el) }, [tellMode])

  // El panel Tema repinta la página sin versión: el puente aplica la capa de marca; null la quita. Se repite al cargar
  // porque un iframe remontado (versión nueva, latido) vuelve sin la hoja de la vista previa.
  const tellTheme = useCallback((el: HTMLIFrameElement | undefined) => {
    if (!url || !el?.contentWindow || themePreview === undefined) return
    let origin: string
    try { origin = new URL(url).origin } catch { return }
    el.contentWindow.postMessage({ type: 'wt:theme', theme: themePreview }, origin)
  }, [url, themePreview])
  useEffect(() => { for (const el of iframes.current.values()) tellTheme(el) }, [tellTheme])

  useEffect(() => {
    if (!url || !imagesReady) return
    let origin: string
    try { origin = new URL(url).origin } catch { return }
    // bust: una foto nueva en la misma ruta no se ve si el <img> no la vuelve a pedir (arnés A8).
    for (const el of iframes.current.values()) el.contentWindow?.postMessage({ type: 'wt:images-ready', bust: imagesReady }, origin)
  }, [url, imagesReady])

  // Solo cuenta lo que llega del origen del preview y desde uno de nuestros iframes: así cada alto va a su frame.
  useEffect(() => {
    if (!url) return
    let origin: string
    try { origin = new URL(url).origin } catch { return }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return
      const frame = [...iframes.current].find(([, el]) => el.contentWindow === event.source)
      if (!frame) return
      const [id, el] = frame
      if (isBridgeReady(event.data)) { tellGenerating(el); tellMode(el); tellTheme(el); return }
      const report = parsePageSize(event.data)
      if (report) { silence.report(id, report.sections); onPageSize(id, report); if (report.sections === undefined || report.sections > 0) setFirstSection(true); return }
      const element = parsePicked(event.data)
      if (element) { setPicked({ frame: id, element }); return }
      const found = parseRectElements(event.data)
      if (found) {
        window.clearTimeout(markWait.current)
        setMarkBox(null)
        setMarkNote(found.length ? null : MARK_EMPTY)
        for (const el of found) addPicked.current(el)
        return
      }
      const edit = parseTextChanged(event.data)
      if (edit) {
        if (edit.after === edit.before) return
        // Si no se guardó, la página vuelve a mostrar lo que dice el código; si se guardó, el HMR trae la versión nueva.
        void onEditText(edit.before, edit.after).then((ok) => { if (!ok) el.contentWindow?.postMessage({ type: 'wt:edit-revert' }, origin) })
        return
      }
      wheelFrom(el, event.data)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [url, onPageSize, viewport, zoom, zoomAt, panBy, onEditText, tellGenerating, tellMode, tellTheme])

  // Cada variante sirve su preview desde su propio dev server: solo su origen y su iframe cuentan para su marco.
  const variantIframes = useRef(new Map<string, HTMLIFrameElement>())
  // Hasta su load (o el bridge-ready) el iframe sigue en about:blank y el postMessage con el origen del preview no
  // llega: el navegador avisa del origen distinto y lo descarta. Se le habla solo a los que ya cargaron.
  const variantLoaded = useRef(new WeakSet<HTMLIFrameElement>())
  const originOf = (u: string | undefined) => { try { return u ? new URL(u).origin : null } catch { return null } }
  const variantUrl = (id: string): string | undefined => previewUrls[id] ?? runs.get(id)?.state.preview
  const tellVariant = (id: string, el: HTMLIFrameElement | undefined) => {
    const run = runs.get(id)
    const origin = originOf(variantUrl(id))
    if (run && origin) el?.contentWindow?.postMessage({ type: 'wt:generating', active: variantStatus(run) === 'pending' }, origin)
  }
  // Solo cuando cambia el estado de alguna: el resto de los eventos de la variante no le importa a su puente.
  const variantKey = [...runs.values()].map((r) => `${r.messageId}:${variantStatus(r)}:${variantUrl(r.messageId) ?? ''}`).join('|')
  useEffect(() => { for (const [id, el] of variantIframes.current) if (variantLoaded.current.has(el)) tellVariant(id, el) }, [variantKey])
  // Al cerrar, el marco de la variante se remonta una vez: sale del error de vite por un import que ya no existe
  // (rb-qa2) y trae las fotos reemplazadas en la misma ruta (A8).
  const variantSeen = useRef(new Map<string, string>())
  useEffect(() => {
    const { ids, seen } = variantsToRemount(variantSeen.current, [...runs.values()])
    variantSeen.current = seen
    for (const id of ids) kick(id)
  }, [variantKey])
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const hit = [...variantIframes.current].find(([, el]) => el.contentWindow === event.source)
      if (!hit) return
      const [id, el] = hit
      if (event.origin !== originOf(variantUrl(id))) return
      if (isBridgeReady(event.data)) { variantLoaded.current.add(el); tellVariant(id, el); return }
      const report = parsePageSize(event.data)
      if (report) { silence.report(id, report.sections); onPageSize(id, report); return }
      wheelFrom(el, event.data)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  })
  // La página manda coordenadas de su viewport; el lienzo las necesita en las suyas.
  function wheelFrom(el: HTMLIFrameElement, data: unknown) {
    const wheel = parseWheel(data)
    if (!wheel || !viewport.current) return
    const page = el.getBoundingClientRect(), box = viewport.current.getBoundingClientRect()
    const at = { x: page.left - box.left + wheel.x * zoom, y: page.top - box.top + wheel.y * zoom }
    if (wheel.zoom) zoomAt(zoom * Math.exp(-Math.max(-50, Math.min(50, wheel.deltaY)) * .01), at)
    else panBy(-wheel.deltaX, -wheel.deltaY)
  }
  // D3.4 del ADR 0013: el marco que no habla puede ser un preview caído; el latido trae su estado y el remonte lo arregla.
  const silentRef = useRef(onFrameSilent)
  silentRef.current = onFrameSilent
  const generatingRef = useRef<(id: string) => boolean>(() => false)
  generatingRef.current = (id) => { const run = runs.get(id); return run ? variantStatus(run) === 'pending' : busy }
  const [silence] = useState(() => createSilenceWatch<HTMLIFrameElement>(REPORT_WAIT_MS, (chat) => silentRef.current?.(chat), undefined, (id) => generatingRef.current(id)))
  // Remontes por cerrar en blanco, por preview (chat o variante); se suman al contador del latido en la key del iframe.
  const [kicks, setKicks] = useState<Record<string, number>>({})
  const kick = (chat: string) => setKicks((all) => ({ ...all, [chat]: (all[chat] ?? 0) + 1 }))
  // Arranca con lo que ya estaba cerrado al montar: una recarga del builder no es un settled nuevo.
  const settledBefore = useRef<Map<string, boolean> | null>(null)
  const settledKey = `${chatId ?? ''}:${settled}|${[...runs.values()].map((r) => `${r.messageId}:${r.settled}`).join('|')}`
  useEffect(() => {
    const next = new Map<string, boolean>([...(chatId ? [[chatId, settled] as const] : []), ...[...runs.values()].map((r) => [r.messageId, r.settled] as const)])
    const prev = settledBefore.current ?? next
    settledBefore.current = next
    for (const id of settledNow(prev, next)) {
      // Solo marcos con iframe: una variante fallida sin versión no tiene página que remontar.
      const mounted = id === chatId ? FRAMES.map((f) => f.id).filter((f) => iframes.current.has(f)) : variantIframes.current.has(id) ? [id] : []
      if (mounted.some((f) => silence.blank(f))) kick(id)
    }
  }, [settledKey])

  // Editar texto deja la selección en la página: el puente edita el elemento que tiene elegido.
  const editText = (frame: string) => {
    setPicked(null)
    if (!url) return
    try { iframes.current.get(frame)?.contentWindow?.postMessage({ type: 'wt:edit-text' }, new URL(url).origin) } catch { /* url inválida */ }
  }
  // Como Stitch, el elemento desaparece al pulsar Eliminar; si el transport no pudo, la página lo vuelve a mostrar.
  const remove = (frame: string, element: PickedElement) => {
    const target = deleteTargetOf(element)
    if (!target || !url) return
    setPicked(null)
    let origin: string
    try { origin = new URL(url).origin } catch { return }
    const win = iframes.current.get(frame)?.contentWindow
    win?.postMessage({ type: 'wt:hide-selected' }, origin)
    const label = element.kind === 'image' ? 'imagen' : `«${element.text.slice(0, 40)}»`
    void onDeleteElement(target, label).then((ok) => { if (!ok) win?.postMessage({ type: 'wt:edit-revert' }, origin) })
  }
  // Como direct_edit_replace de Stitch: una URL se ve en la página al instante y vuelve atrás si el código no cambió.
  // Un archivo subido se ve cuando llega la versión: hasta que no está en public/ la página no tiene de dónde servirlo.
  const replace = (frame: string, element: PickedElement, next: { url: string } | { file: File }) => {
    if (!element.src || !url) return
    setPicked(null)
    let origin: string
    try { origin = new URL(url).origin } catch { return }
    const win = iframes.current.get(frame)?.contentWindow
    if ('url' in next) win?.postMessage({ type: 'wt:replace-image', src: next.url }, origin)
    void onReplaceImage(element.src, next).then((ok) => { if (!ok) win?.postMessage({ type: 'wt:edit-revert' }, origin) })
  }
  const clearPick = () => {
    setPicked(null)
    if (!url) return
    try { const origin = new URL(url).origin; for (const el of iframes.current.values()) el.contentWindow?.postMessage({ type: 'wt:select-clear' }, origin) } catch { /* url inválida */ }
  }

  // Como Stitch: cada corrida vuelve a encuadrar la página aunque la persona haya movido la cámara antes, y avisa que
  // está lista durante READY_TOAST_MS (DesignPage deob l.13100-13115). El aviso espera a que cierre el stream entero de
  // la sesión (createSession con espera → Ev hace for await del stream, I18nStore-D328XrU5): nuestro cierre es settled,
  // no message.end. Solo la corrida vista en vivo avisa; una rehidratada ya llega cerrada.
  const wasBusy = useRef(busy)
  const ran = useRef(false)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (busy && !wasBusy.current) { touched.current = false; autoFitted.current = false; ran.current = true; setReady(false); autoFit() }
    wasBusy.current = busy
  }, [busy, autoFit, touched])
  useEffect(() => {
    if (!settled || !ran.current) return
    ran.current = false
    setReady(saved)
  }, [settled, saved])
  useEffect(() => {
    if (!ready) return
    const t = window.setTimeout(() => setReady(false), READY_TOAST_MS)
    return () => window.clearTimeout(t)
  }, [ready])
  // Un de Stitch (OutageBanner deob l.1705-1716): "View" solo si la página no está entera a la vista.
  const desktop = frames.find((f) => f.id === 'desktop')
  const box = viewport.current
  const showView = !desktop || !box || !frameInView(desktop, { zoom, x: pan.x, y: pan.y }, { width: box.clientWidth, height: box.clientHeight })

  // React registra wheel como pasivo y no deja cancelar el scroll del navegador: el listener va a mano.
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      // Un pellizco del trackpad trae deltas chicos y una rueda de mouse ~100 por paso: se acota para que un paso no salte x3.
      if (e.ctrlKey || e.metaKey) zoomAt(zoom * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * .01), { x: e.clientX - r.left, y: e.clientY - r.top })
      else panBy(-e.deltaX, -e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [viewport, zoom, zoomAt, panBy])

  const onPointerDown = (e: ReactPointerEvent) => {
    if (tool === 'mark' && e.button === 0) {
      const at = toWorld({ x: e.clientX, y: e.clientY })
      const f = frames.find((x) => !x.variant && at.x >= x.x && at.x <= x.x + x.w && at.y >= 0 && at.y <= x.h)
      if (!f || !url) return
      e.currentTarget.setPointerCapture(e.pointerId)
      mark.current = { id: e.pointerId, frame: f.id, start: at }
      setMarkNote(null)
      setMarkBox({ frame: f.id, x: at.x - f.x, y: at.y, width: 0, height: 0 })
      return
    }
    if (tool !== 'hand' && e.button !== 1) {
      if (e.target === e.currentTarget) { select(null); selection.onPanePointerDown(e) }
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { id: e.pointerId, last: { x: e.clientX, y: e.clientY } }
    setDragging(true)
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const m = mark.current
    if (m && m.id === e.pointerId) {
      const f = frames.find((x) => x.id === m.frame)
      if (!f) return
      const at = toWorld({ x: e.clientX, y: e.clientY })
      const cx = Math.min(Math.max(at.x, f.x), f.x + f.w), cy = Math.min(Math.max(at.y, 0), f.h)
      setMarkBox({ frame: f.id, x: Math.min(m.start.x, cx) - f.x, y: Math.min(m.start.y, cy), width: Math.abs(cx - m.start.x), height: Math.abs(cy - m.start.y) })
      return
    }
    if (selection.onPanePointerMove(e)) return
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    panBy(e.clientX - d.last.x, e.clientY - d.last.y)
    d.last = { x: e.clientX, y: e.clientY }
  }
  const endDrag = () => {
    drag.current = null
    selection.endGesture()
    setDragging(false)
    if (!mark.current) return
    mark.current = null
    // Un clic sin arrastre no es una región.
    if (!markBox || markBox.width < MARK_MIN || markBox.height < MARK_MIN || !url) { setMarkBox(null); return }
    try {
      const { frame, ...rect } = markBox
      iframes.current.get(frame)?.contentWindow?.postMessage({ type: 'wt:select-rect', rect }, new URL(url).origin)
      window.clearTimeout(markWait.current)
      markWait.current = window.setTimeout(() => { setMarkBox(null); setMarkNote(MARK_NO_REPLY) }, MARK_REPLY_MS)
    } catch { setMarkBox(null) }
  }

  return (
    <div
      ref={viewport}
      className={styles.canvas}
      data-tool={tool}
      data-dragging={dragging || undefined}
      style={{ backgroundPosition: `${pan.x}px ${pan.y}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => { lastPointer.current = { x: e.clientX, y: e.clientY }; onPointerMove(e) }}
      // Soltar archivos: el onDrop del hook de Stitch (DesignPage l.41149) los coloca en el punto del drop.
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); void upload([...e.dataTransfer.files], toWorld({ x: e.clientX, y: e.clientY })) }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onContextMenu={selection.onPaneContextMenu}
    >
      <div className={styles.world} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, '--zoom': zoom } as CSSProperties}>
        {frames.map((f) => f.variant ? (
          <VariantFrame key={f.id} frame={f} run={runs.get(f.id)} label={variantLabel(f.id)} selected={selected === f.id}
            onSelect={() => { if (tool === 'select') { select(f.id); images.clearSelection() } }}
            iframeRef={(el) => { if (el) { variantIframes.current.set(f.id, el); silence.mount(el, el.src, f.id, f.id) } else variantIframes.current.delete(f.id) }}
            url={(() => { const u = variantUrl(f.id), n = (remounts[f.id] ?? 0) + (kicks[f.id] ?? 0); return u && previewSrc(f.id, f.id, String(n), u) })()} remount={(remounts[f.id] ?? 0) + (kicks[f.id] ?? 0)}
            onLoad={(el) => { variantLoaded.current.add(el); tellVariant(f.id, el) }} />
        ) : (
          <div key={f.id} className={styles.artboard} style={{ left: f.x, width: f.w, height: f.h }} data-selected={selected === f.id || undefined} data-placeholder={(busy && !(url && firstSection)) || undefined} data-editing={(tool === 'edit' && !!url) || undefined}
            onPointerDown={(e) => { if (tool === 'select' && e.button === 0) { e.stopPropagation(); select(f.id); images.clearSelection() } }}>
            {url
              ? <iframe key={`${restores}:${(chatId ? (remounts[chatId] ?? 0) + (kicks[chatId] ?? 0) : 0)}`} ref={(el) => { if (el) { iframes.current.set(f.id, el); silence.mount(el, el.src, f.id, chatId ?? undefined) } else iframes.current.delete(f.id) }} src={chatId ? previewSrc(chatId, f.id, `${restores}:${(remounts[chatId] ?? 0) + (kicks[chatId] ?? 0)}`, url) : url} title={frameA11yTitle(title, f.label)} className={styles.artboardFrame} tabIndex={-1} onLoad={(e) => { setFrameLoading(false); tellGenerating(e.currentTarget); tellMode(e.currentTarget); tellTheme(e.currentTarget) }} />
              : !busy && <div className={styles.artboardEmpty}>El preview aparece cuando el motor lo levanta.</div>}
            {busy && !(url && firstSection) && (
              <div className={styles.artboardGenerating} data-over-preview={url ? '' : undefined}>
                <div className={styles.shimmer} aria-hidden="true" />
                {/* Nh de Stitch (DesignPage deob l.6444-6470): tres barras, la última al 66 %, con desfase de 0.2 s. */}
                <div className={styles.skeleton} aria-hidden="true" data-wt-loading="22">
                  {[0, 1, 2].map((i) => <span key={i} className={styles.skeletonBar} style={{ '--d': `${i * .2}s` } as CSSProperties} />)}
                </div>
                <p className={styles.generatingBanner}><span className={styles.generatingSpinner} aria-hidden="true" />Generando pantalla…</p>
              </div>
            )}
            {url && <PreviewProgress loading={frameLoading} />}
            {busy && url && (
              <div className={styles.aurora} aria-hidden="true">
                <div className={styles.auroraGlow}><div className={styles.auroraBlur}><div className={styles.auroraSpin} /></div></div>
                <div className={styles.auroraBorder}><div className={styles.auroraSpin} /></div>
              </div>
            )}
          </div>
        ))}
        <ImageNodes nodes={images} zoom={zoom} interactive={tool === 'select'} onPick={() => select(null)} />
        {markBox && (() => {
          const f = frames.find((x) => x.id === markBox.frame)
          return f ? <div className={styles.markBox} style={{ left: f.x + markBox.x, top: markBox.y, width: markBox.width, height: markBox.height }} aria-hidden="true" /> : null
        })()}
      </div>
      {/* Etiquetas y badge van fuera del mundo escalado para mantener su tamaño en pantalla, como en Stitch. */}
      {frames.map((f) => {
        const left = pan.x + f.x * zoom, top = pan.y, w = f.w * zoom
        const run = f.variant ? runs.get(f.id) : undefined
        return (
          <div key={f.id} className={styles.artboardChrome} style={{ left, top, width: w }}>
            <FrameLabel title={title} generating={busy && !(url && firstSection)} variantTitle={f.variant ? variantLabel(f.id) : undefined} />
            {run && onCancelVariant && variantStatus(run) === 'pending' && (
              <Button size="sm" variant="ghost" className={styles.variantStop} aria-label={`Detener ${variantLabel(f.id)}`} onClick={() => onCancelVariant(run.messageId)}><XIcon size={12} /></Button>
            )}
            {run && favorites && variantStatus(run) !== 'pending' && (() => {
              const on = favorites.ids.includes(f.id)
              return (
                <Button size="sm" variant="ghost" className={styles.variantStop} aria-pressed={on} data-on={on || undefined} aria-label={on ? `Quitar ${variantLabel(f.id)} de favoritas` : `Marcar ${variantLabel(f.id)} como favorita`} onClick={() => favorites.toggle(f.id)}>
                  <StarIcon size={12} fill={on ? 'currentColor' : 'none'} />
                </Button>
              )
            })()}
            {selected === f.id && <span className={styles.sizeBadge} style={{ top: f.h * zoom + 6 }}>{f.w} x {f.h}</span>}
          </div>
        )
      })}
      {picked && (() => {
        const f = frames.find((x) => x.id === picked.frame)
        if (!f) return null
        const r = picked.element.rect
        const area = viewport.current?.getBoundingClientRect()
        return (
          <EditPopover
            element={picked.element}
            box={{ x: pan.x + (f.x + r.x) * zoom, y: pan.y + r.y * zoom, width: r.width * zoom, height: r.height * zoom }}
            clickY={pan.y + (picked.element.click?.y ?? r.y + r.height / 2) * zoom}
            area={{ width: area?.width ?? window.innerWidth, height: area?.height ?? window.innerHeight }}
            onClose={clearPick}
            busy={busy}
            onEditText={() => editText(picked.frame)}
            onDelete={deleteTargetOf(picked.element) ? () => remove(picked.frame, picked.element) : null}
            onReplaceImage={picked.element.kind === 'image' && picked.element.src ? (next) => replace(picked.frame, picked.element, next) : null}
            onEditWithAI={(note) => { onEditWithAI(note ? { ...picked.element, note } : picked.element); clearPick() }}
            onSection={picked.element.section ? (op) => { clearPick(); void onSectionOp(op) } : null}
            suggestions={picked.element.section ? sectionSuggestions[picked.element.section.slug] ?? [] : []}
            onSuggest={(message) => { onSuggest(picked.element, message); clearPick() }}
          />
        )
      })()}
      {selection.layer}
      {markNote && <div className={styles.uploadToast} role="status">{markNote}</div>}
      {favorites?.error && <div className={styles.uploadToast} role="status" data-error="">{favorites.error}</div>}
      {(images.notices.length > 0 || images.ok) && (
        <div className={styles.uploadToast} role="status" data-error={images.notices.length ? '' : undefined}>
          {(images.notices.length ? images.notices : [UPLOAD_MESSAGES.uploaded]).map((m, i) => (
            <div key={m} className={styles.uploadToastRow}>
              <span>{m}</span>
              {i === 0 && <Button size="sm" variant="ghost" aria-label="Cerrar aviso" onClick={images.dismissNotices}><XIcon size={14} /></Button>}
            </div>
          ))}
        </div>
      )}
      {ready && (
        <div className={styles.readyToast} role="status" data-wt-loading="9">
          <span>La página está lista</span>
          {showView && <Button size="sm" variant="secondary" onClick={() => { setReady(false); fit('desktop') }}>Ver</Button>}
          <Button size="sm" variant="ghost" aria-label="Cerrar aviso" onClick={() => setReady(false)}><XIcon size={14} /></Button>
        </div>
      )}
    </div>
  )
}
