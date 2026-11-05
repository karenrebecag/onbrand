import { expect, test } from 'bun:test'
import ts from 'typescript'
import { appFor, applyOrder, planOrder, sectionOp } from '../src/runtime/section-ops'

const app = `import Navbar from './sections/01-navbar';
import Hero from './sections/02-hero';
import ComoFunciona from './sections/03-como-funciona';
import Casos from './sections/04-casos';
import Preguntas from './sections/05-preguntas';
import Footer from './sections/06-footer';

export default function App() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <ComoFunciona />
        <Casos />
        <Preguntas />
      </main>
      <Footer />
    </>
  );
}
`
const section = (slug: string, id: string, role: string, css = true) => `import { Section } from '@/components/layout/layout';
${css ? `import styles from './${slug}.module.css';\n` : ''}
export default function S() {
  return (
    <Section id="${id}" role="${role}" slug="${slug}">
      <h2${css ? ' className={styles.title}' : ''}>${id}</h2>
    </Section>
  );
}
`
const navbar = `const items = [
  { label: 'Cómo funciona', href: '#como-funciona' },
  { label: 'Casos', href: '#casos' },
  { label: 'Preguntas', href: '#preguntas' },
];

export default function Navbar() {
  return <header data-wt-role="navbar" data-wt-slug="01-navbar">{items.length}</header>;
}
`
const footer = `export default function Footer() {
  return (
    <div id="pie" data-wt-role="footer" data-wt-slug="06-footer">
      <Links
        links={[
          { label: 'Preguntas', href: '#preguntas' },
          { label: 'Términos', href: '#pie' },
        ]}
      />
    </div>
  );
}
`
const plan = `# Plan de página: Acme

idioma: español (es)

## 01-navbar · #inicio
- conteo: 3 enlaces

## 02-hero · #inicio
- titular: hola

## 03-como-funciona · #como-funciona
- conteo: 3 pasos

## 04-casos · #casos
- conteo: 3 casos

## 05-preguntas · #preguntas
- conteo: 6 preguntas

## 06-footer · #pie
- conteo: 2 enlaces
`
const files: Record<string, string> = {
  'src/App.tsx': app,
  'src/sections/01-navbar.tsx': navbar,
  'src/sections/02-hero.tsx': section('02-hero', 'inicio', 'hero', false),
  'src/sections/03-como-funciona.tsx': section('03-como-funciona', 'como-funciona', 'how-it-works'),
  'src/sections/03-como-funciona.module.css': '.title { color: red; }\n',
  'src/sections/04-casos.tsx': section('04-casos', 'casos', 'testimonials'),
  'src/sections/04-casos.module.css': '.title { color: blue; }\n',
  'src/sections/05-preguntas.tsx': section('05-preguntas', 'preguntas', 'faq', false),
  'src/sections/06-footer.tsx': footer,
  'page-plan.md': plan,
}

