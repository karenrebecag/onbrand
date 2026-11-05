/** Una línea de `memory.md` (contexto-agente.md §1): `- <hecho> · <messageId> · <AAAA-MM-DD>`. El sufijo es la
 * procedencia: de qué mensaje salió y cuándo. La persona edita el hecho, no la procedencia. */
export interface MemoryLine { fact: string; source?: { messageId: string; date: string } }

export const MEMORY_MAX_LINES = 40
export const MEMORY_MAX_BYTES = 4096

const SUFFIX = / · (\S+) · (\d{4}-\d{2}-\d{2})$/

export function parseMemory(text: string): MemoryLine[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => {
    const body = l.slice(2).trim()
    const m = SUFFIX.exec(body)
    return m ? { fact: body.slice(0, m.index).trim(), source: { messageId: m[1]!, date: m[2]! } } : { fact: body }
  }).filter((l) => l.fact)
}

/** Una línea editada a mano conserva su procedencia; una línea vacía se descarta, que es como se borra. */
export function serializeMemory(lines: readonly MemoryLine[]): string {
  const out = lines.filter((l) => l.fact.trim()).map((l) => `- ${l.fact.replace(/\s+/g, ' ').trim()}${l.source ? ` · ${l.source.messageId} · ${l.source.date}` : ''}`)
  return out.length ? `${out.join('\n')}\n` : ''
}

/** Lo que el transport rechazaría con 400: se avisa antes de mandar. */
export function memoryOverLimit(text: string): string | null {
  const lines = text.split('\n').filter((l) => l.trim()).length
  if (lines > MEMORY_MAX_LINES) return `${lines} líneas: el tope es ${MEMORY_MAX_LINES}`
  const bytes = new TextEncoder().encode(text).length
  return bytes > MEMORY_MAX_BYTES ? `${bytes} bytes: el tope es ${MEMORY_MAX_BYTES}` : null
}
