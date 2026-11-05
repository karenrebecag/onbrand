import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import type { EngineEvent } from '../src/runtime/event-model'
import { Runtime, type Composer } from '../src/runtime/server'

const HERO = `export default function Hero() {\n  return <section><img src="/images/panel.png" alt="Panel" /></section>\n}\n`

let tmp: string
let server: Server
let base: string
let wsDir: string
// El agente commitea lo que escribe: con esto deja public/ como symlink a una carpeta de afuera.
let linkPublicTo: string | null = null

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'v0-replace-image-'))
  const scaffold = join(tmp, 'scaffold')
  mkdirSync(join(scaffold, 'src'), { recursive: true })
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n')
  // Como el agente (ADR 0011): la sección se escribe en el workspace y la imagen va como <img src> literal.
  const compose: Composer = async (req) => {
    wsDir = req.workspace?.dir as string
    mkdirSync(join(wsDir, 'src', 'sections'), { recursive: true })
    writeFileSync(join(wsDir, 'src', 'sections', '01-hero.tsx'), HERO)
    if (linkPublicTo) symlinkSync(linkPublicTo, join(wsDir, 'public'))
    writeFileSync(join(wsDir, 'src', 'App.tsx'), `import Hero from './sections/01-hero'\nexport default function App() { return <main><Hero /></main> }\n`)
    return { sections: [], page: { lang: 'es' }, agent: { files: ['src/sections/01-hero.tsx', 'src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } }
  }
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), tsc: () => '', typescript: ts })
  server = t.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => {
  linkPublicTo = null
  server.close()
  rmSync(tmp, { recursive: true, force: true })
})

const post = (body: unknown) => fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function events(id: string): Promise<EngineEvent[]> {
  const text = await (await fetch(`${base}/runs/${id}/events?cursor=-1`)).text()
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EngineEvent)
}
const hero = async (id: string) => ((await (await fetch(`${base}/runs/${id}/files`)).json()) as { files: { path: string; content?: string }[] }).files.find((f) => f.path === 'src/sections/01-hero.tsx')?.content

// Enter URL de Stitch: una URL externa entra tal cual al src y deja una versión sin modelo.
test('replaceImage con url cambia el src de esa imagen y cierra en patch', async () => {
  await post({ prompt: 'landing', messageId: 'm1' })
  await events('m1')
  expect((await post({ parentId: 'm1', messageId: 'i1', replaceImage: { src: 'http://127.0.0.1:5315/images/panel.png', url: 'https://picsum.photos/id/64/200/200' } })).status).toBe(202)
  expect((await events('i1')).find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'patch' })
  expect(await hero('i1')).toContain('<img src="https://picsum.photos/id/64/200/200" alt="Panel" />')
})

// Upload Image de Stitch: el archivo pasa a public/uploads con slug y hash, y el src apunta ahí, no al transport.
test('replaceImage con upload copia la imagen al workspace y la versión la incluye', async () => {
  await post({ prompt: 'landing', messageId: 'm1' })
  await events('m1')
  const form = new FormData()
  form.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'Foto Equipo.png', { type: 'image/png' }))
  const { url } = (await (await fetch(`${base}/uploads`, { method: 'POST', headers: { 'x-wt-request': '1' }, body: form })).json()) as { url: string }
  expect((await post({ parentId: 'm1', messageId: 'i2', replaceImage: { src: 'http://x/images/panel.png', upload: url } })).status).toBe(202)
  expect((await events('i2')).find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'patch' })
  const src = (await hero('i2'))?.match(/src="(\/uploads\/foto-equipo-[0-9a-f]{6}\.png)"/)?.[1]
  expect(src).toBeString()
  expect(existsSync(join(wsDir, 'public', src!))).toBe(true)
  expect([...readFileSync(join(wsDir, 'public', src!))]).toEqual([137, 80, 78, 71])
})

test('replaceImage mal formado da 400, una URL que no es https 422 y una imagen que no está 409', async () => {
  await post({ prompt: 'landing', messageId: 'm1' })
  await events('m1')
  expect((await post({ parentId: 'm1', messageId: 'b1', replaceImage: { src: 'x', url: 'https://a.com/b.png', upload: '/uploads/x' } })).status).toBe(400)
  expect((await post({ parentId: 'm1', messageId: 'b2', replaceImage: { src: 'http://x/images/panel.png', url: 'javascript:alert(1)' } })).status).toBe(422)
  expect((await post({ parentId: 'm1', messageId: 'b3', replaceImage: { src: 'http://x/images/otra.png', url: 'https://a.com/b.png' } })).status).toBe(409)
})

// Security review 2026-10-29: un SVG copiado a public/ se abre directo sin CSP y ejecuta su <script>; un tipo declarado
// que no coincide con los bytes tampoco entra, igual que en los adjuntos.
test('replaceImage rechaza un SVG y un archivo cuyo contenido no es el tipo declarado', async () => {
  await post({ prompt: 'landing', messageId: 'm1' })
  await events('m1')
  const upload = async (bytes: Uint8Array, name: string, type: string) => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array(bytes)], name, { type }))
    return ((await (await fetch(`${base}/uploads`, { method: 'POST', headers: { 'x-wt-request': '1' }, body: form })).json()) as { url: string }).url
  }
  const svg = await upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg', 'image/svg+xml')
  expect((await post({ parentId: 'm1', messageId: 's1', replaceImage: { src: 'http://x/images/panel.png', upload: svg } })).status).toBe(415)
  const fake = await upload(new TextEncoder().encode('no soy un png'), 'x.png', 'image/png')
  expect((await post({ parentId: 'm1', messageId: 's2', replaceImage: { src: 'http://x/images/panel.png', upload: fake } })).status).toBe(415)
})

// Un symlink commiteado en public/ no puede llevar la escritura de la imagen fuera del workspace.
test('replaceImage no escribe la imagen a través de un symlink en public/', async () => {
  const outside = join(tmp, 'afuera')
  mkdirSync(outside)
  linkPublicTo = outside
  await post({ prompt: 'landing', messageId: 'm1' })
  await events('m1')
  const form = new FormData()
  form.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'foto.png', { type: 'image/png' }))
  const { url } = (await (await fetch(`${base}/uploads`, { method: 'POST', headers: { 'x-wt-request': '1' }, body: form })).json()) as { url: string }
  expect((await post({ parentId: 'm1', messageId: 'l1', replaceImage: { src: 'http://x/images/panel.png', upload: url } })).status).toBe(202)
  expect((await events('l1')).find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'error' })
  expect(existsSync(join(outside, 'uploads'))).toBe(false)
})
