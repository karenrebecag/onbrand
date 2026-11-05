import { useState } from 'react'
import { ChevronDown, ChevronRight, XIcon } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import type { PickedElement } from '@/lib/element-context'
import styles from './builder.module.css'

// make-local-staged-receipt-card de Make (92302 deob :96210-96300): una tarjeta plegable con "N cambios" y una fila por
// tarea; aquí también es donde se aplican o se descartan, porque la cola vive antes de enviar.
const ROWS_SHOWN = 8

interface StagedChangesProps {
  tasks: PickedElement[]
  busy: boolean
  onRemove: (task: PickedElement) => void
  onDiscard: () => void
  onApply: () => void
}

export function StagedChanges({ tasks, busy, onRemove, onDiscard, onApply }: StagedChangesProps) {
  const [open, setOpen] = useState(true)
  if (!tasks.length) return null
  const hidden = tasks.length - ROWS_SHOWN
  return (
    <div className={styles.staged} data-testid="staged-changes">
      <button type="button" className={styles.stagedToggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span>{tasks.length === 1 ? '1 cambio en espera' : `${tasks.length} cambios en espera`}</span>
      </button>
      {open && (
        <ol className={styles.stagedList}>
          {tasks.slice(0, ROWS_SHOWN).map((t, i) => (
            <li key={t.selector} className={styles.stagedRow}>
              <span className={styles.stagedText}><strong>Tarea {i + 1}:</strong> {t.note} <span className={styles.stagedTarget}>({t.label})</span></span>
              <button type="button" className={styles.contextChipRemove} aria-label={`Quitar tarea ${i + 1}`} onClick={() => onRemove(t)}><XIcon size={12} /></button>
            </li>
          ))}
          {hidden > 0 && <li className={styles.stagedMore}>{hidden === 1 ? '1 cambio más no se muestra' : `${hidden} cambios más no se muestran`}</li>}
        </ol>
      )}
      <div className={styles.stagedActions}>
        <Button size="sm" variant="ghost" onClick={onDiscard}>Descartar</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onApply}>Aplicar</Button>
      </div>
    </div>
  )
}