// rA2 del RE: el agente movió una línea de App.tsx y dejó plan y menú en el orden viejo. Mover reordena App.tsx, plan y
// menú, pero no renumera: el slug es la identidad (reorder de Puck por índice, move de v0 con insertBefore) y renombrar
// 8 archivos forzaba la recarga completa de vite.
test('subir una sección reordena App.tsx, plan y menú sin renombrar archivos', () => {
  const r = sectionOp(ts, files, { op: 'move', slug: '04-casos', to: 'up' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.writes['src/App.tsx']).toContain("import Casos from './sections/04-casos';")
  expect(r.writes['src/App.tsx']).toContain("import ComoFunciona from './sections/03-como-funciona';")
  expect(r.writes['src/App.tsx']).toMatch(/<Hero \/>\n\s+<Casos \/>\n\s+<ComoFunciona \/>/)
  expect(r.deletes).toEqual([])
  expect(Object.keys(r.writes).filter((p) => /\/0[34]-/.test(p))).toEqual([])
  expect(r.writes['page-plan.md']).toBe(plan.replace('## 03-como-funciona · #como-funciona\n- conteo: 3 pasos\n\n## 04-casos · #casos\n- conteo: 3 casos', '## 04-casos · #casos\n- conteo: 3 casos\n\n## 03-como-funciona · #como-funciona\n- conteo: 3 pasos'))
  expect(r.writes['src/sections/01-navbar.tsx']!.indexOf("'#casos'")).toBeLessThan(r.writes['src/sections/01-navbar.tsx']!.indexOf("'#como-funciona'"))
})

// rB del RE: sin `rm`, el agente dejó el archivo huérfano, su plan y los enlaces #preguntas del navbar y del footer.
test('eliminar una sección borra su archivo, su entrada del plan y los enlaces a su ancla', () => {
  const r = sectionOp(ts, files, { op: 'remove', slug: '05-preguntas' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // Solo se borra la sección quitada: las demás conservan su slug (QA unidad 3, sin renombres ni recarga entera).
  expect(r.deletes).toEqual(['src/sections/05-preguntas.tsx'])
  expect(r.writes['src/sections/06-footer.tsx']).toContain('data-wt-slug="06-footer"')
  expect(r.writes['src/App.tsx']).not.toContain('Preguntas')
  expect(r.writes['src/App.tsx']).toContain("import Footer from './sections/06-footer';")
  expect(r.writes['page-plan.md']).not.toContain('preguntas')
  expect(r.writes['page-plan.md']).toContain('## 06-footer · #pie')
  expect(r.writes['src/sections/01-navbar.tsx']).not.toContain('#preguntas')
  expect(r.writes['src/sections/06-footer.tsx']).not.toContain('#preguntas')
  expect(r.writes['src/sections/06-footer.tsx']).toContain("{ label: 'Términos', href: '#pie' }")
})

test('duplicar crea la copia debajo con otro componente, otra ancla y su entrada del plan', () => {
  const r = sectionOp(ts, files, { op: 'duplicate', slug: '04-casos' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // La copia toma `<slug>-N` libre y nadie más cambia de nombre.
  expect(r.writes['src/App.tsx']).toContain("import Casos2 from './sections/04-casos-2';")
  expect(r.writes['src/App.tsx']).toMatch(/<Casos \/>\n\s+<Casos2 \/>\n\s+<Preguntas \/>/)
  expect(r.writes['src/sections/04-casos-2.tsx']).toContain('<Section id="casos-2" role="testimonials" slug="04-casos-2">')
  expect(r.writes['src/sections/04-casos-2.tsx']).toContain("'./04-casos-2.module.css'")
  expect(r.writes['src/sections/04-casos-2.module.css']).toBe('.title { color: blue; }\n')
  expect(r.deletes).toEqual([])
  expect(r.writes['page-plan.md']).toContain('## 04-casos-2 · #casos-2')
  expect(r.writes['page-plan.md']).toContain('## 05-preguntas · #preguntas')
  // Duplicar otra vez toma el siguiente libre, y la copia de la copia también.
  const again = { ...files, ...r.writes }
  for (const p of r.deletes) delete again[p]
  const r2 = sectionOp(ts, again, { op: 'duplicate', slug: '04-casos-2' })
  expect(r2.ok && Object.keys(r2.writes).filter((p) => p.endsWith('.tsx') && p.startsWith('src/sections/'))).toContain('src/sections/04-casos-3.tsx')
})

test('navbar, footer y los extremos de <main> no se mueven', () => {
  expect(sectionOp(ts, files, { op: 'remove', slug: '01-navbar' })).toMatchObject({ ok: false, reason: 'unsafe' })
  expect(sectionOp(ts, files, { op: 'move', slug: '02-hero', to: 'up' })).toMatchObject({ ok: false, reason: 'invalid' })
  expect(sectionOp(ts, files, { op: 'move', slug: '05-preguntas', to: 'down' })).toMatchObject({ ok: false, reason: 'invalid' })
  expect(sectionOp(ts, files, { op: 'remove', slug: '09-nada' })).toMatchObject({ ok: false, reason: 'not-found' })
})

// Review S1: <main> se reescribe solo con líneas de sección; un divisor o un import con comillas dobles se perdían o quedaban viejos.
test('un hijo de <main> que no es sección o un import con comillas dobles se rechaza', () => {
  const divider = { ...files, 'src/App.tsx': app.replace('<Casos />', '<Casos />\n        <hr />') }
  expect(sectionOp(ts, divider, { op: 'move', slug: '03-como-funciona', to: 'down' })).toMatchObject({ ok: false, reason: 'unsafe' })
  const dq = { ...files, 'src/App.tsx': app.replace("'./sections/04-casos'", '"./sections/04-casos"') }
  expect(sectionOp(ts, dq, { op: 'move', slug: '04-casos', to: 'down' })).toMatchObject({ ok: false, reason: 'unsafe' })
})

test('duplicar una sección cuyo id trae caracteres de regex no rompe el plan', () => {
  const odd = { ...files, 'src/sections/04-casos.tsx': section('04-casos', 'casos(', 'testimonials'), 'page-plan.md': plan.replace('#casos\n', '#casos(\n') }
  const r = sectionOp(ts, odd, { op: 'duplicate', slug: '04-casos' })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.writes['page-plan.md']).toContain('## 04-casos-2 · #casos(-2')
})

// Lovable avisa del enlace muerto y ofrece el arreglo como botón (bloques.md, lov-03): lo que no se quita solo sale como pedido.
test('un href en JSX a la sección eliminada queda como pedido de seguimiento', () => {
  const hero = section('02-hero', 'inicio', 'hero', false).replace('</h2>', '</h2>\n      <a href="#preguntas">Dudas</a>')
  const r = sectionOp(ts, { ...files, 'src/sections/02-hero.tsx': hero }, { op: 'remove', slug: '05-preguntas' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.followUps).toEqual([{ title: 'Arreglar el enlace a #preguntas', message: 'Quita o redirige el enlace a #preguntas en src/sections/02-hero.tsx: esa sección ya no existe' }])
  expect(sectionOp(ts, files, { op: 'remove', slug: '05-preguntas' })).toMatchObject({ ok: true, followUps: [] })
})

// D4 (QA paso 9): el agente real escribe `import X from "@/sections/NN-rol"` (alias + comillas dobles); la op
// debe renumerar reusando esa forma, no solo la `./sections/` con comillas simples del otro scaffold.
test('la op reusa la forma `@/sections/` con comillas dobles que escribe el agente', () => {
  const aliasApp = app.replace(/'\.\/sections\/([^']+)'/g, '"@/sections/$1"')
  const r = sectionOp(ts, { ...files, 'src/App.tsx': aliasApp }, { op: 'move', slug: '04-casos', to: 'up' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.writes['src/App.tsx']).toContain('import Casos from "@/sections/04-casos";')
  expect(r.writes['src/App.tsx']).toContain('import ComoFunciona from "@/sections/03-como-funciona";')
  expect(r.writes['src/App.tsx']).not.toContain('./sections/')
  expect(r.writes['src/App.tsx']).not.toContain('__')
  expect(r.writes['src/App.tsx']).toMatch(/<Hero \/>\n\s+<Casos \/>\n\s+<ComoFunciona \/>/)
})

test('duplicar reusa la forma `@/sections/` con comillas dobles', () => {
  const aliasApp = app.replace(/'\.\/sections\/([^']+)'/g, '"@/sections/$1"')
  const r = sectionOp(ts, { ...files, 'src/App.tsx': aliasApp }, { op: 'duplicate', slug: '04-casos' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.writes['src/App.tsx']).toContain('import Casos2 from "@/sections/04-casos-2";')
  expect(r.writes['src/App.tsx']).not.toContain('__')
})

// Ola 1.1: el App del agente envuelve cada sección en <WtSection slug>; mover, quitar y duplicar siguen sin modelo.
const wrappedApp = `import { WtSection } from '@/wt-section';
import Navbar from './sections/01-navbar';
import Hero from './sections/02-hero';
import ComoFunciona from './sections/03-como-funciona';
import Casos from './sections/04-casos';
import Preguntas from './sections/05-preguntas';
import Footer from './sections/06-footer';

export default function App() {
  return (
    <>
      <WtSection slug="01-navbar"><Navbar /></WtSection>
      <main>
        <WtSection slug="02-hero"><Hero /></WtSection>
        <WtSection slug="03-como-funciona"><ComoFunciona /></WtSection>
        <WtSection slug="04-casos"><Casos /></WtSection>
        <WtSection slug="05-preguntas"><Preguntas /></WtSection>
      </main>
      <WtSection slug="06-footer"><Footer /></WtSection>
    </>
  );
}
`

test('con WtSection, mover lleva la línea con su boundary y no toca los slugs', () => {
  const r = sectionOp(ts, { ...files, 'src/App.tsx': wrappedApp }, { op: 'move', slug: '04-casos', to: 'up' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.writes['src/App.tsx']).toMatch(/<WtSection slug="02-hero"><Hero \/><\/WtSection>\n\s+<WtSection slug="04-casos"><Casos \/><\/WtSection>\n\s+<WtSection slug="03-como-funciona"><ComoFunciona \/><\/WtSection>/)
})

// El boundary nombra el archivo en el error de preview.runtime: si el archivo se renumera y el boundary no, el error
// apuntaría a otra sección.
test('con WtSection, quitar y duplicar dejan el slug del boundary de las demás y la copia lleva el suyo', () => {
  const removed = sectionOp(ts, { ...files, 'src/App.tsx': wrappedApp }, { op: 'remove', slug: '03-como-funciona' })
  expect(removed.ok).toBe(true)
  if (!removed.ok) return
  const a = removed.writes['src/App.tsx']!
  expect(a).toContain('<WtSection slug="04-casos"><Casos /></WtSection>')
  expect(a).toContain('<WtSection slug="05-preguntas"><Preguntas /></WtSection>')
  expect(a).toContain('<WtSection slug="06-footer"><Footer /></WtSection>')
  expect(a).not.toContain('slug="03-como-funciona"')

  const dup = sectionOp(ts, { ...files, 'src/App.tsx': wrappedApp }, { op: 'duplicate', slug: '04-casos' })
  expect(dup.ok).toBe(true)
  if (!dup.ok) return
  expect(dup.writes['src/App.tsx']).toMatch(/<WtSection slug="04-casos"><Casos \/><\/WtSection>\n\s+<WtSection slug="04-casos-2"><Casos2 \/><\/WtSection>\n\s+<WtSection slug="05-preguntas"><Preguntas \/><\/WtSection>/)
})

// S1: borrar antes de escribir dejaba a App importando un archivo inexistente y vite recargaba el preview entero.
test('el orden en disco escribe lo nuevo, después App, y borra al final sin borrar lo que se reescribe', () => {
  const steps = applyOrder(
    { 'src/App.tsx': 'app', 'src/sections/03-casos.tsx': 'nuevo', 'page-plan.md': 'plan' },
    ['src/sections/03-casos.tsx', 'src/sections/04-casos.tsx'],
  )
  expect(steps).toEqual([
    { op: 'write', path: 'src/sections/03-casos.tsx' },
    { op: 'write', path: 'page-plan.md' },
    { op: 'write', path: 'src/App.tsx' },
    { op: 'delete', path: 'src/sections/04-casos.tsx' },
  ])
})

// P1: el App del T1 lo monta el sistema; tiene que seguir el plan y quedar editable por sectionOp en los follow-ups.
const p1Plan = `# Plan\n\n## 01-navbar · #top\n## 02-hero · #hero\n## 06-casos · #casos\n## 05-stats · #stats\n## 07-footer · #footer\n`

test('appFor: orden del plan, landmarks fuera de <main>, solo lo que existe y lo ajeno al plan al final', () => {
  const out = appFor(['07-footer', '05-stats', '02-hero', '01-navbar', '06-casos', '08-extra'], p1Plan)
  expect(planOrder(p1Plan)).toEqual(['01-navbar', '02-hero', '06-casos', '05-stats', '07-footer'])
  const at = (s: string) => out.indexOf(`slug="${s}"`)
  expect(at('01-navbar')).toBeLessThan(out.indexOf('<main>'))
  expect(at('07-footer')).toBeGreaterThan(out.indexOf('</main>'))
  expect(at('02-hero')).toBeLessThan(at('06-casos'))
  expect(at('06-casos')).toBeLessThan(at('05-stats'))
  expect(at('05-stats')).toBeLessThan(at('08-extra'))
  expect(at('08-extra')).toBeLessThan(out.indexOf('</main>'))
  expect(appFor(['02-hero'], p1Plan)).not.toContain('06-casos')
})

test('appFor: nombres únicos cuando dos slugs comparten rol', () => {
  const out = appFor(['03-casos', '04-casos'])
  expect(out).toContain("import Casos from './sections/03-casos';")
  expect(out).toContain("import Casos2 from './sections/04-casos';")
})

test('appFor: su salida la entiende sectionOp (move en el follow-up)', () => {
  const slugs = ['01-navbar', '02-hero', '06-casos', '05-stats', '07-footer']
  const app = appFor(slugs, p1Plan)
  const secs = Object.fromEntries(slugs.map((s) => [`src/sections/${s}.tsx`, 'export default function S() { return null }\n']))
  const r = sectionOp(ts, { ...secs, 'src/App.tsx': app, 'page-plan.md': p1Plan }, { op: 'move', slug: '05-stats', to: 'up' })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.writes['src/App.tsx']!.indexOf('slug="05-stats"')).toBeLessThan(r.writes['src/App.tsx']!.indexOf('slug="06-casos"'))
})
