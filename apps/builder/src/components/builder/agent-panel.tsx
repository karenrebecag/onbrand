import { Children, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Check, ChevronDown, CircleCheck, CircleMinus, Clock, Cpu, CircleX, Copy, LoaderCircle, RocketIcon, UserRound, XCircle } from 'lucide-react'
import { useCopyFeedback } from '@/components/arc/lib/use-copy-feedback'
import { parseMarkdown, wordCount, type Inline } from '@/lib/mini-markdown'
import { endFlagsOf, notesOf, statusLine, summaryMarkdown, toolUpdates, UPDATES_SHOWN, type ToolUpdate, type UpdateStatus } from '@/lib/run-state'
import type { Turn } from '@/lib/use-builder'
import type { Spend } from '@/lib/spend'
import { SpendMeter } from './spend-meter'
import { durationTooltip, formatCompact, formatDuration, tokensTooltip, totalTokens, useLiveElapsed, type TokenUsage } from '@/lib/run-cost'
import { displayPrompt } from '@/lib/element-context'
import { activePhase, flowOf, formatPhaseTime, phaseDurationMs, phaseOffsetMs, PHASES, phaseState, turnLabel } from '@/lib/turn-phases'
import { Off } from './off'
import styles from './agent-panel.module.css'

// Tiempos del panel de Stitch (DesignPage DF y surface: Ll, Rl, Fl.slow): cada palabra entra 1 s con blur, 80 ms
// detrás de la anterior y sin pasar de 1,2 s de retraso; lo de abajo del resumen entra al 70 % del reveal.
const WORD_STAGGER = 0.08
const WORD_DELAY_MAX = 1.2
const WORD_MS = 1
const EXTRAS_AT = 0.7

type Counter = { n: number }

function Words({ text, counter }: { text: string; counter?: Counter }) {
  if (!counter) return <>{text}</>
  return <>{text.split(/(\s+)/).map((w, i) => {
    if (!w || /^\s+$/.test(w)) return w
    const delay = Math.min(counter.n++ * WORD_STAGGER, WORD_DELAY_MAX)
    return <span key={i} className={styles.word} style={{ '--d': `${delay}s` } as CSSProperties}>{w}</span>
  })}</>
}

function Inlines({ parts, counter }: { parts: Inline[]; counter?: Counter }) {
  return <>{parts.map((p, i) => p.kind === 'strong' ? <strong key={i}><Words text={p.text} counter={counter} /></strong>
    : p.kind === 'em' ? <em key={i}><Words text={p.text} counter={counter} /></em>
    : p.kind === 'code' ? <code key={i}><Words text={p.text} counter={counter} /></code>
    : <span key={i}><Words text={p.text} counter={counter} /></span>)}</>
}

/** Con `reveal`, el texto entra palabra por palabra como el resumen de Stitch. */
export function Markdown({ text, reveal = false }: { text: string; reveal?: boolean }) {
  const counter = reveal ? { n: 0 } : undefined
  const out = <div className={styles.markdown}>{parseMarkdown(text).map((b, i) => b.kind === 'heading' ? <p key={i} className={styles.mdHeading}><Inlines parts={b.inline} counter={counter} /></p>
    : b.kind === 'paragraph' ? <p key={i}><Inlines parts={b.inline} counter={counter} /></p>
    : <ul key={i}>{b.items.map((it, j) => <li key={j} data-depth={it.depth || undefined}><Inlines parts={it.inline} counter={counter} /></li>)}</ul>)}</div>
  return out
}

