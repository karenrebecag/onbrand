import { useId, useState } from 'react'
import { BookmarkIcon, ChevronDown, FlaskConical } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { CONTEXT_WARN, contextPercent, type ContextUsage, type InventedFact, type MemoryWrite } from '@/lib/run-state'
import styles from './turn-context.module.css'

/** "Datos de ejemplo (N)": lo que el plan del turno marcó como inventado (facts.invented). Reemplazar precarga el
 * composer; no manda nada solo, la persona escribe el dato real. */
export function InventedChip({ facts, onReplace }: { facts: InventedFact[]; onReplace: (fact: InventedFact) => void }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (!facts.length) return null
  return (
    <div className={styles.invented}>
      <button type="button" className={styles.chip} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        <FlaskConical size={14} aria-hidden="true" />
        Datos de ejemplo ({facts.length})
        <ChevronDown size={14} aria-hidden="true" className={styles.chevron} />
      </button>
      {open && (
        <ul id={listId} className={styles.factList}>
          {facts.map((f, i) => (
            <li key={`${f.slug}-${i}`} className={styles.fact}>
              <span className={styles.factText}><span className={styles.factSlug}>{f.slug}</span>{f.text}</span>
              <Button size="sm" variant="secondary" onClick={() => onReplace(f)}>Reemplazar</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** "Contexto NN %" del último turno con agente. Con el hilo largo, solo un aviso: no hay compresión ni acción automática. */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const pct = contextPercent(usage)
  const tokens = usage.lastTokens && usage.window ? `${usage.lastTokens.toLocaleString('es')} de ${usage.window.toLocaleString('es')} tokens` : undefined
  return (
    <div className={styles.meter}>
      <div className={styles.meterRow} title={tokens}>
        <span className={styles.meterLabel}>Contexto <span className={styles.tabular}>{pct} %</span></span>
        <span className={styles.bar} role="meter" aria-label="Contexto usado" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-warn={usage.ratio >= CONTEXT_WARN || undefined}>
          <span className={styles.barFill} style={{ width: `${pct}%` }} />
        </span>
      </div>
      {usage.ratio >= CONTEXT_WARN && <p className={styles.warn}>Hilo largo: un chat nuevo de esta marca empieza con su memoria y sus reglas.</p>}
    </div>
  )
}

/** Lo que el agente guardó en la memoria de la marca en este turno (memory.write). Se corrige en Instrucciones → Memory. */
export function MemoryNotes({ writes, onOpen }: { writes: MemoryWrite[]; onOpen?: () => void }) {
  if (!writes.length) return null
  return (
    <div className={styles.memory}>
      <ul className={styles.memoryList}>
        {writes.map((w, i) => (
          <li key={i} className={styles.memoryItem}><BookmarkIcon size={14} aria-hidden="true" /><span>Recordó: {w.fact}</span></li>
        ))}
      </ul>
      {onOpen && <div className={styles.memoryActions}><Button size="sm" variant="ghost" onClick={onOpen}>Ver memoria</Button></div>}
    </div>
  )
}
