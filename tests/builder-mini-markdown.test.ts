import { expect, test } from 'bun:test'
import { parseMarkdown } from '../apps/builder/src/lib/mini-markdown'

// El resumen lo escribe el modelo: se convierte a datos y no a HTML, así un <script> queda como texto.
test('el resumen del agente se lee como títulos, listas anidadas y negritas sin pasar HTML', () => {
  const blocks = parseMarkdown('### Cambios\nArmé la **landing** con `App.tsx`.\n\n- Hero\n  - Waitlist <script>x</script>\n1. FAQ')
  expect(blocks).toEqual([
    { kind: 'heading', inline: [{ kind: 'text', text: 'Cambios' }] },
    { kind: 'paragraph', inline: [{ kind: 'text', text: 'Armé la ' }, { kind: 'strong', text: 'landing' }, { kind: 'text', text: ' con ' }, { kind: 'code', text: 'App.tsx' }, { kind: 'text', text: '.' }] },
    { kind: 'list', items: [
      { depth: 0, inline: [{ kind: 'text', text: 'Hero' }] },
      { depth: 1, inline: [{ kind: 'text', text: 'Waitlist <script>x</script>' }] },
      { depth: 0, inline: [{ kind: 'text', text: 'FAQ' }] },
    ] },
  ])
})
