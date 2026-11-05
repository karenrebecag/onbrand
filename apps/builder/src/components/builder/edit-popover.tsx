import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, CopyPlusIcon, GlobeIcon, ImageUpIcon, ListPlusIcon, SparklesIcon, TextCursorIcon, Trash2Icon, XIcon } from 'lucide-react'
import { isImageUrl, loadsAsImage } from '@/lib/image-url'
import { NOTE_MAX, sourceLabel, sourceShort, type PickedElement } from '@/lib/element-context'
import type { SectionOp } from '@/lib/run-client'
import type { Suggestion } from '@engine/runtime/event-model'
import { placePopover, type Box } from '@/lib/popover-place'
import { Off } from './off'
import styles from './edit-popover.module.css'

// Entrada del popover de Stitch (DP:28364): opacidad y escala .88 -> 1 con el spring snappy (400 / 25 / .8).
const SNAPPY = { type: 'spring', stiffness: 400, damping: 25, mass: 0.8 } as const
// Los que el transport acepta para cambiar una imagen; SVG no, porque copiado a public/ ejecutaría su script si se abre.
const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif'

interface EditPopoverProps {
  element: PickedElement
  /** El elemento y la altura del clic en coordenadas del lienzo visible, y el tamaño de ese lienzo. */
  box: Box
  clickY: number
  area: { width: number; height: number }
  onClose: () => void
  /** Sin nota, el elemento entra como chip; con nota, como tarea de la cola. */
  onEditWithAI: (note?: string) => void
  onEditText: () => void
  /** Null si el elemento no se puede ubicar en el código: Eliminar queda apagado con su motivo. */
  onDelete: (() => void) | null
  /** Null si la imagen no tiene src que ubicar en el código. */
  onReplaceImage: ((next: { url: string } | { file: File }) => void) | null
  /** Con una corrida en curso el workspace está ocupado: el texto no tendría dónde guardarse. */
  busy: boolean
  /** Null si el elemento no está dentro de una sección de <main> (navbar, footer): no hay qué mover. */
  onSection: ((op: SectionOp) => void) | null
  /** Siguientes pasos propios de la sección del elemento; el click los manda dirigidos a ella. */
  suggestions: Suggestion[]
  onSuggest: (message: string) => void
}

