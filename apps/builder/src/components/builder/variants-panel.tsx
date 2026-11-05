import { useState } from 'react'
import { Button } from '@/components/arc/button/button'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { Textarea } from '@/components/arc/textarea/textarea'
import type { VariantOptions } from '@/lib/use-builder'
import styles from './variants-panel.module.css'

// Panel ZP de Stitch (DesignPage deob :40014-40079). Cantidad de 1 a 5 (YP min 1 max 5, :40078); por defecto 3, salvo
// con el modelo Concept, que aquí no existe (:40032-40033).
const COUNTS = ['1', '2', '3', '4', '5']
const DEFAULT_COUNT = 3
// Rango creativo: refine / medium / yolo con las etiquetas Refine, Explore y Reimagine (:40078); medium por defecto (:40034).
const RANGES = [
  { value: 'refine', label: 'Refinar' },
  { value: 'medium', label: 'Explorar' },
  { value: 'yolo', label: 'Reimaginar' },
] as const
type Range = (typeof RANGES)[number]['value']
// Aspectos a variar, fM (:34433-34448): sin ninguno marcado el pedido no los nombra.
const ASPECTS = [
  { key: 'layout', label: 'Layout' },
  { key: 'colorScheme', label: 'Colores' },
  { key: 'images', label: 'Imágenes' },
  { key: 'textFont', label: 'Tipografía' },
  { key: 'textContent', label: 'Texto' },
] as const
// El mismo tope que el transport para customInstructions (transport.ts MAX_INSTRUCTION_CHARS).
const INSTRUCTIONS_MAX = 4000

interface VariantsPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Resuelve false si el transport no las aceptó: el panel queda abierto con lo elegido. */
  onCreate: (options: VariantOptions) => Promise<boolean>
}

export function VariantsPanel({ open, onOpenChange, onCreate }: VariantsPanelProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <VariantsBody onCreate={async (o) => { if (await onCreate(o)) onOpenChange(false) }} />}
    </Dialog>
  )
}

function VariantsBody({ onCreate }: { onCreate: (options: VariantOptions) => Promise<void> }) {
  const [count, setCount] = useState(DEFAULT_COUNT)
  const [range, setRange] = useState<Range>('medium')
  const [instructions, setInstructions] = useState('')
  const [aspects, setAspects] = useState<Record<string, boolean>>(() => Object.fromEntries(ASPECTS.map((a) => [a.key, false])))
  const [sending, setSending] = useState(false)
  // S() de Stitch (:40045-40053): los aspectos marcados y las instrucciones solo viajan si hay algo.
  const options = (): VariantOptions => {
    const marked = ASPECTS.filter((a) => aspects[a.key]).map((a) => a.key)
    return { count, creativeRange: range, ...(marked.length ? { aspects: marked } : {}), ...(instructions.trim() ? { customInstructions: instructions.trim() } : {}) }
  }
  return (
    <DialogContent title="Crear variantes" description="Otras versiones de la página, al lado de la actual.">
      <div className={styles.body}>
        <section className={styles.group}>
          <h3 className={styles.heading}>Número de opciones</h3>
          <SegmentedControl label="Número de opciones" options={COUNTS.map((c) => ({ value: c, label: c }))} value={String(count)} onValueChange={(v) => setCount(Number(v))} />
        </section>
        <section className={styles.group}>
          <h3 className={styles.heading}>Rango creativo</h3>
          <SegmentedControl label="Rango creativo" options={RANGES.map((r) => ({ value: r.value, label: r.label }))} value={range} onValueChange={(v) => setRange(v as Range)} />
        </section>
        <Textarea label="Instrucciones" rows={3} maxLength={INSTRUCTIONS_MAX} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Qué debería cambiar en las variantes" />
        <hr className={styles.divider} />
        <section className={styles.group}>
          <h3 className={styles.heading}>Aspectos a variar</h3>
          <ul className={styles.aspects}>
            {ASPECTS.map((a) => (
              <li key={a.key} className={styles.aspect}>
                <label htmlFor={`aspect-${a.key}`}>{a.label}</label>
                <input id={`aspect-${a.key}`} type="checkbox" role="switch" className={styles.switch} checked={aspects[a.key]} onChange={() => setAspects((s) => ({ ...s, [a.key]: !s[a.key] }))} />
              </li>
            ))}
          </ul>
        </section>
        <div className={styles.footer}>
          <Button variant="primary" disabled={sending} onClick={async () => { setSending(true); await onCreate(options()); setSending(false) }}>Crear variantes</Button>
        </div>
      </div>
    </DialogContent>
  )
}
