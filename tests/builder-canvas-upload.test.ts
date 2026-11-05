import { expect, test } from 'bun:test'
import { checkUploads, mapPool, MAX_FILES, MAX_IMAGE_BYTES, nodeSize, rowXs, UPLOAD_MESSAGES } from '../apps/builder/src/lib/canvas-upload'
import { capBytes } from '../apps/builder/src/lib/upload-limit'

const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type })

// tt/et de Stitch (useImageUploadNotice l.303, l.290): un aviso por clase de problema, no uno por archivo.
test('reparte válidas, pesadas y no soportadas con un aviso por clase', () => {
  const big = file('b.png', 'image/png')
  Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 })
  const r = checkUploads([file('a.png', 'image/png'), big, file('c.svg', 'image/svg+xml'), file('d.txt', 'text/plain'), file('e.jpg', 'image/png')])
  expect(r.valid.map((f) => f.name)).toEqual(['a.png'])
  expect(r.tooLarge.map((f) => f.name)).toEqual(['b.png'])
  expect(r.unsupported.map((f) => f.name)).toEqual(['c.svg', 'd.txt', 'e.jpg'])
  expect(r.errorMessages).toEqual([UPLOAD_MESSAGES.invalidType, UPLOAD_MESSAGES.tooLarge])
})

test('más de seis imágenes: entran seis y avisa', () => {
  const r = checkUploads(Array.from({ length: MAX_FILES + 2 }, (_, i) => file(`${i}.webp`, 'image/webp')))
  expect(r.valid).toHaveLength(MAX_FILES)
  expect(r.errorMessages).toEqual([UPLOAD_MESSAGES.tooMany])
})

// Tt de Stitch (l.513): a lo sumo 3 a la vez, resultados en el orden de entrada.
test('la cola sube de a tres y conserva el orden', async () => {
  let live = 0, peak = 0
  const out = await mapPool([1, 2, 3, 4, 5], 3, async (n) => {
    peak = Math.max(peak, ++live)
    await new Promise((r) => setTimeout(r, 5 - n))
    live--
    return n * 10
  })
  expect(peak).toBe(3)
  expect(out).toEqual([10, 20, 30, 40, 50])
})

// vt y Et de Stitch (l.420, l.531): ancho máx 512 con la proporción; fila con 64 px entre nodos.
test('escala a 512 de ancho y arma la fila desde el punto de drop', () => {
  expect(nodeSize(2048, 1024)).toEqual({ width: 512, height: 256 })
  expect(nodeSize(300, 200)).toEqual({ width: 300, height: 200 })
  expect(nodeSize(undefined, 10)).toEqual({})
  expect(rowXs(3, 100)).toEqual([100, 676, 1252])
})

// ht/_t de Stitch (useImageUploadNotice l.404, l.416): slug kebab de 40 y 6 hex del SHA-256.
test('la ruta de la subida es slug kebab + 6 hex del contenido', async () => {
  const { uploadPath, uploadSlug } = await import('../apps/builder/src/lib/canvas-upload')
  expect(uploadSlug('Mi Foto (final) 2.PNG')).toBe('mi-foto-final-2')
  expect(uploadSlug('...')).toBe('image')
  expect(uploadSlug('a'.repeat(60) + '.png')).toHaveLength(40)
  const a = await uploadPath(new File(['hola'], 'Foto.png', { type: 'image/png' }))
  expect(a).toMatch(/^uploads\/foto-[0-9a-f]{6}\.png$/)
  expect(await uploadPath(new File(['hola'], 'Foto.png', { type: 'image/png' }))).toBe(a)
})

// Staging: el tope del host baja el propio, nunca lo sube; un valor roto no cuenta.
test('el tope del host solo recorta el propio', () => {
  expect(capBytes(20_971_520, '4194304')).toBe(4_194_304)
  expect(capBytes(10, '4194304')).toBe(10)
  for (const bad of [undefined, '', 'x', '0', '-5', '1.5']) expect(capBytes(20_971_520, bad)).toBe(20_971_520)
})
