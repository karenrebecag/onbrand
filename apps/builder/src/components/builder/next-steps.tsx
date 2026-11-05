import type { Suggestion } from '@engine/runtime/event-model'
import styles from './next-steps.module.css'

interface NextStepsProps {
  suggestions: Suggestion[]
  onPick: (prompt: string) => void
}

/** Chips de siguiente paso bajo el último turno, con la anatomía de las sugerencias del composer de Arc. Como Lovable
 * (featureSuggestions {title, message}), el chip muestra el título y el click envía el pedido completo. */
export function NextSteps({ suggestions, onPick }: NextStepsProps) {
  if (!suggestions.length) return null
  return (
    <ul className={styles.list} aria-label="Siguientes pasos">
      {suggestions.map((s) => (
        <li key={s.message}>
          <button type="button" className={styles.chip} title={s.title === s.message ? undefined : s.message} onClick={() => onPick(s.message)}>{s.title}</button>
        </li>
      ))}
    </ul>
  )
}
