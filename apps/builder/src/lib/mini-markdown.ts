/** El resumen del agente es markdown y el panel lo pinta como Stitch (títulos, listas, negritas) sin meter HTML: el
 * texto lo escribe el modelo, así que se parsea a datos y React lo escapa. Solo lo que el agente usa de verdad. */

export type Inline = { kind: 'text' | 'strong' | 'em' | 'code'; text: string }
export type Block =
  | { kind: 'heading'; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'list'; items: { depth: number; inline: Inline[] }[] }

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g

export function parseInline(text: string): Inline[] {
  return text.split(INLINE).filter(Boolean).map((part): Inline => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return { kind: 'strong', text: part.slice(2, -2) }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return { kind: 'code', text: part.slice(1, -1) }
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) return { kind: 'em', text: part.slice(1, -1) }
    return { kind: 'text', text: part }
  })
}

const HEADING = /^#{1,6}\s+(.*)$/
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ kind: 'paragraph', inline: parseInline(para.join(' ')) })
    para = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const heading = HEADING.exec(line.trim())
    const item = ITEM.exec(line)
    if (!line.trim()) { flush(); continue }
    if (heading) { flush(); blocks.push({ kind: 'heading', inline: parseInline(heading[1]!) }); continue }
    if (item) {
      flush()
      const entry = { depth: Math.min(2, Math.floor(item[1]!.replace(/\t/g, '  ').length / 2)), inline: parseInline(item[2]!) }
      const prev = blocks.at(-1)
      if (prev?.kind === 'list') prev.items.push(entry)
      else blocks.push({ kind: 'list', items: [entry] })
      continue
    }
    para.push(line.trim())
  }
  flush()
  return blocks
}

/** Palabras que el reveal va a animar: marca cuándo entra lo que va debajo del resumen. */
export const wordCount = (text: string): number => parseMarkdown(text)
  .flatMap((b) => (b.kind === 'list' ? b.items.map((i) => i.inline) : [b.inline]))
  .flat()
  .reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0)
