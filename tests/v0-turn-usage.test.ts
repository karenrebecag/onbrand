import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import type { EngineEvent } from '../src/runtime/event-model'
import { Runtime, type Composer } from '../src/runtime/server'

let tmp: string
let server: Server
afterEach(() => {
  server?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// El builder muestra los tokens del turno al lado de la duración (decisión de Karen 2026-10-29, slot del header Details
// de Lovable): tienen que llegar en message.end, no solo en el resumen del paso del agente.
test('los tokens del agente llegan en message.end', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'v0-turn-usage-'))
  const scaffold = join(tmp, 'scaffold')
  mkdirSync(join(scaffold, 'src'), { recursive: true })
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n')
  const compose: Composer = async (req) => {
    writeFileSync(join(req.workspace?.dir as string, 'src', 'App.tsx'), 'export default function App() { return <main /> }\n')
    return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [], usage: { inputTokens: 12000, outputTokens: 345 } } }
  }
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), tsc: () => '', typescript: ts })
  server = t.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'm1' }) })
  const text = await (await fetch(`${base}/runs/m1/events?cursor=-1`)).text()
  const end = text.trim().split('\n').map((l) => JSON.parse(l) as EngineEvent).find((e) => e.type === 'message.end')
  expect(end).toMatchObject({ finishReason: 'stop', usage: { inputTokens: 12000, outputTokens: 345 } })
})
