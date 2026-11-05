import { useCallback, useEffect, useRef, useState } from 'react'
import { checkUploads, mapPool, UPLOAD_CONCURRENCY, UPLOAD_MESSAGES, uploadPath } from './canvas-upload'
import { formatNodes, mergeSelection, moveNodes, newUploads, placeImages, removeNodes, resizeNode, toggleSelect, type CanvasNode, type Corner } from './canvas-nodes'
import { uploadCanvasFile, type CanvasDoc } from './run-client'
import type { CanvasWriter } from './canvas-writer'
import { chatBase } from './chat-routes'
import type { MediaUrls } from './media-urls'

// placeFileOnCanvas de Stitch (DesignPage l.11852): valida, sube de a 3, coloca en fila desde el punto y avisa los
// errores. Con transport el documento lo carga useBuilder (GET /chats/:chatId/canvas al recargar, vacío en una raíz
// nueva) y aquí se guarda con PUT y rev; sin transport (modo de ejemplo) queda en el navegador como blob:.

/** Espera tras el último cambio antes de guardar, como el autosave de Stitch que se pausa mientras se arrastra (l.58587). */
const SAVE_DELAY_MS = 400
const NO_CHAT = 'Primero pide una página: las imágenes del lienzo se guardan con el chat'

export interface CanvasNodes {
  nodes: CanvasNode[]
  selected: ReadonlySet<string>
  /** Hay dónde guardar: con transport hace falta un chat; sin transport, el modo de ejemplo guarda en el navegador. */
  ready: boolean
  /** creatingImageScreens de Stitch (DesignPage l.41212): el rail muestra un spinner mientras sube. */
  uploading: boolean
  /** Avisos de la última subida, uno por clase de problema; `ok` es el "Uploaded" de Stitch cuando todo entró. */
  notices: string[]
  ok: boolean
  /** La URL que pinta un nodo a partir de su `src`; undefined mientras se firma (media-urls.ts). */
  urlOf: (src: string) => string | undefined
  resize: (start: CanvasNode, width: number, corner: Corner) => void
  dismissNotices: () => void
  /** Aviso fuera de una subida (pegar sin imagen, portapapeles bloqueado), en el mismo toast. */
  notify: (messages: string[]) => void
  upload: (files: readonly File[], at: { x: number; y: number }) => Promise<void>
  select: (id: string, additive: boolean) => void
  /** Rectángulo de selección: reemplaza la selección o, con Shift/Meta, la suma a la que había al empezar (`base`). */
  selectMany: (ids: readonly string[], base: ReadonlySet<string>) => void
  clearSelection: () => void
  /** Arrastre: `start` fija el origen de los elegidos y pausa el guardado; `drag` mueve; `end` lo reanuda. */
  startDrag: (ids: ReadonlySet<string>) => void
  drag: (dx: number, dy: number) => void
  endDrag: () => void
  removeSelected: () => void
  /** Ordenar del menú del lienzo: recoloca todas las imágenes en filas desde `origin`, un solo guardado. */
  format: (origin: { x: number; y: number }) => void
}

/** Medidas naturales de la imagen; si no decodifica, el nodo entra con el tamaño por defecto. */
async function measure(src: string): Promise<{ width?: number; height?: number }> {
  const img = new Image()
  img.src = src
  try {
    await img.decode()
    return { width: img.naturalWidth, height: img.naturalHeight }
  } catch {
    return {}
  }
}

