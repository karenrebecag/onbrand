/** Corta un buffer NDJSON en líneas completas; lo que queda sin '\n' espera al próximo chunk. */
export function splitNdjson(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map((l) => l.trim()).filter(Boolean), rest }
}
