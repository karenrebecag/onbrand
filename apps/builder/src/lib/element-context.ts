/** Lo que manda wt-select-bridge (templates/base-scaffold/src/wt-select-bridge.ts) al elegir un elemento. */
export interface PickedElement {
  kind: 'text' | 'image'
  selector: string
  tagName: string
  label: string
  text: string
  src?: string
  /** Texto sin elementos dentro: el que Editar texto puede buscar tal cual en el código. */
  editable: boolean
  rect: { x: number; y: number; width: number; height: number }
  click?: { x: number; y: number }
  section?: { slug: string; index: number; count: number }
  /** archivo:línea:col del JSX que lo pintó (wt-source.ts, solo en dev). */
  /** Sin line/col cuando el puente solo sabe el archivo de la sección. */
  source?: { file: string; line?: number; col?: number }
  /** La nota de la persona para este elemento: lo convierte en una tarea de la cola (Make, FIGMA-APP :439215-439245). */
  note?: string
}

export const NOTE_MAX = 500

/** Como el Source de Make Annotate (figma_app deob :440813-440820): la línea que va al chip y al agente. */
export const sourceLabel = (s: NonNullable<PickedElement['source']>): string => [s.file, s.line, s.col].filter((v) => v !== undefined).join(':')
/** Lo que se ve en el chip: archivo y línea, o solo el archivo si no hay línea (no se inventa una). */
export const sourceShort = (s: NonNullable<PickedElement['source']>): string => `${s.file.split('/').pop()}${s.line ? `:${s.line}` : ''}`

const SELECTOR_MAX = 512
const TAG_MAX = 32
const TEXT_MAX = 500
const ELEMENTS_MAX = 20

// Mismo formato que valida el transport (section-ops.ts): el slug viaja tal cual al POST.
const SECTION_SLUG = /^\d{2}-[a-z0-9-]+$/
// Una ruta relativa del workspace: sin saltos de línea ni backticks, que se leerían como parte del pedido.
const SOURCE_FILE = /^[\w@./-]{1,256}$/
const posInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max + 1 ? v : null)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** El mensaje lo escribe una página que generó el agente: se valida con los topes de Stitch (Sp/Cp) y lo demás se descarta. */
export function parsePicked(data: unknown): PickedElement | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.type !== 'wt:element-clicked' || (d.kind !== 'text' && d.kind !== 'image')) return null
  const selector = str(d.selector, SELECTOR_MAX)
  const tagName = str(d.tagName, TAG_MAX)
  const label = str(d.label, 40)
  const text = str(d.text ?? '', TEXT_MAX + 1)
  const r = d.rect as Record<string, unknown> | undefined
  if (!selector || !tagName || !label || text === null || !r || ![r.x, r.y, r.width, r.height].every(num)) return null
  // data: y blob: no viajan: pueden pesar megas y no le dicen nada al agente.
  const src = typeof d.src === 'string' && !/^(data|blob):/.test(d.src) ? d.src.slice(0, SELECTOR_MAX) : undefined
  const c = d.click as Record<string, unknown> | undefined
  const click = c && num(c.x) && num(c.y) ? { x: c.x as number, y: c.y as number } : undefined
  const sec = d.section as Record<string, unknown> | undefined
  const section = sec && typeof sec.slug === 'string' && SECTION_SLUG.test(sec.slug) && Number.isInteger(sec.index) && Number.isInteger(sec.count) && (sec.index as number) >= 0 && (sec.index as number) < (sec.count as number)
    ? { slug: sec.slug, index: sec.index as number, count: sec.count as number }
    : undefined
  const so = d.source as Record<string, unknown> | undefined
  const fileOk = so && typeof so.file === 'string' && SOURCE_FILE.test(so.file) && !so.file.includes('..')
  // line y col van juntos: los dos o ninguno (solo archivo).
  const lineOk = so && ((posInt(so.line) && posInt(so.col)) || (so.line === undefined && so.col === undefined))
  const source = so && fileOk && lineOk
    ? { file: so.file as string, ...(so.line !== undefined ? { line: so.line as number, col: so.col as number } : {}) }
    : undefined
  return { kind: d.kind, selector, tagName, label, text, ...(src ? { src } : {}), editable: d.editable === true, rect: { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number }, ...(click ? { click } : {}), ...(section ? { section } : {}), ...(source ? { source } : {}) }
}

/** Respuesta del puente al Marco (wt:rect-elements): cada elemento con la misma validación que un clic, y con tope. */
export function parseRectElements(data: unknown): PickedElement[] | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.type !== 'wt:rect-elements' || !Array.isArray(d.elements)) return null
  return d.elements.slice(0, RECT_ELEMENTS_MAX).flatMap((e) => {
    const el = typeof e === 'object' && e !== null ? parsePicked({ ...e, type: 'wt:element-clicked' }) : null
    return el ? [el] : []
  })
}
const RECT_ELEMENTS_MAX = 8

const EDIT_MAX = 2000