/** El chip del prompt de Stitch: el pedido en una línea, copiar y desplegar el texto entero. */
function PromptChip({ prompt, rise }: { prompt: string; rise: boolean }) {
  const [open, setOpen] = useState(false)
  const { state, copy } = useCopyFeedback()
  return (
    <div className={styles.promptChip} data-open={open || undefined} data-rise={rise || undefined}>
      <UserRound size={16} aria-hidden="true" className={styles.promptAvatar} />
      <p className={styles.promptText}>{prompt}</p>
      <button type="button" className={styles.chipButton} aria-label={state === 'copied' ? 'Copiado' : 'Copiar prompt'} title={state === 'copied' ? 'Copiado' : 'Copiar prompt'} onClick={() => void copy(prompt)}>
        {state === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      </button>
      <button type="button" className={styles.chipButton} aria-expanded={open} aria-label={open ? 'Contraer prompt' : 'Ver prompt completo'} onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={16} aria-hidden="true" className={styles.chevron} />
      </button>
    </div>
  )
}

interface AgentPanelProps {
  turn: Turn
  /** Pasos, salidas de tools y aprobaciones: Stitch no los muestra, pero aquí hay aprobaciones reales que no pueden perderse. */
  steps: ReactNode
  /** Abre los pasos solo, porque una aprobación pendiente detiene la corrida hasta que alguien decida. */
  needsDecision: boolean
  footer: ReactNode
  /** El primer turno del chat: elige la tabla de fases del T1 (fila 21). */
  first: boolean
  /** Gasto del día de la cuenta (GET /spend); null sin orquestador. */
  spend?: Spend | null
}

// El Stop conserva lo escrito como versión (como Lovable); sin escrituras el hilo sigue en la versión anterior.
// PROGRAM §R4.3: la corrida que cortó la caída del transport no la detuvo la persona; se dice que se interrumpió.
const stoppedLine = (turn: Turn): string =>
  endFlagsOf(turn.state).interrupted
    ? turn.state.snapshot ? 'Se interrumpió. Lo que alcanzó a escribir quedó como una versión nueva.' : 'Se interrumpió antes de cambiar la página: sigue la versión anterior.'
    : turn.state.snapshot ? 'Detenido. Lo que alcanzó a escribir quedó como una versión nueva.' : 'Detenido antes de cambiar la página: sigue la versión anterior.'

// GB/eV de Stitch (DesignPage deob l.47705-47726): los primeros 550 ms del turno quedan los dos puntos quietos y recién
// después entra el tercero y laten (WB, l.47568: 1.05 s con 0.18 s de desfase por punto).
export const THREE_DOTS_AFTER_MS = 550

/** La etapa de la pastilla según cuánto lleva el turno, como el estado inicial de eV. */
export const dotsStage = (elapsedMs: number): 'two-dots' | 'three-dots' => elapsedMs >= THREE_DOTS_AFTER_MS ? 'three-dots' : 'two-dots'

// Auto-follow del chat de v0 (v0-design-mode deob l.12138-12262): mientras corre, cada 600 ms baja suave al final;
// rueda hacia arriba, un toque o ArrowUp/PageUp/Home/Space lo pausan, y volver a 50 px del fondo lo reanuda.
export const FOLLOW_MS = 600
export const FOLLOW_RESUME_PX = 50
const FOLLOW_PAUSE_KEYS = new Set(['ArrowUp', 'PageUp', 'Home', 'Space'])
export const pausesFollow = (e: { type: string; deltaY?: number; code?: string }): boolean =>
  (e.type === 'wheel' && (e.deltaY ?? 0) < 0) || e.type === 'touchstart' || (e.type === 'keydown' && FOLLOW_PAUSE_KEYS.has(e.code ?? ''))
export const nearBottom = (el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean =>
  el.scrollTop >= el.scrollHeight - el.clientHeight - FOLLOW_RESUME_PX

function useAutoFollow(ref: { current: HTMLElement | null }, active: boolean) {
  useEffect(() => {
    const el = ref.current
    if (!el || !active) return
    let paused = false
    const onPause = (e: Event) => { if (pausesFollow(e as Event & { deltaY?: number; code?: string })) paused = true }
    const onScroll = () => { if (nearBottom(el)) paused = false }
    el.addEventListener('wheel', onPause, { passive: true })
    el.addEventListener('touchstart', onPause, { passive: true })
    el.addEventListener('keydown', onPause)
    el.addEventListener('scroll', onScroll, { passive: true })
    const t = window.setInterval(() => { if (!paused) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) }, FOLLOW_MS)
    return () => {
      el.removeEventListener('wheel', onPause)
      el.removeEventListener('touchstart', onPause)
      el.removeEventListener('keydown', onPause)
      el.removeEventListener('scroll', onScroll)
      window.clearInterval(t)
    }
  }, [ref, active])
}

/** La pastilla del agente de Stitch (BI): dos puntos quietos; pensando, entra un tercero y los tres laten en ola. */
function AgentPill({ thinking, elapsedMs }: { thinking: boolean; elapsedMs: number }) {
  const [stage, setStage] = useState(() => dotsStage(elapsedMs))
  useEffect(() => {
    if (!thinking || stage === 'three-dots') return
    const t = window.setTimeout(() => setStage('three-dots'), THREE_DOTS_AFTER_MS - elapsedMs)
    return () => window.clearTimeout(t)
  }, [thinking, stage, elapsedMs])
  const three = thinking && stage === 'three-dots'
  return (
    <span className={styles.agentPill} data-thinking={three || undefined} data-wt-loading={thinking ? '13' : undefined} role="status" aria-label={thinking ? 'El agente está trabajando' : 'Agente'}>
      <i /><i />{three && <i />}
    </span>
  )
}

export function AgentPanelBody({ turn, steps, needsDecision, footer, first, spend = null }: AgentPanelProps) {
  const [stepsOpen, setStepsOpen] = useState(false)
  // Solo anima lo que se vio nacer: un turno viejo abierto desde el registro aparece entero, sin reveal.
  const [live] = useState(turn.state.status === 'streaming')
  const working = turn.state.status === 'streaming'
  const body = [turn.state.error?.message ?? summaryMarkdown(turn.state.text), turn.state.status === 'stopped' ? stoppedLine(turn) : '', ...notesOf(turn.state)].filter(Boolean).join('\n\n')
  const showSteps = stepsOpen || needsDecision
  const updates = toolUpdates(turn.state)
  const label = turnLabel(turn.request)
  const pending = label?.pending ?? statusLine(turn.state, turn.request.mode)
  const scrollRef = useRef<HTMLDivElement>(null)
  useAutoFollow(scrollRef, working)
  const extrasAt = (Math.min(Math.max(wordCount(body) - 1, 0) * WORD_STAGGER, WORD_DELAY_MAX) + WORD_MS) * EXTRAS_AT
  return (
    <div className={styles.body}>
      <div className={styles.head}><AgentPill thinking={working} elapsedMs={turn.elapsedMs} /></div>
      <PromptChip prompt={displayPrompt(turn.prompt)} rise={live} />
      {turn.state.steers?.map((text, i) => <PromptChip key={i} prompt={displayPrompt(text)} rise />)}
      <RunCost elapsedMs={turn.elapsedMs} running={working} usage={turn.state.usage} spend={spend} />
      <div className={styles.scroll} ref={scrollRef} data-wt-loading={working ? '24' : undefined}>
        {body && <Markdown text={body} reveal={live && !working} />}
        {/* _Component67 de Stitch: mientras corre, el texto va arriba y debajo las herramientas; sin herramientas todavía,
            el estado de la acción o "Pensando…". */}
        {working && <Phases turn={turn} first={first} />}
        {/* Un corte del stream no es un error: la corrida sigue en el transport y el backoff vuelve a conectar. */}
        {working && turn.reconnecting && <p className={styles.status} role="status"><LoaderCircle size={14} aria-hidden="true" className={styles.spin} />Reconectando…</p>}
        {working && (updates.length > 0
          ? <Updates updates={updates} />
          : !body && <p key={pending} className={styles.status} role="status" data-wt-loading={label ? '16' : undefined}><LoaderCircle size={14} aria-hidden="true" className={styles.spin} /><em className={styles.shimmer} data-wt-loading="18">{pending}</em></p>)}
        {!working && !body && label && turn.state.status !== 'stopped' && !turn.state.error && <p className={styles.status} data-wt-loading="16">{label.done}</p>}
        {!working && (
          <Extras start={live ? extrasAt : null}>{footer}</Extras>
        )}
        {turn.state.steps.length > 0 && (
          <button type="button" className={styles.stepsToggle} aria-expanded={showSteps} onClick={() => setStepsOpen((v) => !v)} disabled={needsDecision}>
            {showSteps ? 'Ocultar pasos' : `Ver pasos (${turn.state.steps.length})`}
            <ChevronDown size={14} aria-hidden="true" className={styles.chevron} />
          </button>
        )}
        {showSteps && steps}
      </div>
    </div>
  )
}

/** _Component16 y _Component6 de Lovable (header Details): reloj con la duración del turno (avanza sola mientras corre) y, donde Lovable pone créditos, los tokens
 * del turno; el detalle va en el tooltip ("Trabajó durante 1m 42s", "12.345 tokens de entrada · 2.100 de salida"). Sin nada que mostrar no ocupa lugar. */
function RunCost({ elapsedMs, running, usage, spend }: { elapsedMs: number; running: boolean; usage: TokenUsage | undefined; spend: Spend | null }) {
  const tokens = totalTokens(usage)
  const ms = useLiveElapsed(elapsedMs, running)
  const duration = running || ms > 0 ? formatDuration(ms / 1000, true) : null
  if (duration === null && tokens === undefined && !spend) return null
  return (
    <div className={styles.runCost}>
      {duration !== null && <span title={durationTooltip(running, duration)}><Clock size={12} aria-hidden="true" /><span className={styles.tabular}>{duration}</span></span>}
      {tokens !== undefined && usage && <span title={tokensTooltip(usage)}><Cpu size={12} aria-hidden="true" /><span className={styles.tabular}>{formatCompact(tokens)} tokens</span></span>}
      <SpendMeter spend={spend} />
    </div>
  )
}

/** Pasos de Lovable (editor-body-shared :321-406): la fase hecha con lo que tardó, la activa con el tiempo que lleva y las
 * pendientes apagadas. Un flujo de una sola fase no se lista: ya lo dice la línea de estado. */
function Phases({ turn, first }: { turn: Turn; first: boolean }) {
  const now = useLiveElapsed(turn.elapsedMs, turn.state.status === 'streaming')
  const phases = PHASES[flowOf(turn.request, first)]
  if (phases.length < 2) return null
  const active = activePhase(phases, turn.state.steps, Boolean(turn.state.error))
  const offset = active >= 0 ? phaseOffsetMs(phases[active]!, turn.state.steps) ?? 0 : 0
  return (
    <ol className={styles.phases} aria-label="Fases del turno" data-wt-loading="21">
      {phases.map((p, i) => {
        const state = phaseState(i, active)
        const took = state === 'done' ? phaseDurationMs(p, turn.state.steps) : undefined
        return (
          <li key={p.label} className={styles.phase} data-state={state}>
            {state === 'done' ? <CircleCheck size={14} aria-label="Hecha" className={styles.updateDone} />
              : state === 'active' ? <LoaderCircle size={14} aria-label="En curso" className={styles.spin} />
              : <span className={styles.updateIcon} aria-label="Pendiente" />}
            <span>{p.label}</span>
            <span className={styles.phaseTime}>{state === 'done' ? (took !== undefined ? formatPhaseTime(took) : '') : state === 'active' ? formatPhaseTime(now - offset) : ''}</span>
          </li>
        )
      })}
    </ol>
  )
}

/** Ícono por estado del grupo (_Component62 de Stitch): check verde, cruz roja o spinner. */
function UpdateIcon({ status }: { status: UpdateStatus }) {
  if (status === 'completed') return <CircleCheck size={14} aria-label="Listo" className={styles.updateDone} />
  if (status === 'failed') return <CircleX size={14} aria-label="Falló" className={styles.iconError} />
  return <LoaderCircle size={14} aria-label="En curso" className={styles.spin} />
}

/** MgComponent de Stitch: una fila por herramienta en itálica, con (hechas/total) si se llamó más de una vez, y las que
 * pasan de cinco resumidas en "+N más…". */
function Updates({ updates }: { updates: ToolUpdate[] }) {
  const shown = updates.slice(0, UPDATES_SHOWN)
  const rest = updates.length - shown.length
  // RichTask de v0 deja el shimmer en el título de la tarea activa (isActive && shimmerTitle, v0-design-mode deob
  // :14076 y :14116-14122). Solo se monta mientras el turno corre, así que el shimmer dura lo que el turno y no lo que
  // la primera línea de estado: activa es la que está corriendo o, entre una y otra, la última.
  const started = shown.findLastIndex((u) => u.status === 'started')
  const active = started >= 0 ? started : shown.length - 1
  return (
    <ul className={styles.updates} role="status" aria-label="Lo que está haciendo el agente">
      {shown.map((u, i) => (
        <li key={u.tool} className={styles.update}>
          <UpdateIcon status={u.status} />
          <em className={i === active ? styles.shimmer : undefined} data-wt-loading={i === active ? '18' : undefined}>{u.displayName}{u.total > 1 && <span className={styles.updateCount}>({u.completed}/{u.total})</span>}</em>
        </li>
      ))}
      {rest > 0 && <li className={styles.update}><span className={styles.updateIcon} aria-hidden="true" /><em>+{rest} más…</em></li>}
    </ul>
  )
}

/** Archivos, acciones y sugerencias entran escalonados cuando el resumen va por el 70 %, como extrasIn de Stitch. */
function Extras({ start, children }: { start: number | null; children: ReactNode }) {
  const items = Children.toArray(children)
  if (start === null) return <>{items}</>
  return <>{items.map((c, i) => <div key={i} className={styles.extra} style={{ '--d': `${start + i * WORD_STAGGER}s` } as CSSProperties}>{c}</div>)}</>
}

function TurnIcon({ turn }: { turn: Turn }) {
  if (turn.state.status === 'streaming') return <LoaderCircle size={16} aria-label="En curso" className={styles.spin} />
  if (turn.state.error) return <CircleX size={16} aria-label="Con error" className={styles.iconError} />
  if (turn.state.status === 'stopped') return <CircleMinus size={16} aria-label="Detenido" />
  return <CircleCheck size={16} aria-label="Listo" />
}

// Marquesina de Stitch (_Component59): espera 250 ms, solo corre si el texto no cabe, dos copias a 40 px y ~40 px/s.
const MARQUEE_GAP = 40
const MARQUEE_PX_S = 40
const MARQUEE_WAIT_MS = 250

function Marquee({ text }: { text: string }) {
  const box = useRef<HTMLSpanElement>(null)
  const [run, setRun] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const t = window.setTimeout(() => {
      const first = el.firstElementChild as HTMLElement | null
      const w = first?.scrollWidth ?? 0
      setRun(w > el.clientWidth ? Math.max(2, (w + MARQUEE_GAP) / MARQUEE_PX_S) : null)
    }, MARQUEE_WAIT_MS)
    return () => window.clearTimeout(t)
  }, [text])
  return (
    <span ref={box} className={styles.logText} data-marquee={run ? '' : undefined} style={run ? { '--marquee-s': `${run}s` } as CSSProperties : undefined}>
      <span className={styles.marqueeTrack}>{text}</span>
      {run && <span className={styles.marqueeTrack} aria-hidden="true">{text}</span>}
    </span>
  )
}

