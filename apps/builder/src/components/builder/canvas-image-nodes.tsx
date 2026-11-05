import { useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { contextSelection, toggleSelect, type CanvasNode, type Corner } from '@/lib/canvas-nodes'
import type { CanvasNodes } from '@/lib/use-canvas-nodes'
import styles from './builder.module.css'

interface ImageNodesProps {
  nodes: CanvasNodes
  zoom: number
  /** Solo con Seleccionar se eligen, arrastran y redimensionan; con Mano o Editar el puntero es de la cámara o de la página. */
  interactive: boolean
  /** Pantallas e imágenes comparten una sola selección, como los nodos de React Flow: elegir una imagen suelta la pantalla. */
  onPick: () => void
}

const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

/** En Stitch una imagen es un node-screen (I18nStore l.10461) y la pinta el mismo componente que las pantallas
 * (_Component126, DesignPage l.32038): etiqueta encima, badge W x H debajo con selección simple, placa de acento al
 * seleccionar, borde punteado al arrastrar y NodeResizer de proporción fija (l.32510-32531). */
export function ImageNodes({ nodes, zoom, interactive, onPick }: ImageNodesProps) {
  const gesture = useRef<{ pointer: number; start: { x: number; y: number }; resize?: { node: CanvasNode; corner: Corner } } | null>(null)
  const [dragging, setDragging] = useState(false)

  const onNodeDown = (id: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || e.button !== 0) return
    e.stopPropagation()
    const additive = e.shiftKey || e.metaKey
    // Arrastrar uno que no estaba elegido lo elige solo a él, como React Flow.
    const ids = additive || !nodes.selected.has(id) ? toggleSelect(nodes.selected, id, additive) : nodes.selected
    if (ids !== nodes.selected) nodes.select(id, additive)
    onPick()
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { pointer: e.pointerId, start: { x: e.clientX, y: e.clientY } }
    // La selección nueva todavía no llegó al estado: el arrastre arranca con la calculada aquí.
    nodes.startDrag(ids)
  }
  const onHandleDown = (node: CanvasNode, corner: Corner) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, resize: { node, corner } }
  }
  const onMove = (e: ReactPointerEvent) => {
    const g = gesture.current
    if (!g || g.pointer !== e.pointerId) return
    const dx = (e.clientX - g.start.x) / zoom, dy = (e.clientY - g.start.y) / zoom
    if (g.resize) {
      const { node, corner } = g.resize
      nodes.resize(node, node.width + (corner === 'nw' || corner === 'sw' ? -dx : dx), corner)
      return
    }
    if (!dragging && (dx || dy)) setDragging(true)
    nodes.drag(dx, dy)
  }
  // El menú de nodo de Stitch no está en los extracts: el clic derecho sobre una imagen solo ajusta la selección.
  const onNodeMenu = (id: string) => (e: ReactMouseEvent) => {
    e.preventDefault()
    if (!interactive) return
    const next = contextSelection(nodes.selected, id)
    if (next) nodes.selectMany(next, new Set())
    onPick()
  }
  const end = () => { gesture.current = null; setDragging(false); nodes.endDrag() }
  const single = nodes.selected.size === 1

  return (
    <>
      {nodes.nodes.map((n) => {
        const selected = nodes.selected.has(n.id)
        return (
          <div key={n.id} className={styles.imageNode} style={{ left: n.x, top: n.y, width: n.width, height: n.height } as CSSProperties}
            data-selected={selected || undefined} data-dragging={(selected && dragging) || undefined} data-interactive={interactive || undefined}
            onPointerDown={onNodeDown(n.id)} onContextMenu={onNodeMenu(n.id)} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}>
            <span className={styles.imageNodeLabel}>{n.name}</span>
            {selected && <span className={styles.imageNodePlate} aria-hidden="true" />}
            <div className={styles.imageNodeBody}>
              <img src={nodes.urlOf(n.src)} alt={n.name} draggable={false} className={styles.imageNodeImg} />
            </div>
            {selected && single && !dragging && <span className={styles.imageNodeSize}>{Math.round(n.width)} x {Math.round(n.height)}</span>}
            {selected && single && interactive && !dragging && CORNERS.map((c) => (
              <span key={c} className={styles.imageNodeHandle} data-corner={c} onPointerDown={onHandleDown(n, c)} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end} />
            ))}
          </div>
        )
      })}
    </>
  )
}
