import type { CSSProperties } from 'react'
import { summaryMarkdown, touchesPublic } from '@/lib/run-state'
import { variantShowsPreview, variantStatus, type VariantRun } from '@/lib/variant-layout'
import type { Frame } from './artboard-canvas'
import styles from './builder.module.css'

// La variante sigue los mismos estados que el marco de la página: placeholder con shimmer hasta que su dev server
// responde (preview), la página creciendo con el aura mientras está pending, y el desenlace si no terminó bien.
// error: MSG_SESSION_CANCELLED de Stitch (deob dist-DUGNOA9D :1787), el texto que muestra para una sesión fallida
// (DesignPage :6577-6579). El reintento lo ofrece el chat, como allí (:5545-5549), no el marco.
const OUTCOME: Record<'error' | 'stopped' | 'unchanged', string> = {
  error: 'Pasó algo inesperado y no se pudo completar la variante. Vuelve a intentarlo en un momento.',
  stopped: 'Variante detenida',
  unchanged: 'La variante no cambió la página',
}

interface VariantFrameProps {
  frame: Frame
  run: VariantRun | undefined
  label: string
  selected: boolean
  onSelect: () => void
  iframeRef: (el: HTMLIFrameElement | null) => void
  onLoad: (el: HTMLIFrameElement) => void
  url: string | undefined
  remount: number
}

export function VariantFrame({ frame, run, label, selected, onSelect, iframeRef, onLoad, url, remount }: VariantFrameProps) {
  const status = run ? variantStatus(run) : 'pending'
  const preview = run && variantShowsPreview(run) ? url : undefined
  // La cola sale del log (R3): run.queued hasta run.started, o el `queued` de GET /chats antes del primer evento. Inferirla
  // de "todavía sin messageId" pintaba "En espera" a una variante que ya corría mientras su stream reconectaba (QA caso 5,
  // V4 y V5 tras reiniciar el transport).
  const queued = run?.state.queued === true
  return (
    <div className={styles.artboard} style={{ left: frame.x, width: frame.w, height: frame.h }} data-selected={selected || undefined} data-wt-variant={status}
      data-empty={(!preview && status !== 'pending') || undefined}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onSelect() } }}>
      {preview
        ? <iframe key={`${touchesPublic(run?.state, true) ? 'public' : 'live'}:${remount}`} ref={iframeRef} src={preview} title={`Preview ${label.toLowerCase()}`} className={styles.artboardFrame} tabIndex={-1} onLoad={(e) => onLoad(e.currentTarget)} />
        : status === 'pending' && (
          <div className={styles.artboardGenerating}>
            <div className={styles.shimmer} aria-hidden="true" />
            <div className={styles.skeleton} aria-hidden="true">
              {[0, 1, 2].map((i) => <span key={i} className={styles.skeletonBar} style={{ '--d': `${i * .2}s` } as CSSProperties} />)}
            </div>
            <p className={styles.generatingBanner}><span className={styles.generatingSpinner} aria-hidden="true" />{queued ? 'En espera…' : 'Generando variante…'}</p>
          </div>
        )}
      {status === 'pending' && preview && (
        <div className={styles.aurora} aria-hidden="true">
          <div className={styles.auroraGlow}><div className={styles.auroraBlur}><div className={styles.auroraSpin} /></div></div>
          <div className={styles.auroraBorder}><div className={styles.auroraSpin} /></div>
        </div>
      )}
      {(status === 'error' || status === 'stopped' || status === 'unchanged') && (
        <div className={styles.variantOutcome} role="status" data-over-preview={preview ? '' : undefined}>
          <span>{OUTCOME[status]}</span>
          {status === 'error' && run?.state.error?.message && <span className={styles.variantOutcomeDetail}>{run.state.error.message}</span>}
          {/* Lo que respondió el agente es la única explicación de por qué no hubo versión. */}
          {status === 'unchanged' && run?.state.text && <span className={styles.variantOutcomeDetail}>{summaryMarkdown(run.state.text)}</span>}
        </div>
      )}
    </div>
  )
}
