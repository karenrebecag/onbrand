// Dónde abre el "Edit Element" de Stitch (UgcTrustBanner `_Component9` con anchorMode 'right-edge', helpers `mi`, `hi`,
// `gi` y `_i`): a la derecha si caben 320 px, si no a la izquierda, abajo o arriba; a la altura del clic, no del centro
// del elemento, para que un texto largo no lo mande fuera de la pantalla; a 40 px, unido por la línea, y siempre dentro
// del lienzo (el Positioner de Stitch hace el shift).

export type Side = 'right' | 'left' | 'bottom' | 'top'
export interface Box { x: number; y: number; width: number; height: number }
export interface Placement { side: Side; anchor: { x: number; y: number }; popover: { x: number; y: number }; connectorEnd: { x: number; y: number } }

const PAD = 6 // fi
const ROOM = 320 // ui
export const SIDE_OFFSET = 40 // li
const EDGE = 8

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, Math.max(lo, hi)))

/** `el` y `clickY` en coordenadas del lienzo visible; `area` es su tamaño y `size` el del popover. */
export function placePopover(el: Box, clickY: number, area: { width: number; height: number }, size: { width: number; height: number }): Placement {
  const edges = { right: el.x + el.width + PAD, left: el.x - PAD, centerX: el.x + el.width / 2, top: el.y - PAD, bottom: el.y + el.height + PAD }
  const side: Side = edges.right + ROOM < area.width ? 'right' : edges.left - ROOM > 0 ? 'left' : edges.bottom + ROOM < area.height ? 'bottom' : 'top'
  // El clic puede quedar fuera de la vista si el elemento es más alto que ella: el ancla no sale del lienzo.
  const y = clamp(clickY, EDGE, area.height - EDGE)
  const anchor = side === 'right' ? { x: edges.right, y } : side === 'left' ? { x: edges.left, y } : side === 'bottom' ? { x: edges.centerX, y: edges.bottom } : { x: edges.centerX, y: edges.top }
  const maxX = area.width - size.width - EDGE
  const maxY = area.height - size.height - EDGE
  const popover = side === 'right' ? { x: anchor.x + SIDE_OFFSET, y: clamp(anchor.y - size.height / 2, EDGE, maxY) }
    : side === 'left' ? { x: anchor.x - SIDE_OFFSET - size.width, y: clamp(anchor.y - size.height / 2, EDGE, maxY) }
    : side === 'bottom' ? { x: clamp(anchor.x - size.width / 2, EDGE, maxX), y: clamp(anchor.y + SIDE_OFFSET, EDGE, maxY) }
    : { x: clamp(anchor.x - size.width / 2, EDGE, maxX), y: clamp(anchor.y - SIDE_OFFSET - size.height, EDGE, maxY) }
  const connectorEnd = side === 'right' ? { x: popover.x, y: anchor.y } : side === 'left' ? { x: popover.x + size.width, y: anchor.y }
    : side === 'bottom' ? { x: anchor.x, y: popover.y } : { x: anchor.x, y: popover.y + size.height }
  return { side, anchor, popover, connectorEnd }
}
