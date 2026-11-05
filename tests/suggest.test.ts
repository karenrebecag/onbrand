import { expect, test } from 'bun:test'
import { normalizeText } from '../src/runtime/agent-summary'
import { parseTurnSuggestions, suggestSection, suggestTurn } from '../src/runtime/suggest'
import type { EngineEvent, EventLog } from '../src/runtime/events'
import type { Infer } from '../src/runtime/infer'

// Stitch DesignPage :23596 y :52607: trim, sin punto final, mayúscula inicial.
test('normaliza como Stitch: trim, sin punto final y mayúscula inicial', () => {
  expect(normalizeText('  añade una franja de logos. ')).toBe('Añade una franja de logos')
  expect(normalizeText(' . ')).toBe('')
})

// La respuesta del modelo es dato externo: solo {title, message} válidos y el tope de Lovable/Stitch.
test('del modelo pasan solo formas válidas y 3 de página', () => {
  const s = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `paso ${i}`, message: `haz el paso ${i}.` }))
  const out = parseTurnSuggestions({ page: [...s(4), { title: 1, message: 'x' }] })
  expect(out).toHaveLength(3)
  expect(out[0]).toEqual({ title: 'Paso 0', message: 'Haz el paso 0' })
  expect(parseTurnSuggestions('nada')).toEqual([])
})

test('si el modelo falla, el paso queda en rojo y no tumba el turno', async () => {
  const evs: EngineEvent[] = []
  const log = { emit: (e: EngineEvent) => evs.push(e) } as unknown as EventLog
  expect(await suggestTurn(async () => { throw new Error('429') }, { prompt: 'p', summary: 's', lang: 'es' }, log)).toBeNull()
  expect(evs.at(-1)).toMatchObject({ type: 'step.end', stepId: 'agent:suggestions', status: 'error' })
})

// Stitch recorta el HTML de la pantalla a 8000 caracteres y toma un tope de ideas (DesignPage webcrack :8486, :8503).
test('las ideas de sección mandan la fuente recortada a 8000 caracteres y pasan hasta 5', async () => {
  let sent = ''
  const ideas = Array.from({ length: 7 }, (_, i) => ({ title: `idea ${i}`, message: `haz ${i}` }))
  const out = await suggestSection(async (_s, user) => { sent = user; return { suggestions: ideas } }, { prompt: 'p', lang: 'es', slug: '02-hero', role: 'hero', source: 'x'.repeat(9000) })
  expect(JSON.parse(sent).source).toHaveLength(8000)
  expect(out).toHaveLength(5)
})

test('suggestTurn con un modelo colgado: corta en su tope, deja el paso en rojo y vuelve null sin lanzar', async () => {
  const hung: Infer = (_s, _u, signal) => new Promise((_, rej) => signal?.addEventListener('abort', () => rej(signal.reason), { once: true }));
  const events: EngineEvent[] = [];
  const log = { emit: (e: EngineEvent) => void events.push(e) } as unknown as EventLog;
  expect(await suggestTurn(hung, { prompt: 'p', summary: 's', lang: 'es' }, log, 20)).toBeNull();
  expect(events.at(-1)).toMatchObject({ type: 'step.end', stepId: 'agent:suggestions', status: 'error' });
});

// C4: con inventado, el chip de datos reales va primero aunque el modelo no lo proponga, y no se duplica si lo propone.
test('un chip fijado abre la lista del modelo, sin duplicarse y sin pasar de 3', async () => {
  const evs: EngineEvent[] = []
  const log = { emit: (e: EngineEvent) => evs.push(e) } as unknown as EventLog
  const pinned = { title: 'Usar mis datos reales', message: 'Reemplaza los datos de ejemplo (precios) con mi información real: [tus datos].' }
  const model: Infer = async () => ({ page: [{ title: 'Usar mis datos reales', message: 'otro' }, { title: 'Añadir FAQ', message: 'Añade una FAQ' }, { title: 'Medir clics', message: 'Mide los clics' }] })
  const out = await suggestTurn(model, { prompt: 'p', summary: 's', lang: 'es' }, log, undefined, pinned)
  expect(out).toEqual([pinned, { title: 'Añadir FAQ', message: 'Añade una FAQ' }, { title: 'Medir clics', message: 'Mide los clics' }])
  expect(evs.at(-1)).toMatchObject({ detail: { followUps: out } })
})