interface AgentLogProps {
  turns: Turn[]
  selected: string | undefined
  open: boolean
  onToggle: () => void
  onSelect: (messageId: string) => void
}

/** El registro de Stitch: los pedidos del más nuevo al más viejo; el que corre gira, desplaza su texto y ofrece
 *  cancelar. Elegir uno lo muestra en el panel de arriba. */
export function AgentLog({ turns, selected, open, onToggle, onSelect }: AgentLogProps) {
  const ordered = [...turns].reverse()
  return (
    <div className={styles.log} data-open={open || undefined} data-log-open={open || undefined}>
      {open && (
        <ul className={styles.logList} id="agent-log-list">
          {ordered.map((t) => {
            const running = t.state.status === 'streaming'
            return (
              <li key={t.messageId} className={styles.logRow} data-selected={t.messageId === selected || undefined} data-running={running || undefined}>
                <button type="button" className={styles.logPick} onClick={() => onSelect(t.messageId)} aria-current={t.messageId === selected || undefined}>
                  <TurnIcon turn={t} />
                  {running ? <Marquee text={displayPrompt(t.prompt)} /> : <span className={styles.logText}>{displayPrompt(t.prompt)}</span>}
                </button>
                {running && (
                  <Off note="Cancelar todavía no existe: la corrida sigue hasta terminar.">
                    <button type="button" className={styles.logCancel} aria-label="Cancelar" disabled><XCircle size={16} aria-hidden="true" /></button>
                  </Off>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <button type="button" className={styles.logHeader} aria-expanded={open} aria-controls="agent-log-list" onClick={onToggle}>
        <RocketIcon size={16} aria-hidden="true" />
        <span>Registro del agente</span>
        <ChevronDown size={18} aria-hidden="true" className={styles.logChevron} />
      </button>
    </div>
  )
}
