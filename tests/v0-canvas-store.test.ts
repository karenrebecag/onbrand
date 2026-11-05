import { afterEach, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasError, canvasFileUrl, MAX_CANVAS_FILES, MAX_NODES, readCanvas, readCanvasFile, saveCanvasFile, writeCanvas } from '../src/runtime/canvas-store'

let ws: string
afterEach(() => rmSync(ws, { recursive: true, force: true }))
const fresh = () => (ws = mkdtempSync(join(tmpdir(), 'canvas-')))
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const node = (over: Record<string, unknown> = {}) => ({ id: '0b6f8a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', kind: 'image', src: canvasFileUrl('chat1', 'foto-abc123.png'), name: 'Foto.png', x: 0, y: 16, width: 512, height: 320, ...over })
const status = (fn: () => unknown) => { try { fn(); return 0 } catch (e) { return e instanceof CanvasError ? e.status : -1 } }

// Acordado con ec: { rev, nodes }; el PUT exige el rev leído y responde 409 con el actual si otra pestaña escribió.
test('el lienzo guarda con rev y rechaza un rev viejo con el documento actual', () => {
  fresh()
  expect(readCanvas(ws, 'chat1')).toEqual({ rev: 0, nodes: [] })
  expect(writeCanvas(ws, 'chat1', { rev: 0, nodes: [node()] }).rev).toBe(1)
  try { writeCanvas(ws, 'chat1', { rev: 0, nodes: [] }); throw new Error('no 409') } catch (e) {
    expect((e as CanvasError).status).toBe(409)
    expect((e as CanvasError).current?.nodes).toHaveLength(1)
  }
  expect(readCanvas(ws, 'chat1').nodes[0]?.name).toBe('Foto.png')
})

test('un nodo con src externo, de otro chat, con traversal, sin uuid o con medidas absurdas no entra', () => {
  fresh()
  for (const bad of [
    { src: 'https://evil.example/x.png' },
    { src: canvasFileUrl('otro', 'foto-abc123.png') },
    { src: canvasFileUrl('chat1', '../canvas.json') },
    { src: canvasFileUrl('chat1', 'foto-abc123.svg') },
    { id: 'no-uuid' },
    { kind: 'screen' },
    { width: 0 },
    { height: 1e9 },
    { x: Number.NaN },
    { name: 'x'.repeat(201) },
  ]) expect(status(() => writeCanvas(ws, 'chat1', { rev: 0, nodes: [node(bad)] }))).toBe(400)
  expect(status(() => writeCanvas(ws, 'chat1', { rev: 0, nodes: Array.from({ length: MAX_NODES + 1 }, () => node()) }))).toBe(400)
})

// bytesMatchType: el content-type lo declara el cliente; SVG nunca, puede llevar script.
test('la imagen se valida por sus bytes, sin SVG, y se guarda con slug y hash', () => {
  fresh()
  const out = saveCanvasFile(ws, 'chat1', '../../Mi Foto.png', 'image/png', PNG)
  expect(out.file).toMatch(/^mi-foto-[0-9a-f]{6}\.png$/)
  expect(out.src).toBe(canvasFileUrl('chat1', out.file))
  expect(readCanvasFile(ws, out.file)?.contentType).toBe('image/png')
  expect(status(() => saveCanvasFile(ws, 'chat1', 'x.png', 'image/png', new TextEncoder().encode('<html>')))).toBe(415)
  expect(status(() => saveCanvasFile(ws, 'chat1', 'x.svg', 'image/svg+xml', new TextEncoder().encode('<svg/>')))).toBe(415)
})

test('no se lee ni se escribe a través de un symlink en .wt/canvas', () => {
  fresh()
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  writeFileSync(join(outside, 'secret-abc123.png'), PNG)
  mkdirSync(join(ws, '.wt'), { recursive: true })
  symlinkSync(outside, join(ws, '.wt', 'canvas'))
  expect(readCanvasFile(ws, 'secret-abc123.png')).toBeNull()
  expect(status(() => saveCanvasFile(ws, 'chat1', 'a.png', 'image/png', PNG))).toBe(400)
  expect(readCanvasFile(ws, '../canvas.json')).toBeNull()
  rmSync(outside, { recursive: true, force: true })
})