export function useCanvasNodes(api: string | undefined, chatId: string | undefined, canvas?: CanvasDoc, setCanvas?: (doc: CanvasDoc) => void, writer?: CanvasWriter | null, media?: MediaUrls): CanvasNodes {
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [uploading, setUploading] = useState(false)
  const [notices, setNotices] = useState<string[]>([])
  const [ok, setOk] = useState(false)
  const origin = useRef(new Map<string, { x: number; y: number }>())
  const blobs = useRef(new Map<string, string>())
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const rev = useRef(0)
  const dirty = useRef(0)
  const dragging = useRef(false)
  const ready = !api || Boolean(chatId)

  useEffect(() => () => blobs.current.forEach((u) => URL.revokeObjectURL(u)), [])

  // El documento de useBuilder manda cuando cambia desde afuera (recarga, raíz nueva): reemplaza los nodos y descarta un
  // guardado pendiente, que iría con el rev del chat anterior. Lo que vuelve de un PUT propio solo actualiza el rev, para
  // no pisar lo que se movió mientras viajaba.
  const ownSave = useRef<CanvasDoc | null>(null)
  const generation = useRef(0)
  // Un cambio que deja la misma lista de nodos (la estrella de una variante) solo trae rev nuevo: no pisa lo que se
  // movió y todavía no se guardó.
  const lastNodes = useRef<CanvasDoc['nodes'] | null>(null)
  useEffect(() => {
    if (!canvas) return
    rev.current = canvas.rev
    const same = canvas === ownSave.current || canvas.nodes === lastNodes.current
    lastNodes.current = canvas.nodes
    if (same) return
    generation.current++
    dirty.current = 0
    setNodes(canvas.nodes)
    setSelected(new Set())
  }, [canvas])

  // Guarda lo último tras una pausa; si otra pestaña guardó antes, queda lo del server (el 409 trae el documento actual).
  const [tick, setTick] = useState(0)
  const change = useCallback((fn: (n: CanvasNode[]) => CanvasNode[]) => {
    setNodes(fn)
    dirty.current++
    setTick((t) => t + 1)
  }, [])
  useEffect(() => {
    if (!writer || !dirty.current || dragging.current) return
    const at = dirty.current
    const gen = generation.current
    const id = window.setTimeout(() => {
      writer.write(rev.current, { nodes: nodesRef.current })
        .then((r) => {
          if (gen !== generation.current) return
          if ('conflict' in r) { setCanvas?.(r.conflict); return }
          rev.current = r.saved.rev
          ownSave.current = r.saved
          setCanvas?.(r.saved)
          if (dirty.current === at) dirty.current = 0
        })
        .catch(() => setNotices([UPLOAD_MESSAGES.failed]))
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [writer, tick, setCanvas])

  // El server guarda `src` como /chats/<id>/canvas/files/<n> (canvas-store.ts); la ruta de §4 es lo que sigue al chat.
  const signedPath = (src: string) => (api && src.startsWith('/chats/') ? src.split('/').slice(3).join('/') : undefined)
  const urlOf = useCallback((src: string) => {
    const path = signedPath(src)
    return path ? media?.url(path) : blobs.current.get(src) ?? src
  }, [api, media])

  /** Sube un archivo: al server si hay chat (que lo nombra por su contenido), si no a un blob: con la ruta de Stitch. */
  const store = useCallback(async (f: File): Promise<string> => {
    if (api && chatId) return (await uploadCanvasFile(chatBase(api, chatId), f)).src
    const src = await uploadPath(f)
    if (!blobs.current.has(src)) blobs.current.set(src, URL.createObjectURL(f))
    return src
  }, [api, chatId])

  const upload = useCallback(async (files: readonly File[], at: { x: number; y: number }) => {
    if (!ready) { setNotices([NO_CHAT]); return }
    const check = checkUploads(files)
    setNotices(check.errorMessages)
    setOk(false)
    if (!check.valid.length) return
    setUploading(true)
    try {
      const all = await mapPool(check.valid, UPLOAD_CONCURRENCY, async (f) => {
        const src = await store(f)
        const path = signedPath(src)
        return { id: crypto.randomUUID(), src, name: f.name, ...(await measure(path && media ? await media.get(path) : urlOf(src) ?? src)) }
      })
      const items = newUploads(nodesRef.current, all)
      if (items.length) change((n) => placeImages(n, items, at))
      // Una imagen que ya estaba no crea otro nodo: queda elegida la existente, como `add` de Stitch.
      setSelected(new Set(all.map((i) => nodesRef.current.find((n) => n.src === i.src)?.id ?? i.id)))
      setOk(check.errorMessages.length === 0)
    } catch {
      setNotices((n) => [...n, UPLOAD_MESSAGES.failed])
    } finally {
      setUploading(false)
    }
  }, [ready, store, urlOf, change, media])

  const select = useCallback((id: string, additive: boolean) => setSelected((s) => toggleSelect(s, id, additive)), [])
  const selectMany = useCallback((ids: readonly string[], base: ReadonlySet<string>) => setSelected(mergeSelection(ids, base)), [])
  const clearSelection = useCallback(() => setSelected((s) => (s.size ? new Set() : s)), [])
  const startDrag = useCallback((ids: ReadonlySet<string>) => {
    dragging.current = true
    origin.current = new Map(nodesRef.current.filter((n) => ids.has(n.id)).map((n) => [n.id, { x: n.x, y: n.y }]))
  }, [])
  const drag = useCallback((dx: number, dy: number) => change((n) => moveNodes(n, origin.current, dx, dy)), [change])
  const endDrag = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    setTick((t) => t + 1)
  }, [])
  const removeSelected = useCallback(() => {
    if (!selected.size) return
    change((n) => removeNodes(n, selected))
    setSelected(new Set())
  }, [selected, change])
  const format = useCallback((origin: { x: number; y: number }) => change((n) => formatNodes(n, origin)), [change])
  const dismissNotices = useCallback(() => { setNotices([]); setOk(false) }, [])
  const notify = useCallback((messages: string[]) => { setNotices(messages); setOk(false) }, [])
  const resize = useCallback((start: CanvasNode, width: number, corner: Corner) => change((n) => resizeNode(n, start, width, corner)), [change])

  return { nodes, selected, ready, uploading, notices, ok, urlOf, resize, dismissNotices, notify, upload, select, selectMany, clearSelection, startDrag, drag, endDrag, removeSelected, format }
}