/** "Edit Element" de Stitch (dinamico-rail.md r-05): a la derecha del elemento, unido por una línea con un punto. */
export function EditPopover({ element, box, clickY, area, onClose, onEditWithAI, onEditText, onDelete, onReplaceImage, busy, onSection, suggestions, onSuggest }: EditPopoverProps) {
  const reduced = useReducedMotion() ?? false
  const image = element.kind === 'image'
  const ref = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // Enter URL de Stitch reemplaza los ítems por el campo, prellenado con el src actual y seleccionado (i-08).
  const [urlMode, setUrlMode] = useState(false)
  const [noteMode, setNoteMode] = useState(false)
  // Se mide antes de pintar: con su alto real el popover se acomoda dentro del lienzo, como el shift del Positioner.
  const [size, setSize] = useState({ width: 200, height: 190 })
  useLayoutEffect(() => {
    const el = ref.current
    if (el && (el.offsetWidth !== size.width || el.offsetHeight !== size.height)) setSize({ width: el.offsetWidth, height: el.offsetHeight })
  }, [size, onDelete, busy, urlMode, onSection, suggestions])
  const { side, anchor, popover, connectorEnd } = placePopover(box, clickY, area, size)
  const horizontal = side === 'left' || side === 'right'
  return (
    <>
      <span className={styles.connector} data-side={side} aria-hidden="true" style={horizontal
        ? { left: Math.min(anchor.x, connectorEnd.x), top: anchor.y, width: Math.abs(connectorEnd.x - anchor.x) }
        : { left: anchor.x, top: Math.min(anchor.y, connectorEnd.y), height: Math.abs(connectorEnd.y - anchor.y) }}><i data-at={side} /></span>
      <motion.div
        ref={ref}
        role="dialog"
        aria-label={`Editar ${element.label.toLowerCase()}`}
        className={styles.popover}
        style={{ left: popover.x, top: popover.y }}
        initial={reduced ? false : { opacity: 0, scale: 0.88 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={reduced ? { duration: 0 } : SNAPPY}
      >
        <div className={styles.head}>
          <span>{image ? 'Editar imagen' : 'Editar elemento'}</span>
          {element.source && <code className={styles.source} title={sourceLabel(element.source)}>{sourceShort(element.source)}</code>}
          <button type="button" className={styles.close} aria-label="Cerrar" onClick={onClose}><XIcon size={16} /></button>
        </div>
        {urlMode && onReplaceImage ? (
          <UrlField initial={element.src ?? ''} onSubmit={(url) => onReplaceImage({ url })} />
        ) : noteMode ? (
          <NoteField initial={element.note ?? ''} onSubmit={(note) => onEditWithAI(note)} />
        ) : (
          <div className={styles.items}>
            {image ? (
              onReplaceImage && !busy ? (
                <>
                  <button type="button" className={styles.item} onClick={() => setUrlMode(true)}><GlobeIcon size={16} />Ingresar URL</button>
                  <button type="button" className={styles.item} onClick={() => fileRef.current?.click()}><ImageUpIcon size={16} />Subir imagen</button>
                  <input ref={fileRef} type="file" accept={IMAGE_TYPES} hidden tabIndex={-1} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onReplaceImage({ file }) }} />
                </>
              ) : (
                <>
                  <Off note={busy ? 'Ingresar URL: espera a que termine la corrida' : 'Ingresar URL: esta imagen no tiene src; usa Editar con IA'}><button type="button" className={styles.item} disabled><GlobeIcon size={16} />Ingresar URL</button></Off>
                  <Off note={busy ? 'Subir imagen: espera a que termine la corrida' : 'Subir imagen: esta imagen no tiene src; usa Editar con IA'}><button type="button" className={styles.item} disabled><ImageUpIcon size={16} />Subir imagen</button></Off>
                </>
              )
            ) : element.editable && !busy ? (
              <button type="button" className={styles.item} onClick={onEditText}><TextCursorIcon size={16} />Editar texto</button>
            ) : (
              <Off note={busy ? 'Editar texto: espera a que termine la corrida' : 'Editar texto: este texto tiene partes con otro formato; usa Editar con IA'}><button type="button" className={styles.item} disabled><TextCursorIcon size={16} />Editar texto</button></Off>
            )}
            <button type="button" className={styles.item} onClick={() => onEditWithAI()}><SparklesIcon size={16} />Editar con IA</button>
            <button type="button" className={styles.item} onClick={() => setNoteMode(true)}><ListPlusIcon size={16} />Agregar a la cola</button>
            {onDelete && !busy ? (
              <button type="button" className={styles.item} data-danger="" onClick={onDelete}><Trash2Icon size={16} />Eliminar</button>
            ) : (
              <Off note={busy ? 'Eliminar: espera a que termine la corrida' : 'Eliminar: este elemento no está escrito tal cual en el código; usa Editar con IA'}><button type="button" className={styles.item} data-danger="" disabled><Trash2Icon size={16} />Eliminar</button></Off>
            )}
          </div>
        )}
        {!urlMode && element.section && onSection && <SectionItems section={element.section} busy={busy} onSection={onSection} />}
        {/* Stitch oculta los chips con un turno corriendo (DesignPage :52576): el pedido no tendría versión sobre la que ir. */}
        {!urlMode && !busy && suggestions.length > 0 && (
          <div className={styles.suggestions} aria-label="Siguientes pasos de la sección">
            {suggestions.map((s) => <button key={s.message} type="button" className={styles.suggestion} title={s.title === s.message ? undefined : s.message} onClick={() => onSuggest(s.message)}>{s.title}</button>)}
          </div>
        )}
      </motion.div>
    </>
  )
}

