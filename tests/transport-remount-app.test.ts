import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountingLog, remountApp } from '../src/runtime/server'

test('remountApp monta las secciones del disco en el orden del plan y no reescribe si nada cambió', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-remount-'))
  try {
    mkdirSync(join(dir, 'src', 'sections'), { recursive: true })
    expect(remountApp(dir)).toBe(false)
    writeFileSync(join(dir, 'page-plan.md'), '## 01-hero · #hero\n## 03-casos · #casos\n## 02-stats · #stats\n')
    for (const f of ['01-hero.tsx', '02-stats.tsx', 'wa.ts']) writeFileSync(join(dir, 'src', 'sections', f), 'export default () => null\n')
    expect(remountApp(dir)).toBe(true)
    const app = readFileSync(join(dir, 'src', 'App.tsx'), 'utf8')
    expect(app).toContain('slug="01-hero"')
    expect(app).not.toContain('03-casos')
    expect(app).not.toContain('wa')
    writeFileSync(join(dir, 'src', 'sections', '03-casos.tsx'), 'export default () => null\n')
    expect(remountApp(dir)).toBe(true)
    const next = readFileSync(join(dir, 'src', 'App.tsx'), 'utf8')
    expect(next.indexOf('03-casos')).toBeLessThan(next.indexOf('02-stats'))
    expect(remountApp(dir)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// c7c7ec26: App se remontó con 01-navbar roto (9 updates fallidos en vite); al arreglarse el navbar el contenido de App
// ya era el mismo, no se escribió y el preview quedó con el App viejo.
test('mountingLog: arreglar una sección ya montada vuelve a escribir App aunque su contenido no cambie', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-remount-'))
  try {
    mkdirSync(join(dir, 'src', 'sections'), { recursive: true })
    const log = mountingLog({ emit: (b) => b as never }, dir)
    const write = (path: string, body: string) => {
      writeFileSync(join(dir, path), body)
      log.emit({ type: 'step.end', stepId: `t-${path}`, label: 'x', status: 'ok', detail: { kind: 'write', path } } as never)
    }
    const app = join(dir, 'src', 'App.tsx')
    const old = new Date(Date.now() - 60_000)
    write('src/sections/01-navbar.tsx', 'export default function Navbar() { return <nav> }\n')
    const mounted = readFileSync(app, 'utf8')
    expect(mounted).toContain('slug="01-navbar"')
    utimesSync(app, old, old)
    write('src/sections/01-navbar.tsx', 'export default function Navbar() { return <nav /> }\n')
    expect(readFileSync(app, 'utf8')).toBe(mounted)
    expect(statSync(app).mtimeMs).toBeGreaterThan(old.getTime() + 1000)
    // El cierre del turno lo fuerza una vez más.
    utimesSync(app, old, old)
    log.emit({ type: 'step.end', stepId: 'agent:write', label: 'Página escrita', status: 'ok' } as never)
    expect(statSync(app).mtimeMs).toBeGreaterThan(old.getTime() + 1000)
    // Un plan que no cambia el orden no toca App.
    utimesSync(app, old, old)
    write('page-plan.md', '## 01-navbar · #nav\n')
    expect(statSync(app).mtimeMs).toBe(old.getTime())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