// security-reviewer H1: un symlink plantado por el agente en .wt no puede hacer que un PUT escriba fuera ni que un GET lea fuera.
test('canvas.json, su temporal y .wt no se siguen si son symlinks', () => {
  fresh()
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  const victim = join(outside, 'zshrc')
  writeFileSync(victim, '{"rev":0,"nodes":[]}')
  mkdirSync(join(ws, '.wt'))
  symlinkSync(victim, join(ws, '.wt', 'canvas.json'))
  expect(readCanvas(ws, 'chat1')).toEqual({ rev: 0, nodes: [] })
  writeCanvas(ws, 'chat1', { rev: 0, nodes: [node()] })
  expect(readFileSync(victim, 'utf8')).toBe('{"rev":0,"nodes":[]}')
  const ws2 = mkdtempSync(join(tmpdir(), 'canvas-'))
  symlinkSync(outside, join(ws2, '.wt'))
  expect(status(() => writeCanvas(ws2, 'chat1', { rev: 0, nodes: [] }))).toBe(400)
  expect(existsSync(join(outside, 'canvas.json'))).toBe(false)
  rmSync(ws2, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

// M1: el agente puede escribir canvas.json; lo que no pase la validación del PUT no llega al builder ni traba el lienzo.
test('un canvas.json inválido se lee como vacío', () => {
  fresh()
  mkdirSync(join(ws, '.wt'))
  for (const bad of ['null', '[]', '{"rev":"1","nodes":[]}', JSON.stringify({ rev: 3, nodes: [node({ src: 'javascript:alert(1)' })] })]) {
    writeFileSync(join(ws, '.wt', 'canvas.json'), bad)
    expect(readCanvas(ws, 'chat1')).toEqual({ rev: 0, nodes: [] })
  }
  expect(status(() => writeCanvas(ws, 'chat1', { rev: 0, nodes: [node(), node()] }))).toBe(400)
})

// M3 y M4: un hard link plantado no se sirve, y el lienzo de un chat tiene tope de archivos.
test('no sirve hard links y corta al llegar al tope de archivos', () => {
  fresh()
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  writeFileSync(join(outside, 'secret'), 'top secret')
  mkdirSync(join(ws, '.wt', 'canvas'), { recursive: true })
  linkSync(join(outside, 'secret'), join(ws, '.wt', 'canvas', 'x-abcdef.png'))
  expect(readCanvasFile(ws, 'x-abcdef.png')).toBeNull()
  for (let i = 0; i < MAX_CANVAS_FILES; i++) writeFileSync(join(ws, '.wt', 'canvas', `f${i}-${i.toString(16).padStart(6, '0')}.png`), 'x')
  expect(status(() => saveCanvasFile(ws, 'chat1', 'nueva.png', 'image/png', PNG))).toBe(507)
  rmSync(outside, { recursive: true, force: true })
})

// H14 Favorito: las estrellas viven en el mismo doc. Lo que no viaja se conserva: el autosave de imágenes ({rev, nodes})
// no borra las estrellas y la estrella ({rev, favorites}) no toca los nodos. Un id sin forma de messageId es 400.
test('favorites se guarda con rev y sobrevive a un PUT que solo trae nodos', () => {
  fresh()
  writeCanvas(ws, 'chat1', { rev: 0, nodes: [node()] })
  expect(writeCanvas(ws, 'chat1', { rev: 1, favorites: ['m1', 'm1', 'fcb2e8ca52fc4e94b2bf25e0d76c3612'] })).toMatchObject({ rev: 2, nodes: [node()], favorites: ['m1', 'fcb2e8ca52fc4e94b2bf25e0d76c3612'] })
  expect(writeCanvas(ws, 'chat1', { rev: 2, nodes: [] })).toEqual({ rev: 3, nodes: [], favorites: ['m1', 'fcb2e8ca52fc4e94b2bf25e0d76c3612'] })
  expect(readCanvas(ws, 'chat1').favorites).toEqual(['m1', 'fcb2e8ca52fc4e94b2bf25e0d76c3612'])
  expect(writeCanvas(ws, 'chat1', { rev: 3, favorites: [] })).toEqual({ rev: 4, nodes: [] })
  expect([status(() => writeCanvas(ws, 'chat1', { rev: 4, favorites: ['../x'] })), status(() => writeCanvas(ws, 'chat1', { rev: 4 }))]).toEqual([400, 400])
})
