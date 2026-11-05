import { emptyMessage, type MessageState } from '@engine/runtime/event-model'

// SideBySideLayoutStrategy de Stitch (I18nStore-D328XrU5 deob :22403-22525) con el procesado de nodos de BaseLayout
// (:22059-22217): las variantes van en una fila a la derecha de la pantalla fuente, con 64 de separación; lo que ya
// estaba a la derecha en esa franja se corre el ancho total, y cada placeholder se reemplaza cuando llega su pantalla.

/** betweenScreenOffset de la configuración de layouts (:22548-22551). */
export const BETWEEN_SCREEN_OFFSET = 64

/** Una pantalla del lienzo. `source` es la pantalla ya generada; `pending`, la que todavía se genera (placeholder). */
export interface Instance {
  id: string
  x: number
  y: number
  width: number
  height: number
  hidden?: boolean
  source?: string
  pending?: string
}

/** Una pantalla que trae la corrida: `pending` mientras no tiene contenido (isPending de Stitch). */
export interface OutputScreen { id: string; source: string; width: number; height: number; pending: boolean }

export type LayoutMutation =
  | { type: 'move'; id: string; x: number }
  | { type: 'commit'; id: string; source: string; width: number; height: number }

export interface LayoutResult { creates: Instance[]; mutations: LayoutMutation[] }

const bandOverlaps = (y: number, height: number, top: number, bandHeight: number): boolean =>
  y < top + bandHeight && y + Math.max(height, 1) > top

const hasCommitted = (source: string, existing: ReadonlyMap<string, Instance>): boolean =>
  [...existing.values()].some((i) => i.source === source && !i.pending)

const pendingOf = (source: string, existing: ReadonlyMap<string, Instance>): Instance[] =>
  [...existing.values()].filter((i) => i.pending === source)

/** La instancia seleccionada que llega más a la derecha (:22415-22425). */
function rightmost(selected: readonly Instance[], existing: ReadonlyMap<string, Instance>): Instance | null {
  return selected.reduce<Instance | null>((best, sel) => {
    const i = existing.get(sel.id) ?? sel
    if (i.hidden) return best
    return i.x + i.width > (best ? best.x + best.width : -Infinity) ? i : best
  }, null)
}

export function sideBySide(selected: readonly Instance[], existing: ReadonlyMap<string, Instance>, output: readonly OutputScreen[]): LayoutResult {
  const screens = output.filter((s, i) => output.findIndex((o) => o.id === s.id) === i)
  if (!screens.length) return { creates: [], mutations: [] }
  const gap = BETWEEN_SCREEN_OFFSET
  const ref = rightmost(selected, existing)
  const top = ref?.y ?? 0
  const band = Math.max(ref?.height ?? 0, 1)
  const insertX = (ref?.x ?? 0) + (ref?.width ?? 0) + gap
  const newIds = new Set(screens.map((s) => s.id))
  const selectedIds = new Set(selected.map((s) => s.id))
  // Si alguna ya está en la fila (una corrida anterior), lo nuevo sigue después de ella (:22437-22446).
  let cursor = [...existing.values()].reduce((x, i) =>
    !i.hidden && newIds.has(i.id) && bandOverlaps(i.y, i.height, top, band) ? Math.max(x, i.x + i.width + gap) : x, insertX)

  const bumps: LayoutMutation[] = []
  const fresh = screens.filter((s) => !hasCommitted(s.source, existing) && !pendingOf(s.source, existing).length)
  if (fresh.length) {
    const total = fresh.reduce((n, s) => n + s.width + gap, 0) - gap
    const right = [...existing.values()].filter((i) => !i.hidden && !selectedIds.has(i.id) && !newIds.has(i.id) && i.x >= insertX && bandOverlaps(i.y, i.height, top, band))
    const minX = Math.min(...right.map((i) => i.x))
    // Solo se corre lo que quedaría tapado por la fila nueva (:22481-22489).
    if (minX < cursor + total + gap) right.forEach((i) => bumps.push({ type: 'move', id: i.id, x: i.x + total + gap }))
  }

  const creates: Instance[] = []
  const commits: Extract<LayoutMutation, { type: 'commit' }>[] = []
  for (const s of screens) {
    if (hasCommitted(s.source, existing)) continue
    const waiting = pendingOf(s.source, existing)
    if (waiting.length) {
      // UPDATE_INSTANCE_WITH_COMMITTED_SOURCE (:22080-22118): el placeholder toma la pantalla y su tamaño final.
      if (!s.pending) waiting.forEach((i) => commits.push({ type: 'commit', id: i.id, source: s.source, width: s.width, height: s.height }))
      continue
    }
    creates.push({ id: s.id, x: cursor, y: top, width: s.width, height: s.height, ...(s.pending ? { pending: s.source } : { source: s.source }) })
    cursor += s.width + gap
  }
  return respace(existing, creates, [...bumps, ...commits])
}

