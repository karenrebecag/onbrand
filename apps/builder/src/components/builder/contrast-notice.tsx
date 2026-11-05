import { useId, useState } from 'react'
import { ContrastIcon } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import type { ContrastIssue } from '@/lib/run-state'
import styles from './builder.module.css'

/** El aviso de contraste de la versión, como "Show N preview issues" de v0 (HALLAZGOS-secondary-autofix-sandbox.md:33-35): la
 * lista plegada y un botón que manda los problemas como turno de la persona. No hay arreglo automático: el kind `contrast` es
 * solo reporte (#890) y la decisión de gastar un turno en esto es de quien edita. */
export function ContrastNotice({ issues, onFix }: { issues: readonly ContrastIssue[]; onFix: () => void }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (!issues.length) return null
  const n = issues.length
  return (
    <div className={styles.contrastNotice} data-wt-contrast={n}>
      <div className={styles.repairRow}>
        <span className={styles.repairNote}>Poco contraste en {n} {n === 1 ? 'sección' : 'secciones'}</span>
        <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
          {open ? 'Ocultar detalle' : 'Ver detalle'}
        </Button>
        <Button size="sm" variant="secondary" onClick={onFix}><ContrastIcon size={14} aria-hidden="true" /> Corregir contraste</Button>
      </div>
      <ul id={listId} className={styles.contrastList} hidden={!open}>
        {issues.map((i) => (
          <li key={`${i.slug ?? '-'}:${i.text}`} className={styles.contrastItem}>
            <span className={styles.contrastSample} style={{ color: i.fg, background: i.bg }} aria-hidden="true">Aa</span>
            <span className={styles.contrastText}>
              <span className={styles.contrastQuote}>“{i.text}”</span>
              <span className={styles.repairNote}>{i.slug ? `${i.slug} · ` : ''}{i.fg} sobre {i.bg} · {i.ratio.toFixed(2)}:1</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
