import { Wallet } from 'lucide-react'
import { spendView, type Spend } from '@/lib/spend'
import styles from './agent-panel.module.css'

/** Gasto del día de la cuenta contra el tope del servidor, junto a los tokens del turno: donde Lovable pone los créditos
 * (header Details). Sin lectura válida de GET /spend no se pinta nada. */
export function SpendMeter({ spend }: { spend: Spend | null }) {
  if (!spend) return null
  const v = spendView(spend)
  return (
    <span className={styles.spend} title={v.title} data-reached={v.reached || undefined} role="status">
      <Wallet size={12} aria-hidden="true" />
      <span className={styles.tabular}>{v.text}</span>
      <span className={styles.spendBar} role="meter" aria-label="Gasto del tope" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v.ratio * 100)}>
        <span className={styles.spendFill} style={{ width: `${v.ratio * 100}%` }} />
      </span>
    </span>
  )
}