/** Cómo encuentra el transport el elemento en el código: el texto de una hoja o el src de una imagen. Lo que viene
 * cortado por el puente (… al final) no coincidiría con nada. */
export function deleteTargetOf(el: PickedElement): { kind: 'text'; text: string } | { kind: 'image'; src: string } | null {
  if (el.kind === 'image') return el.src ? { kind: 'image', src: el.src } : null
  if (!el.editable || !el.text || el.text.length > TEXT_MAX) return null
  return { kind: 'text', text: el.text }
}

/** El texto editado en la página (wt:text-changed): mismo tope que el transport, para no mandar lo que va a rechazar. */
export function parseTextChanged(data: unknown): { before: string; after: string } | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.type !== 'wt:text-changed' || typeof d.before !== 'string' || typeof d.after !== 'string') return null
  if (d.before.length > EDIT_MAX || d.after.length > EDIT_MAX) return null
  return { before: d.before, after: d.after }
}

/** "Edit With AI" de Stitch (DP:12600-12610): el pedido lleva delante qué elemento tocar, con selector, etiqueta y
 * texto actual; con varios, la lista. El motor no necesita un campo nuevo para entenderlo. */
export function withElementContext(prompt: string, elements: PickedElement[]): string {
  const list = elements.slice(0, ELEMENTS_MAX)
  if (!list.length) return prompt
  // El texto sale de la página, que escribió el agente: tres backticks cerrarían el bloque y lo que siga se leería
  // como pedido de la persona.
  const fenced = (v: string) => v.replace(/`{3,}/g, '``')
  let task = 0
  const block = (e: PickedElement) => [
    // "Task N: nota" de Make (FIGMA-APP :439215-439222), numerado solo entre los elementos que traen nota.
    ...(e.note ? [`Tarea ${++task}: ${fenced(e.note)}`] : []),
    ...(e.section ? [`Sección: ${e.section.slug}`] : []),
    ...(e.source ? [`Origen: ${sourceLabel(e.source)}`] : []),
    `Selector: ${fenced(e.selector)}`,
    `Etiqueta: <${e.tagName}>`,
    e.kind === 'image' ? `Imagen actual: ${fenced(e.src ?? '(sin src)')}` : `Texto actual: ${fenced(e.text || '(vacío)')}`,
  ].join('\n')
  const head = list.length === 1 ? 'Modifica este elemento de la página:' : 'Modifica estos elementos de la página:'
  return `${head}\n\`\`\`\n${list.map(block).join('\n\n')}\n\n${scopeRule(list.length)}\n\`\`\`\n\n${prompt}`
}

/** [Selection Scope Rules] y "Scope: only this selected instance" de Make (figma_app deob :439591-439593, :439845): sin
 * esto el agente toma el elemento de un .map o de un componente compartido como todos los de su tipo. */
export function scopeRule(count: number): string {
  return [
    count > 1 ? `Alcance: solo estas ${count} instancias.` : 'Alcance: solo esta instancia.',
    'Cambia solo las instancias elegidas. No las trates como todos los elementos del mismo tipo, etiqueta, componente, clase, iteración de un bucle o implementación compartida, salvo que el pedido lo diga.',
  ].join('\n')
}

/** Los elementos con nota son la cola; "Applied N changes" de Make (FIGMA-APP :439224) da el texto del envío. */
export const tasksOf = (elements: readonly PickedElement[]): PickedElement[] => elements.filter((e) => e.note)
export const applyTasksPrompt = (n: number): string => (n === 1 ? 'Aplica este cambio.' : `Aplica estos ${n} cambios.`)

/** Agregar un elemento que ya está en la lista reemplaza su nota en vez de duplicarlo. */
export function addElement(list: readonly PickedElement[], rawEl: PickedElement): PickedElement[] {
  // NOTE_MAX lo pone el input del popover; aquí también, porque la nota llega al pedido por cualquier camino que llame esto.
  const el = rawEl.note && rawEl.note.length > NOTE_MAX ? { ...rawEl, note: rawEl.note.slice(0, NOTE_MAX) } : rawEl
  return list.some((e) => e.selector === el.selector) ? list.map((e) => (e.selector === el.selector ? el : e)) : [...list, el]
}

/** Las secciones de los elementos elegidos, sin repetir: el campo `selectedSections` del pedido, como selectedNodeIds
 * de Stitch (DesignPage wakaru l.43216). */
export const sectionsOf = (elements: readonly PickedElement[]): string[] =>
  [...new Set(elements.flatMap((e) => (e.section ? [e.section.slug] : [])))]

const CONTEXT_HEAD = /^Modifica (?:este elemento|estos elementos) de la página:\n```\n[\s\S]*?\n```\n\n/

/** Lo que la persona escribió, sin el bloque del elemento: Stitch muestra userDisplayPrompt, no el pedido armado. */
export const displayPrompt = (prompt: string): string => prompt.replace(CONTEXT_HEAD, '')