/** SideBySide de varios grupos en una pasada: cada uno ve lo que crearon y movieron los anteriores, como cuando llegan
 * de a uno. Al recargar (R4.4) los grupos rehidratados llegan juntos; si todos calculaban contra el mismo lienzo, caían
 * en la misma x y la fila salía intercalada (QA caso 5, chat 9cbabeec). En orden de creación reproduce la fila de antes. */
export function sideBySideGroups(groups: readonly { source: Instance; screens: readonly OutputScreen[] }[], existing: ReadonlyMap<string, Instance>): LayoutResult {
  const canvas = new Map(existing)
  const created = new Map<string, Instance>()
  const mutations: LayoutMutation[] = []
  for (const g of groups) {
    const r = sideBySide([g.source], canvas, g.screens)
    for (const c of r.creates) { canvas.set(c.id, c); created.set(c.id, c) }
    for (const m of r.mutations) {
      const cur = canvas.get(m.id)
      const next = cur && (m.type === 'move' ? { ...cur, x: m.x } : (({ pending: _, ...rest }) => ({ ...rest, source: m.source, width: m.width, height: m.height }))(cur))
      if (next) canvas.set(m.id, next)
      // Lo creado en esta misma pasada sale con su estado final; lo que ya estaba viaja como mutación.
      if (next && created.has(m.id)) created.set(m.id, next)
      else mutations.push(m)
    }
  }
  return { creates: [...created.values()], mutations }
}

/** Re-espaciado después de commitear (:22128-22210): en cada fila con una pantalla que cambió de tamaño, todo se vuelve a
 * poner de izquierda a derecha con su ancho y 64 entre medio, desde la x de la primera. */
function respace(existing: ReadonlyMap<string, Instance>, creates: Instance[], mutations: LayoutMutation[]): LayoutResult {
  const sized = new Map(mutations.flatMap((m) => (m.type === 'commit' ? [[m.id, m.width] as const] : [])))
  if (!sized.size) return { creates, mutations }
  const moved = new Map(mutations.flatMap((m) => (m.type === 'move' ? [[m.id, m.x] as const] : [])))
  const rows = new Set([...sized.keys()].flatMap((id) => { const i = existing.get(id); return i ? [i.y] : [] }))
  const placed = new Map(creates.map((c) => [c.id, c]))
  const extra: LayoutMutation[] = []
  for (const y of rows) {
    const row = [
      ...[...existing.values()].filter((i) => !i.hidden && i.y === y).map((i) => ({ id: i.id, x: moved.get(i.id) ?? i.x, isNew: false })),
      ...creates.filter((c) => c.y === y && !existing.has(c.id)).map((c) => ({ id: c.id, x: c.x, isNew: true })),
    ].sort((a, b) => a.x - b.x)
    let next = row[0]?.x ?? 0
    for (const r of row) {
      const width = sized.get(r.id) ?? placed.get(r.id)?.width ?? existing.get(r.id)?.width ?? 0
      if (r.isNew) { const c = placed.get(r.id); if (c && c.x !== next) placed.set(r.id, { ...c, x: next }) }
      else if (r.x !== next) extra.push({ type: 'move', id: r.id, x: next })
      next += width + BETWEEN_SCREEN_OFFSET
    }
  }
  return { creates: creates.map((c) => placed.get(c.id) ?? c), mutations: [...mutations, ...extra] }
}

/** Una variante del grupo (S5, 6f08d0d): su chat propio, plegado de /runs/<messageId>/events. */
export interface VariantRun {
  messageId: string
  index: number
  state: MessageState
  settled: boolean
  /** `at` del primer evento y tiempo corrido según el log, como elapsedMs de un turno. */
  startedAt?: number
  elapsedMs?: number
  /** Commit de la versión fuente al lanzar el grupo: si el snapshot de la variante cierra en el mismo, no hubo versión. */
  sourceCommit?: string
}
/** `restored`: volvió del hilo al recargar; el lienzo no hace el pan de cierre, que es la respuesta a un pedido en vivo. */
export interface VariantGroup { groupId: string; sourceId: string; runs: VariantRun[]; restored?: true }

/** Los grupos que GET /chats devuelve al recargar (R4.4): sin esto los marcos de variante desaparecían del lienzo
 * (verificacion-91f2cb1.md). Los grupos en el orden en que llegaron, cada uno con sus variantes por index; el estado
 * sale después de reproducir el log de cada una. */
export function groupsFromThread(variants: { messageId: string; groupId: string; sourceId: string; index: number; queued?: boolean }[], commitOf: (messageId: string) => string | null | undefined): VariantGroup[] {
  const order = [...new Set(variants.map((v) => v.groupId))]
  return order.map((groupId) => {
    const runs = variants.filter((v) => v.groupId === groupId).sort((a, z) => a.index - z.index)
    const sourceId = runs[0].sourceId
    const sourceCommit = commitOf(sourceId)
    return { groupId, sourceId, restored: true as const, runs: runs.map((v) => ({ messageId: v.messageId, index: v.index, state: v.queued ? { ...emptyMessage(), queued: true as const } : emptyMessage(), settled: false, ...(sourceCommit ? { sourceCommit } : {}) })) }
  })
}
export type VariantStatus = 'pending' | 'done' | 'unchanged' | 'error' | 'stopped'

