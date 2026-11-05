import type { ReactNode } from 'react'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import styles from './builder.module.css'

// Un botón apagado no emite eventos de puntero; el span recibe el hover y el foco para que la nota se pueda leer.
export function Off({ note, side, children }: { note: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode }) {
  return <Tooltip content={note} side={side}><span className={styles.offWrap} tabIndex={0}>{children}</span></Tooltip>
}
