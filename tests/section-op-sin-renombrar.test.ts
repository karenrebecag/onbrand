// QA unidad 3 (docs/notas/siguiente-modulo-builder.md), "quitar sección deja 2×404": en vivo sobre el chat real clonado
// (11 secciones, main b015eb84) duplicar 02-hero renombra las 8 secciones de abajo (03-features.tsx → 04-features.tsx…).
// Con el builder abierto, el iframe del preview se recarga entero (vite se reconecta 2-4 veces y se pierde el estado) y
// llegan al builder como wt:runtime-error, para la píldora y el contexto del siguiente turno (H10), errores que no existen:
// "[vite] Failed to reload /src/sections/03-features.tsx…". Quitar una sección también renumera, con el 404 en el iframe.
// En una página de una sola sección (QA dc5de86d) no había renombre y todo entraba por HMR con estado.
// Arreglo: ninguna op renombra lo que ya existe; el orden vive en App.tsx, no en el prefijo, y la copia toma `<slug>-N`.
import { expect, test } from 'bun:test';
import ts from 'typescript';
import { sectionOp } from '../src/runtime/section-ops';

const app = `import Hero from './sections/01-hero';
import Casos from './sections/02-casos';
import Preguntas from './sections/03-preguntas';

export default function App() {
  return (
    <>
      <main>
        <Hero />
        <Casos />
        <Preguntas />
      </main>
    </>
  );
}
`
const section = (slug: string, id: string, role: string): string => `import { Section } from '@/components/layout/layout';

export default function S() {
  return (
    <Section id="${id}" role="${role}" slug="${slug}">
      <h2>${id}</h2>
    </Section>
  );
}
`
const files: Record<string, string> = {
  'src/App.tsx': app,
  'src/sections/01-hero.tsx': section('01-hero', 'inicio', 'hero'),
  'src/sections/02-casos.tsx': section('02-casos', 'casos', 'testimonials'),
  'src/sections/03-preguntas.tsx': section('03-preguntas', 'preguntas', 'faq'),
}

test('duplicar una sección no borra ni renombra los módulos de las secciones que ya existen', () => {
  const r = sectionOp(ts, files, { op: 'duplicate', slug: '01-hero' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const existing = Object.keys(files).filter((p) => p.startsWith('src/sections/'))
  expect(r.deletes.filter((p) => existing.includes(p))).toEqual([])
})

// Arq sobre #723: el rol sale del slug en el plan, en las sugerencias y en el alcance; la copia `01-hero-2` es de rol `hero`.
test('la copia lleva el rol de su origen en plan, secciones montadas y alcance, y el orden es el de App.tsx', async () => {
  const { roleOfSlug } = await import('../src/section-slug');
  const { parsePagePlanMd } = await import('../src/page-plan-md');
  const { mountedSections } = await import('../src/runtime/agent-composer');
  const { roleOf } = await import('../src/shot-store');
  const { roleOfKey } = await import('../src/plan-sensors');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  expect([roleOfSlug('04-casos'), roleOfSlug('04-casos-2'), roleOfSlug('04-casos-12'), roleOfSlug('03-como-funciona')]).toEqual(['casos', 'casos', 'casos', 'como-funciona'])
  expect(roleOf('01-hero-2')).toBe('hero')
  expect(roleOfKey('01-navbar-2')).toBe(roleOfKey('01-navbar'))
  const r = sectionOp(ts, files, { op: 'duplicate', slug: '01-hero' })
  if (!r.ok) throw new Error(r.message)
  const plan = parsePagePlanMd('# Plan\n\n## 01-hero · #inicio\n\n## 01-hero-2 · #inicio-2\n\n## 02-casos · #casos\n')
  expect(plan.sections.map((s) => [s.slug, s.role])).toEqual([['01-hero', 'hero'], ['01-hero-2', 'hero'], ['02-casos', 'casos']])
  const ws = mkdtempSync(join(tmpdir(), 'wt-mounted-'))
  mkdirSync(join(ws, 'src', 'sections'), { recursive: true })
  const after = { ...files, ...r.writes }
  for (const [p, body] of Object.entries(after)) if (p.startsWith('src/')) writeFileSync(join(ws, p), body)
  // App.tsx manda: el orden alfabético de slug también da 01-hero, 01-hero-2…, así que se mueve casos arriba a mano.
  const moved = after['src/App.tsx']!.replace(/(\s+<Hero \/>\n\s+<Hero2 \/>)(\n\s+<Casos \/>)/, '$2$1')
  writeFileSync(join(ws, 'src', 'App.tsx'), moved)
  expect(mountedSections(ws)).toEqual([{ slug: '02-casos', role: 'casos' }, { slug: '01-hero', role: 'hero' }, { slug: '01-hero-2', role: 'hero' }, { slug: '03-preguntas', role: 'preguntas' }])
})