/** Pending hasta su message.end; después, cómo terminó (stop = lista, error, stopped = detenida). `unchanged` es un stop
 * cuyo snapshot cierra en el commit de la fuente. snapshot.files no sirve: solo lista los Write/Edit del agente, y una
 * variante que solo reemplazó fotos con generate_image también cambia la página (A8, c7c7ec26). En V2 b5a6614e el
 * snapshot cerró en 07fda3ed, el commit de su fuente 6cabe522. Sin uno de los dos commits no se afirma nada. En Stitch
 * esa sesión no pondría nada en el lienzo, que solo recibe las design.screens de la salida (collectSessionOutputNodes,
 * I18nStore deob :22555-22580); aquí el marco ya existe desde message.start, así que dice que no hubo versión. */
export function variantStatus(run: VariantRun): VariantStatus {
  const s = run.state.status
  if (s === 'streaming') return 'pending'
  if (s === 'error' || run.state.error) return 'error'
  if (s === 'stopped') return 'stopped'
  const commit = run.state.snapshot?.commit
  return commit && run.sourceCommit && commit === run.sourceCommit ? 'unchanged' : 'done'
}

/** Qué marcos de variante remontar: los que esta vista vio correr y acaban de cerrar, o que cerraron con otra versión.
 * Mientras la variante escribe, vite puede quedar en error por un import de una sección que ya borró y el iframe no se
 * recupera solo (rb-qa2 hallazgo 6); remontarlo al cerrar también trae las fotos reemplazadas en la misma ruta (A8).
 * Una variante que ya estaba cerrada al abrir el chat no se remonta: acaba de cargar con lo último. */
export function variantsToRemount(seen: ReadonlyMap<string, string>, runs: readonly VariantRun[]): { ids: string[]; seen: Map<string, string> } {
  const next = new Map(seen)
  const ids: string[] = []
  for (const run of runs) {
    const status = variantStatus(run)
    const mark = status === 'pending' ? 'pending' : `${status}:${run.state.snapshot?.commit ?? ''}`
    const before = seen.get(run.messageId)
    if (before !== undefined && before !== mark && mark !== 'pending') ids.push(run.messageId)
    next.set(run.messageId, mark)
  }
  return { ids, seen: next }
}

/** schedulePan al DONE de la sesión (I18nStore :18587-18597): una sola vez, cuando las N cerraron. */
export const groupSettled = (group: VariantGroup): boolean => group.runs.length > 0 && group.runs.every((r) => r.settled)

/** Las pantallas del grupo para sideBySide, en el orden de creación (collectSessionOutputNodes :22557-22575). Toman el
 * tamaño del marco fuente: Stitch crea el placeholder con las dimensiones de la fuente (createInstance :22218-22234). */
export function variantScreens(group: VariantGroup, source: { width: number; height: number }): OutputScreen[] {
  return [...group.runs].sort((a, b) => a.index - b.index).map((r) => ({
    id: r.messageId, source: r.messageId, width: source.width, height: source.height, pending: variantStatus(r) === 'pending',
  }))
}

const TREE_TOOLS = new Set(['generate_image', 'edit_image'])

/** La variante ya cambió su árbol: terminó bien una escritura del agente (Write/Edit) o una imagen generada o editada.
 * Hasta entonces su ws es la copia recién bifurcada de la fuente, y mostrarla se lee como "no hizo nada" (08dff459 y
 * 8f185369 en acd8bf5). Stitch deja la variante como placeholder sin pantalla hasta que la pantalla está lista (bv,
 * I18nStore deob :18558-18566, y UPDATE_INSTANCE_WITH_COMMITTED_SOURCE :22080-22118): nunca muestra la copia de la
 * fuente. Aquí se monta desde la primera escritura y no desde settled, para que se vea el render progresivo. */
export function variantWrote(run: VariantRun): boolean {
  return run.state.steps.some((s) => s.status === 'ok' && Boolean(s.parentStepId) && (s.kind === 'write' || TREE_TOOLS.has(s.tool ?? '')))
}

/** Si el marco de la variante monta su preview. Pending, desde la primera escritura (variantWrote). Fallida, solo si llegó
 * a escribir: entonces su última versión queda detrás del aviso; sin escrituras el ws es la copia de la fuente y se ve
 * solo el aviso. Es una decisión por analogía con handleFailedSession (I18nStore deob :22380-22400), que devuelve una
 * pantalla editada a su última versión comprometida; Stitch no define nada para una variante fallida (SideBySide :22403). */
export function variantShowsPreview(run: VariantRun): boolean {
  const status = variantStatus(run)
  return status === 'pending' || status === 'error' ? variantWrote(run) : true
}
