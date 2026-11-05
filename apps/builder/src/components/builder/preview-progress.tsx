import { useEffect, useState } from 'react'
import styles from './builder.module.css'

// CX de Lovable (app-lazy-shared deob l.46038-46134): mientras el iframe carga, una barra de 3 px avanza a saltos
// cada vez más espaciados y frena en 75 %; al cargar salta a 100 % y se desvanece en 0.3 s con 0.2 s de espera.
export const PROGRESS_STEPS: readonly { at: number; inc: number }[] = [
  { at: 150, inc: 15 }, { at: 250, inc: 10 }, { at: 400, inc: 5 }, { at: 500, inc: 3 }, { at: 650, inc: 3 }, { at: 750, inc: 3 },
  { at: 1500, inc: 2 }, { at: 2000, inc: 1 }, { at: 3000, inc: 1 }, { at: 4000, inc: 1 }, { at: 5000, inc: 1 }, { at: 6000, inc: 1 },
  { at: 7000, inc: 1 }, { at: 10000, inc: 1 }, { at: 14000, inc: 1 },
]
export const PROGRESS_CAP = 75
export const progressStep = (d: number, inc: number, random: () => number = Math.random): number => d < PROGRESS_CAP ? d + inc + random() * 2 : d
const PROGRESS_EXIT_MS = 500

export function PreviewProgress({ loading }: { loading: boolean }) {
  const [pct, setPct] = useState(0)
  const [shown, setShown] = useState(loading)
  useEffect(() => {
    if (!loading) {
      setPct(100)
      const t = window.setTimeout(() => setShown(false), PROGRESS_EXIT_MS)
      return () => window.clearTimeout(t)
    }
    setPct(0)
    setShown(true)
    const ids = PROGRESS_STEPS.map(({ at, inc }) => window.setTimeout(() => setPct((d) => progressStep(d, inc)), at))
    return () => ids.forEach((id) => window.clearTimeout(id))
  }, [loading])
  if (!shown) return null
  return (
    <div className={styles.previewProgress} aria-hidden="true" data-wt-loading={loading ? '23' : undefined}>
      <div className={styles.previewProgressBar} data-done={!loading || undefined} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  )
}
