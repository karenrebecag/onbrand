// QA a629b7c, variante 0158db20: tras recargar, el iframe quedó con body vacío y un módulo pendiente más de 90 s. Un
// script de módulo sin terminar retiene el evento load del documento, así que un temporizador armado en onLoad no
// arranca nunca y el marco no pide remonte. Se arma al montar cada iframe, una vez por elemento y src (un src nuevo en el
// mismo elemento es otra carga).

export interface SilenceWatch<E extends object> {
  /** Un iframe montado (o su ref llamado de nuevo): arma la espera solo la primera vez que se ve ese elemento con ese src. */
  mount(el: E, src: string, id: string, chat: string | undefined): void
  /** El marco habló (wt:page-size); `sections` es lo que contó en #root (wt-size-bridge countSections). */
  report(id: string, sections?: number): void
  /** Al cerrar la corrida: el marco no habló desde que se montó, o su último reporte fue #root sin secciones. */
  blank(id: string): boolean
}

/** `generating(id)`: el marco está a mitad de una corrida, donde #root sin secciones es normal (el agente todavía no
 * escribió). Fuera de eso, un reporte con 0 secciones cuenta como silencio: QA caso 5, 38f87e66 cargó el index de vite
 * con #root vacío, el puente habló y la espera no lo rescató. */
export function createSilenceWatch<E extends object>(waitMs: number, onSilent: (chat: string | undefined) => void, schedule: (fn: () => void, ms: number) => void = (fn, ms) => { window.setTimeout(fn, ms) }, generating: (id: string) => boolean = () => false): SilenceWatch<E> {
  const armed = new WeakMap<E, string>()
  const heard = new Set<string>()
  const sections = new Map<string, number | undefined>()
  return {
    mount(el, src, id, chat) {
      if (armed.get(el) === src) return
      armed.set(el, src)
      heard.delete(id)
      sections.delete(id)
      schedule(() => { if (!heard.has(id) || (sections.get(id) === 0 && !generating(id))) onSilent(chat) }, waitMs)
    },
    report(id, n) { heard.add(id); sections.set(id, n) },
    // Una página sin puente de secciones (reporte sin `sections`) no se da por vacía.
    blank(id) { return !heard.has(id) || sections.get(id) === 0 },
  }
}

// QA grupo 1a48a96a, V2 003305cf: el agente borró secciones que App.tsx seguía importando, el HMR falló ("[vite] Failed
// to reload") y #root quedó vacío hasta después de settled; nada lo remontaba porque el marco sí había reportado (con 0
// secciones). Al cerrar cada corrida se remonta una vez el marco en blanco: la regla de R4.6 (re-ejecucion/builder.md
// §2.2, "pedir la url de nuevo y remontar") extendida a settled. `prev`/`next`: settled por id de corrida. Una corrida
// que aparece ya cerrada (rehidratada al recargar) no es un cierre nuevo: su marco recién se monta.
export function settledNow(prev: ReadonlyMap<string, boolean>, next: ReadonlyMap<string, boolean>): string[] {
  return [...next].flatMap(([id, settled]) => (settled && prev.get(id) === false ? [id] : []))
}
