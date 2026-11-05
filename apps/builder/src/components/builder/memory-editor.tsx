import { useEffect, useState } from 'react'
import { Trash2Icon } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { Textarea } from '@/components/arc/textarea/textarea'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { memoryOverLimit, parseMemory, serializeMemory, type MemoryLine } from '@/lib/brand-memory'
import styles from './builder.module.css'

export interface BrandMemory {
  load: () => Promise<string>
  save: (text: string) => Promise<string>
}

/** Lo que el agente recordó de la marca (`remember`), una fila por hecho. La persona corrige o borra; agregar es del
 * agente, que lo hace cuando ella le dice algo de la marca. */
export function MemoryEditor({ memory, onCancel }: { memory: BrandMemory; onCancel: () => void }) {
  const [draft, setDraft] = useState<MemoryLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let live = true
    memory.load()
      .then((text) => { if (live) setDraft(parseMemory(text)) })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [memory])

  if (!draft) return error ? <p className={styles.rulesError} role="alert">{error}</p> : <p className={styles.rulesNote}>Loading the brand's memory…</p>
  const text = serializeMemory(draft)
  const over = memoryOverLimit(text)
  const update = (i: number, fact: string) => setDraft(draft.map((l, j) => (j === i ? { ...l, fact } : l)))
  const remove = (i: number) => setDraft(draft.filter((_, j) => j !== i))
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      setDraft(parseMemory(await memory.save(text)))
      onCancel()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className={styles.rulesForm} onSubmit={(e) => { e.preventDefault(); if (!over && !saving) void save() }}>
      {draft.length === 0
        ? <p className={styles.rulesNote}>Nothing remembered yet. When you tell the agent something about the brand, it saves it here.</p>
        : <ol className={styles.rulesList}>
          {draft.map((line, i) => (
            <li key={i} className={styles.ruleRow}>
              <Textarea label={line.source ? `Fact ${i + 1}, ${line.source.date}` : `Fact ${i + 1}`} value={line.fact} rows={1} className={styles.ruleInput} onChange={(e) => update(i, e.target.value)} />
              <Tooltip content="Forget this fact">
                <Button type="button" variant="ghost" size="sm" aria-label={`Forget fact ${i + 1}`} onClick={() => remove(i)}><Trash2Icon size={14} /></Button>
              </Tooltip>
            </li>
          ))}
        </ol>}
      {(over || error) && <p className={styles.rulesError} role="alert">{error ?? over}</p>}
      <div className={styles.rulesActions}>
        <span className={styles.spacer} />
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={Boolean(over) || saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  )
}
