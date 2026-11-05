import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { FORMAT_GAP, formatNodes, nodesInRect, rectFrom, ROW_EXTRA, type Rect } from '@/lib/canvas-nodes'
import { IMAGE_TYPES } from '@/lib/canvas-upload'
import type { CanvasNodes } from '@/lib/use-canvas-nodes'
import { useSelectionKeys } from '@/lib/use-canvas-keys'
import type { CanvasTool, FitOptions, Frame, History } from './artboard-canvas'
import { CanvasMenu } from './canvas-context-menu'
import styles from './builder.module.css'

// Capa de selección del lienzo (docs/spec/seleccion-lienzo.md): rectángulo de selección y menú del lienzo de Stitch §3d.
// No escribe nada directo: la selección va por images.selectMany y Ordenar/Pegar/Subir por images.format/upload, que
// guardan por canvas-writer (A9). Por eso aquí no entra run-client ni canvas-writer (guarda en el test, B3).

interface Point { x: number; y: number }

export const CLIPBOARD_EMPTY = 'No hay imágenes en el portapapeles'
export const CLIPBOARD_DENIED = 'El navegador no dejó leer el portapapeles'

/** Ordenar deja las imágenes en filas debajo del marco más alto, con el aire entre filas de SA (64 + 80). Los marcos no
 * se mueven: en el builder son fijos (divergencia propia, spec §2). */
export function formatOrigin(frames: readonly Pick<Frame, 'h'>[]): Point {
  return { x: 0, y: Math.max(0, ...frames.map((f) => f.h)) + FORMAT_GAP + ROW_EXTRA }
}

/** Pegar del menú o de ⌘V: lee el portapapeles y coloca; sin imágenes o sin permiso, avisa y no escribe nada. */
export async function pasteImages(read: () => Promise<File[]>, place: (files: File[]) => Promise<void>, notify: (m: string[]) => void): Promise<void> {
  let files: File[]
  try {
    files = await read()
  } catch {
    notify([CLIPBOARD_DENIED])
    return
  }
  if (files.length) await place(files)
  else notify([CLIPBOARD_EMPTY])
}

/** Ordenar: un solo `format` (un guardado por canvas-writer) y después el encuadre de marcos más imágenes ya movidas. */
export function runFormat(deps: { nodes: CanvasSelectionDeps['images']['nodes']; frames: readonly Pick<Frame, 'h'>[]; format: (origin: Point) => void; fit: (id?: string, o?: FitOptions) => void; later: (fn: () => void) => void }): void {
  const origin = formatOrigin(deps.frames)
  const placed: Rect[] = formatNodes(deps.nodes, origin)
  deps.format(origin)
  deps.later(() => deps.fit(undefined, { extra: placed }))
}

/** Imágenes del portapapeles como archivos; el nombre es el que da el navegador a una imagen pegada. */
async function clipboardImages(): Promise<File[]> {
  const items = await navigator.clipboard.read()
  return Promise.all(items.flatMap((it) => it.types.filter((t) => Object.hasOwn(IMAGE_TYPES, t))
    .map(async (t) => new File([await it.getType(t)], `image${IMAGE_TYPES[t]![0]}`, { type: t }))))
}

export interface CanvasSelectionDeps {
  readonly viewport: RefObject<HTMLDivElement | null>
  readonly toWorld: (p: Point) => Point
  readonly tool: () => CanvasTool
  readonly frames: () => readonly Frame[]
  readonly fit: (id?: string, o?: FitOptions) => void
  readonly images: Pick<CanvasNodes, 'nodes' | 'selected' | 'ready' | 'selectMany' | 'clearSelection' | 'format' | 'notify' | 'upload'>
  readonly history: History
  /** Último punto del puntero en px de pantalla (o el centro): ⌘V coloca ahí, como mRef de Stitch (DP l.41171). */
  readonly pointer: () => Point
}

export function useCanvasSelection(deps: CanvasSelectionDeps) {
  const { viewport, toWorld, tool, frames, fit, images, history, pointer } = deps
  // selectionOnDrag de Stitch (DP l.58620): puntos en px del viewport; `base` es lo elegido al empezar, que se conserva
  // con Shift/Meta (multiSelectionKeyCode, DP l.57929).
  const marquee = useRef<{ id: number; start: Point; base: ReadonlySet<string> } | null>(null)
  const [band, setBand] = useState<{ start: Point; now: Point } | null>(null)
  // Punto del clic derecho en px de pantalla: Subir y Pegar colocan ahí aunque el menú ya cerró.
  const [menuAt, setMenuAt] = useState<Point | null>(null)
  const menuPoint = useRef<Point>({ x: 0, y: 0 })

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = viewport.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }
  const worldOf = (p: Point): Point => {
    const r = viewport.current?.getBoundingClientRect()
    return toWorld({ x: p.x + (r?.left ?? 0), y: p.y + (r?.top ?? 0) })
  }

  /** Clic en el fondo con la herramienta de selección: arranca el rectángulo. Con otra herramienta, solo suelta. */
  const onPanePointerDown = (e: ReactPointerEvent) => {
    if (tool() !== 'select' || e.button !== 0) { images.clearSelection(); return }
    const additive = e.shiftKey || e.metaKey
    if (!additive) images.clearSelection()
    viewport.current?.setPointerCapture(e.pointerId)
    marquee.current = { id: e.pointerId, start: local(e), base: additive ? images.selected : new Set() }
  }
  /** true si el movimiento era del rectángulo (y el lienzo no tiene que paneárselo). */
  const onPanePointerMove = (e: ReactPointerEvent): boolean => {
    const m = marquee.current
    if (!m || m.id !== e.pointerId) return false
    const now = local(e)
    setBand({ start: m.start, now })
    images.selectMany(nodesInRect(images.nodes, rectFrom(worldOf(m.start), worldOf(now))), m.base)
    return true
  }
  const endGesture = () => { marquee.current = null; setBand(null) }
  const onPaneContextMenu = (e: ReactMouseEvent) => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    menuPoint.current = { x: e.clientX, y: e.clientY }
    setMenuAt(menuPoint.current)
  }
  const paste = (at: Point = menuPoint.current) => pasteImages(clipboardImages, (files) => images.upload(files, toWorld(at)), images.notify)
  // Encuadra marcos e imágenes ya ordenadas, como el fitView de Stitch tras Format.
  const format = () => runFormat({ nodes: images.nodes, frames: frames(), format: images.format, fit, later: (fn) => requestAnimationFrame(fn) })
  useSelectionKeys({ paste: (files) => void images.upload(files, toWorld(pointer())), empty: () => images.notify([CLIPBOARD_EMPTY]), format })
  const canPaste = images.ready && typeof navigator.clipboard?.read === 'function'

  const layer: ReactNode = (
    <>
      {band && (() => {
        const r = rectFrom(band.start, band.now)
        return <div className={styles.selectionRect} style={{ left: r.x, top: r.y, width: r.width, height: r.height }} aria-hidden="true" />
      })()}
      <CanvasMenu at={menuAt} onClose={() => setMenuAt(null)} undo={history.undo} redo={history.redo}
        onPaste={canPaste ? () => void paste() : null} onFormat={format}
        onUpload={images.ready ? (files) => void images.upload(files, toWorld(menuPoint.current)) : null} />
    </>
  )
  return { onPanePointerDown, onPanePointerMove, onPaneContextMenu, endGesture, paste, format, layer }
}
