// Nodos libres del lienzo (imágenes subidas), con el comportamiento del React Flow de Stitch
// (re-iteracion/stitch-ui/deob/wakaru/DesignPage-DeNbrR8l.js): snapGrid [16,16] (l.57917), borrar con Backspace o
// Delete (l.57925), multiselección con Shift o Meta (l.57929). No son versiones de la página: viven aparte y
// deshacer una versión no los toca.

import { nodeSize, rowXs } from './canvas-upload'

export interface CanvasNode {
  id: string
  kind: 'image'
  /** Ruta de la subida (`uploads/<slug>-<hash><ext>`): identifica la imagen; la URL que se pinta sale de ella. */
  src: string
  name: string
  x: number
  y: number
  width: number
  height: number
}

export const SNAP = 16
export const DELETE_KEYS: readonly string[] = ['Backspace', 'Delete']
/** Ancho de un nodo sin medidas conocidas (st.image de Stitch: max(512, ancho de IMAGE)). */
const FALLBACK = { width: 512, height: 512 }

export const snap = (v: number): number => Math.round(v / SNAP) * SNAP

/** Et de Stitch: la subida entra como fila desde el punto de drop, cada imagen escalada a 512 de ancho. */
export function placeImages(nodes: readonly CanvasNode[], items: readonly { id: string; src: string; name: string; width?: number; height?: number }[], origin: { x: number; y: number }): CanvasNode[] {
  const xs = rowXs(items.length, origin.x)
  return [
    ...nodes,
    ...items.map((it, i): CanvasNode => {
      const size = nodeSize(it.width, it.height)
      return { id: it.id, kind: 'image', src: it.src, name: it.name, x: snap(xs[i]!), y: snap(origin.y), width: size.width ?? FALLBACK.width, height: size.height ?? FALLBACK.height }
    }),
  ]
}

/** keepAspectRatio y minWidth 100 del NodeResizer de una imagen en Stitch (DesignPage l.32531). */
export const MIN_IMAGE_WIDTH = 100

/** La subida que ya tiene nodo (mismo `src`) no crea otro, como `add` de Stitch (index-BNt8DXHu l.4186). */
export const newUploads = <T extends { src: string }>(nodes: readonly CanvasNode[], items: readonly T[]): T[] =>
  items.filter((it, i) => !nodes.some((n) => n.src === it.src) && items.findIndex((o) => o.src === it.src) === i)

export type Corner = 'nw' | 'ne' | 'sw' | 'se'

/** NodeResizer con keepAspectRatio: el ancho manda, el alto sigue la proporción y la esquina opuesta queda fija. */
export function resizeNode(nodes: readonly CanvasNode[], start: CanvasNode, width: number, corner: Corner): CanvasNode[] {
  const w = Math.max(MIN_IMAGE_WIDTH, snap(width))
  const h = Math.round((start.height * w) / start.width)
  const x = corner === 'nw' || corner === 'sw' ? start.x + start.width - w : start.x
  const y = corner === 'nw' || corner === 'ne' ? start.y + start.height - h : start.y
  return nodes.map((n) => (n.id === start.id ? { ...n, x, y, width: w, height: h } : n))
}

/** Arrastre de los seleccionados: el desplazamiento se suma a la posición de origen y el resultado cae en la grilla. */
export function moveNodes(nodes: readonly CanvasNode[], from: ReadonlyMap<string, { x: number; y: number }>, dx: number, dy: number): CanvasNode[] {
  return nodes.map((n) => {
    const o = from.get(n.id)
    return o ? { ...n, x: snap(o.x + dx), y: snap(o.y + dy) } : n
  })
}

export const removeNodes = (nodes: readonly CanvasNode[], ids: ReadonlySet<string>): CanvasNode[] => nodes.filter((n) => !ids.has(n.id))

/** Click sobre un nodo: con Shift o Meta suma o quita de la selección; sin ellos queda solo ese. */
export function toggleSelect(selected: ReadonlySet<string>, id: string, additive: boolean): Set<string> {
  if (!additive) return new Set([id])
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Rectángulo entre dos puntos, en cualquier dirección del arrastre. */
export const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Rect =>
  ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) })

/** selectionMode Partial de Stitch (DesignPage l.58799): entra todo nodo que el rectángulo toque, aunque sea en parte. */
export const nodesInRect = (nodes: readonly CanvasNode[], r: Rect): string[] =>
  nodes.filter((n) => n.x < r.x + r.width && n.x + n.width > r.x && n.y < r.y + r.height && n.y + n.height > r.y).map((n) => n.id)

/** La caja `{x,y,w,h}` que cubre `box` y los rectángulos: fitView de Stitch tras Format encuadra marcos e imágenes. */
export function boundsWith(box: { x: number; y: number; w: number; h: number }, rects: readonly Rect[]): { x: number; y: number; w: number; h: number } {
  const x0 = Math.min(box.x, ...rects.map((r) => r.x)), y0 = Math.min(box.y, ...rects.map((r) => r.y))
  const x1 = Math.max(box.x + box.w, ...rects.map((r) => r.x + r.width)), y1 = Math.max(box.y + box.h, ...rects.map((r) => r.y + r.height))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** SA de Stitch (DesignPage l.46139-46181): dos nodos con menos de 50 px de diferencia en y cuentan como la misma fila. */
const ROW_TOLERANCE = 50
/** xA: ancho de fila antes de saltar a la siguiente. */
const ROW_MAX_WIDTH = 5000
/** betweenScreenOffset por defecto de wA (l.46238) y los 80 px extra entre filas de SA. */
export const FORMAT_GAP = 64
export const ROW_EXTRA = 80

/** Ordenar del menú del lienzo (Yj → TA → wA → SA): por fila y luego por x, y recoloca en filas de a lo sumo 5000 px
 * desde `origin`, con 64 px entre nodos y 64 + 80 entre filas. Devuelve nodos nuevos; la entrada no cambia. */
export function formatNodes(nodes: readonly CanvasNode[], origin: { x: number; y: number }): CanvasNode[] {
  const sorted = [...nodes].sort((a, b) => (Math.abs(a.y - b.y) > ROW_TOLERANCE ? a.y - b.y : a.x - b.x))
  const at = new Map<string, { x: number; y: number }>()
  let x = 0, y = 0, rowHeight = 0
  for (const n of sorted) {
    if (x > 0 && x + n.width > ROW_MAX_WIDTH) { y += rowHeight + FORMAT_GAP + ROW_EXTRA; x = 0; rowHeight = 0 }
    at.set(n.id, { x: origin.x + x, y: origin.y + y })
    x += n.width + FORMAT_GAP
    rowHeight = Math.max(rowHeight, n.height)
  }
  return nodes.map((n) => ({ ...n, ...at.get(n.id) }))
}

/** onNodeContextMenu de Stitch (DP l.58627-58660): sobre una imagen de una selección múltiple la conserva (null); si no,
 * elige solo esa. */
export function contextSelection(selected: ReadonlySet<string>, id: string): readonly string[] | null {
  return selected.size > 1 && selected.has(id) ? null : [id]
}

/** multiSelectionKeyCode de Stitch: con Shift/Meta el rectángulo suma a lo elegido al empezar (`base`); sin, lo reemplaza. */
export const mergeSelection = (ids: readonly string[], base: ReadonlySet<string>): ReadonlySet<string> => new Set([...base, ...ids])