/** Las cuatro operaciones de estructura, sin modelo: cada una es una versión que renumera archivos, plan y menú. */
function SectionItems({ section, busy, onSection }: { section: NonNullable<PickedElement['section']>; busy: boolean; onSection: (op: SectionOp) => void }) {
  const { slug, index, count } = section
  const wait = busy ? 'espera a que termine la corrida' : null
  const item = (label: string, icon: ReactNode, op: SectionOp, off: string | null, danger = false) => (off
    ? <Off key={label} note={`${label}: ${off}`}><button type="button" className={styles.item} data-danger={danger ? '' : undefined} disabled>{icon}{label}</button></Off>
    : <button key={label} type="button" className={styles.item} data-danger={danger ? '' : undefined} onClick={() => onSection(op)}>{icon}{label}</button>)
  return (
    <div className={styles.items} data-group="section" aria-label={`Sección ${slug}`}>
      <span className={styles.groupLabel}>Sección</span>
      {item('Subir', <ArrowUpIcon size={16} />, { op: 'move', slug, to: 'up' }, wait ?? (index === 0 ? 'ya es la primera' : null))}
      {item('Bajar', <ArrowDownIcon size={16} />, { op: 'move', slug, to: 'down' }, wait ?? (index === count - 1 ? 'ya es la última' : null))}
      {item('Duplicar', <CopyPlusIcon size={16} />, { op: 'duplicate', slug }, wait)}
      {item('Eliminar sección', <Trash2Icon size={16} />, { op: 'remove', slug }, wait, true)}
    </div>
  )
}

/** La nota de una tarea de la cola (Make Annotate): vacía no entra, porque una tarea sin pedido no le dice nada al agente. */
function NoteField({ initial, onSubmit }: { initial: string; onSubmit: (note: string) => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { ref.current?.focus() }, [])
  const note = value.trim()
  return (
    <form className={styles.urlForm} onSubmit={(e) => { e.preventDefault(); if (note) onSubmit(note) }}>
      <div className={styles.urlField}>
        <ListPlusIcon size={16} aria-hidden="true" />
        <input ref={ref} value={value} maxLength={NOTE_MAX} placeholder="Qué cambiar aquí…" aria-label="Nota de la tarea" onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className={styles.urlOk} aria-label="Agregar a la cola" disabled={!note}><CheckIcon size={16} /></button>
      </div>
    </form>
  )
}

/** El campo de Enter URL: la URL tiene que ser https y cargar como imagen; si no, queda abierto con el error (i-09). */
function UrlField({ initial, onSubmit }: { initial: string; onSubmit: (url: string) => void }) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { ref.current?.select() }, [])
  const submit = async () => {
    const url = value.trim()
    setChecking(true)
    const ok = isImageUrl(url) && await loadsAsImage(url)
    setChecking(false)
    if (ok) onSubmit(url); else setError(url.startsWith('http:') ? 'Usa una URL https: la página publicada no mostraría una imagen http' : 'Ingresa una URL de imagen válida')
  }
  return (
    <form className={styles.urlForm} onSubmit={(e) => { e.preventDefault(); if (!checking) void submit() }}>
      <div className={styles.urlField} data-error={error || undefined}>
        <GlobeIcon size={16} aria-hidden="true" />
        <input ref={ref} value={value} placeholder="Pega una URL…" aria-label="URL de la imagen" aria-invalid={!!error} aria-describedby={error ? 'wt-url-error' : undefined}
          onChange={(e) => { setValue(e.target.value); setError(null) }} />
        <button type="submit" className={styles.urlOk} aria-label="Aplicar" disabled={checking}><CheckIcon size={16} /></button>
      </div>
      {error && <p id="wt-url-error" className={styles.urlError} role="alert">{error}</p>}
    </form>
  )
}
