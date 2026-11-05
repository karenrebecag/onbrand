import { frameLabel } from '@/lib/frame-label'
import styles from './builder.module.css'

/** Etiqueta encima del marco, fuera del mundo escalado (.artboardLabel, con elipsis). */
export function FrameLabel(props: { title: string; generating: boolean; variantTitle?: string }) {
  return <span className={styles.artboardLabel}>{frameLabel(props)}</span>
}
