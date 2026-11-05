// Lo que el builder lee de page.json: el título de la página y lo que el agente dejó en page.json.agent (sugerencias,
// imágenes pendientes, plan). La marca de valores "plausibles" y su patch se retiraron con el runner (C5, #851).

import { PLAN_FIELDS, type PagePlanMd, type PlanSection } from '@engine/page-plan-md'
import { asSuggestions } from '@engine/runtime/agent-summary'
import type { Suggestion } from '@engine/runtime/event-model'

export const PAGE_FILE = 'page.json'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** El título lo escribe el plan en page.json.page.title (PageContract); el prompt es solo el respaldo antes del primer commit. */
export function pageTitleFromFiles(files: { path: string; content: string }[]): string | undefined {
  const file = files.find((f) => f.path === PAGE_FILE)
  if (!file) return undefined
  try {
    const doc: unknown = JSON.parse(file.content)
    const title = isRecord(doc) && isRecord(doc.page) ? doc.page.title : undefined
    return typeof title === 'string' && title.trim() ? title.trim() : undefined
  } catch {
    return undefined
  }
}

// page.json.agent lo escribe el composer al cerrar el turno; un page.json viejo o a medio escribir no lo trae.
function agentOf(files: { path: string; content: string }[]): Record<string, unknown> | undefined {
  const file = files.find((f) => f.path === PAGE_FILE)
  if (!file) return undefined
  try {
    const doc: unknown = JSON.parse(file.content)
    return isRecord(doc) && isRecord(doc.agent) ? doc.agent : undefined
  } catch {
    return undefined
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [])

/** Siguientes pasos que el agente dejó en page.json.agent.suggestions (como los chips de Stitch). Hasta 3, sin vacíos. */
export function suggestionsFromFiles(files: { path: string; content: string }[]): Suggestion[] {
  return asSuggestions(agentOf(files)?.suggestions).slice(0, 3)
}

/** Sugerencias por sección (agent.sectionSuggestions), hasta 5 por slug: como Stitch por pantalla seleccionada. */
export function sectionSuggestionsFromFiles(files: { path: string; content: string }[]): Record<string, Suggestion[]> {
  const raw = agentOf(files)?.sectionSuggestions
  if (!isRecord(raw)) return {}
  return Object.fromEntries(Object.entries(raw).flatMap(([slug, v]) => { const list = asSuggestions(v).slice(0, 5); return list.length ? [[slug, list]] : [] }))
}

/** Rutas de imagen que el generador no pudo llenar: en la página llevan un placeholder gris hasta otro turno. */
export function pendingImagesFromFiles(files: { path: string; content: string }[]): string[] {
  const images = agentOf(files)?.images
  return isRecord(images) ? strings(images.pending) : []
}

/** page-plan.md parseado (agent.plan, ADR 0012), solo con las secciones bien formadas; sin secciones no hay plan. */
export function planFromFiles(files: { path: string; content: string }[]): PagePlanMd | undefined {
  const plan = agentOf(files)?.plan
  if (!isRecord(plan) || !Array.isArray(plan.sections)) return undefined
  const sections = plan.sections.flatMap((s): PlanSection[] => {
    if (!isRecord(s) || typeof s.slug !== 'string' || typeof s.role !== 'string') return []
    const raw = isRecord(s.fields) ? s.fields : {}
    const fields = Object.fromEntries(PLAN_FIELDS.flatMap((k) => (typeof raw[k] === 'string' && raw[k] ? [[k, raw[k]]] : [])))
    return [{ slug: s.slug, role: s.role, ...(typeof s.anchor === 'string' ? { anchor: s.anchor } : {}), fields }]
  })
  return sections.length ? { header: strings(plan.header), sections } : undefined
}
