import type { RunRequest } from './run-client'
import type { StepState } from '@engine/runtime/event-model'

type Request = Omit<RunRequest, 'messageId' | 'parentId'>

// Tv de Stitch (DesignPage deob :14164-14244): un texto pendiente y otro hecho por tipo de sesión; sin entrada, "Thinking…"
// (:14288). De nuestros pedidos solo la edición con IA de lo seleccionado tiene par: DIRECT_EDIT_AI (:14208-14211).
export interface TurnLabel { pending: string; done: string }

export function turnLabel(request: Request): TurnLabel | undefined {
  return request.selectedSections?.length ? { pending: 'Actualizando la selección…', done: 'Selección actualizada' } : undefined
}

// Lovable (editor-body-shared deob :321-349): pasos fijos en orden; el estado sale por índice (:364-396) y el tiempo con
// Hd (:397-406). Sin estimados: los de Lovable son de su toolchain y los nuestros solo existen como medición de logs,
// que no fundamenta constantes. Los stepIds son los del contrato de fase de S4 §6, top-level.
export type Flow = 't1' | 'follow-up' | 'patch' | 'restore' | 'update-ds'
export interface Phase { label: string; stepIds: readonly string[] }
export type PhaseState = 'done' | 'active' | 'pending'

const PREPARE: Phase = {
  label: 'Preparando el proyecto',
  stepIds: ['runner:prepare', 'transport:brand', 'transport:facts', 'transport:connectors', 'transport:registry-open', 'transport:install', 'transport:ds', 'transport:skill', 'transport:preview-live'],
}
const SAVE: Phase = {
  label: 'Guardando la versión',
  stepIds: ['transport:build', 'transport:commit', 'transport:preview', 'transport:render', 'transport:registry'],
}
const WRITE_IDS = ['agent:direction', 'agent:trace', 'agent:write', 'agent:diff-check', 'transport:repair'] as const

export const PHASES: Readonly<Record<Flow, readonly Phase[]>> = {
  t1: [
    PREPARE,
    { label: 'Escribiendo la página', stepIds: WRITE_IDS },
    { label: 'Generando las imágenes', stepIds: ['agent:images', 'transport:images'] },
    SAVE,
  ],
  'follow-up': [
    PREPARE,
    { label: 'Aplicando los cambios', stepIds: WRITE_IDS },
    SAVE,
  ],
  patch: [
    { label: 'Aplicando la edición', stepIds: ['transport:text-edit', 'transport:delete-element', 'transport:replace-image', 'transport:section-op'] },
    SAVE,
  ],
  restore: [{ label: 'Restaurando la versión', stepIds: ['transport:restore'] }],
  // runUpdateDs (transport): restaura el padre si hace falta, aplica la marca y monta el DS nuevo; el build lo cierra.
  'update-ds': [
    { label: 'Actualizando el DS', stepIds: ['transport:restore', 'transport:brand', 'transport:registry-open', 'transport:ds', 'transport:skill'] },
    SAVE,
  ],
}

export function flowOf(request: Request, first: boolean): Flow {
  if (request.restoreFrom) return 'restore'
  if (request.updateDs) return 'update-ds'
  if (request.textEdit || request.deleteElement || request.replaceImage || request.sectionOp) return 'patch'
  return first ? 't1' : 'follow-up'
}

/** El paso activo es la fase más avanzada que ya arrancó, como activeStep de xo (:364-385); un id fuera de la tabla no
 * mueve nada, y sin pasos todavía la primera está activa. Con el turno fallado no hay activa (-1). */
export function activePhase(phases: readonly Phase[], steps: readonly StepState[], failed: boolean): number {
  if (failed) return -1
  return steps.reduce((at, s) => {
    if (s.parentStepId) return at
    const i = phases.findIndex((p) => p.stepIds.includes(s.id))
    return i > at ? i : at
  }, 0)
}

/** zd de Lovable (:386-396). */
export const phaseState = (index: number, active: number): PhaseState =>
  active < 0 ? 'pending' : index < active ? 'done' : index === active ? 'active' : 'pending'

/** Hd de Lovable (:397-406): "42s" o "3m 05s". */
export function formatPhaseTime(ms: number): string {
  const total = Math.max(Math.floor(ms / 1000), 0)
  const m = Math.floor(total / 60), s = total % 60
  return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, '0')}s`
}

/** Cuándo arrancó la fase, contado desde el primer paso del turno, para que el reloj de la activa salga del mismo tiempo
 * del turno (elapsedMs) y no del reloj de la máquina. */
export function phaseOffsetMs(phase: Phase, steps: readonly StepState[]): number | undefined {
  const top = steps.filter((s) => !s.parentStepId)
  const own = top.filter((s) => phase.stepIds.includes(s.id))
  if (!own.length) return undefined
  return Math.min(...own.map((s) => s.startedAt)) - Math.min(...top.map((s) => s.startedAt))
}

/** Lo que tardó una fase cerrada: del primer paso suyo que arrancó al último que terminó. */
export function phaseDurationMs(phase: Phase, steps: readonly StepState[]): number | undefined {
  const own = steps.filter((s) => !s.parentStepId && phase.stepIds.includes(s.id))
  const ends = own.map((s) => s.finishedAt).filter((t): t is number => t !== undefined)
  if (!own.length || !ends.length) return undefined
  return Math.max(...ends) - Math.min(...own.map((s) => s.startedAt))
}
