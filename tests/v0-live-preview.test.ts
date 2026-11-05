import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import type { EngineEvent } from '../src/runtime/event-model'
import type { PreviewPool } from '../src/runtime/preview'
import { Runtime, type Composer } from '../src/runtime/server'

let tmp: string
let server: Server
afterEach(() => {
  server?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// dinamico-carga.md: el frame de Stitch existe desde que el agente empieza y la página se pinta mientras escribe. Si la
// url llega con el cierre, el builder muestra el placeholder toda la corrida y el cursor del agente no tiene dónde verse.
test('con el agente la url del preview vivo llega antes de que el agente escriba', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'v0-live-preview-'))
  const scaffold = join(tmp, 'scaffold')
  mkdirSync(join(scaffold, 'src'), { recursive: true })
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n')
  let base = ''
  const compose: Composer = async (req) => {
    const dir = req.workspace?.dir as string
    mkdirSync(join(dir, 'src', 'sections'), { recursive: true })
    writeFileSync(join(dir, 'src', 'App.tsx'), 'export default function App() { return <main /> }\n')
    return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } }
  }
  const previews = { ensure: async () => ({ url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 }), drainErrors: () => [] } as unknown as PreviewPool
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), tsc: () => '', typescript: ts, previews })
  server = t.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'm1' }) })
  const text = await (await fetch(`${base}/runs/m1/events?cursor=-1`)).text()
  const log = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EngineEvent)
  // El primer preview del mensaje es el que ve el builder: tiene que estar antes de que se guarde la versión.
  const first = log.findIndex((e) => e.type === 'step.end' && e.detail?.kind === 'action' && e.detail.name === 'preview')
  const commit = log.findIndex((e) => e.type === 'step.start' && e.stepId === 'transport:commit')
  expect(first).toBeGreaterThan(-1)
  expect(first).toBeLessThan(commit)
  expect(log[first]).toMatchObject({ detail: { summary: 'http://127.0.0.1:5399/' } })
})
