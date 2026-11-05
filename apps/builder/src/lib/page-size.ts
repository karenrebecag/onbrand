/** Lo que manda el puente de tamaño del scaffold (templates/base-scaffold/src/wt-size-bridge.ts). */
export interface PageSize {
  height: number
  viewport: number
  /** Secciones visibles; falta en páginas con un puente anterior al conteo. */
  sections?: number
}

const HEIGHT_MAX = 40000
// Tope de cordura: el conteo viene de una página que escribe el agente.
const SECTIONS_MAX = 1000
const isPx = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max

/** El mensaje viene de una página que escribe el agente: se valida y lo demás se descarta. */
export function parsePageSize(data: unknown): PageSize | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.type !== 'wt:page-size' || !isPx(d.height, HEIGHT_MAX) || !isPx(d.viewport, HEIGHT_MAX)) return null
  const sections = typeof d.sections === 'number' && Number.isInteger(d.sections) && d.sections >= 0 && d.sections <= SECTIONS_MAX ? d.sections : undefined
  return { height: Math.ceil(d.height), viewport: Math.ceil(d.viewport), ...(sections === undefined ? {} : { sections }) }
}

/**
 * Alto del frame para un reporte nuevo. Una sección de 100vh crece con el frame: al darle al iframe el alto de la
 * página, esa sección se estira, la página reporta más alto y el ciclo no termina. Si la página creció tanto como
 * el último resize que le hicimos, el crecimiento lo causamos nosotros y el frame se queda donde está.
 */
export function nextFrameHeight(current: number, previous: number, report: PageSize): number {
  const grewBy = current - previous
  const pageGrew = report.height - current
  if (report.viewport === current && grewBy > 0 && pageGrew > 0 && pageGrew >= grewBy * .9) return current
  return Math.min(HEIGHT_MAX, report.height)
}
