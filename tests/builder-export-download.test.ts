import { expect, test } from 'bun:test'
import { createExportDownload, downloadError, filenameOf, type DownloadState } from '../apps/builder/src/lib/export-download'

function harness(respond: (url: string) => Promise<Response>) {
  const states: DownloadState[] = []
  const saved: string[] = []
  const dl = createExportDownload<string>({ fetch: respond, urlOf: (f) => `/runs/m1/export?format=${f}`, save: (_b, name) => saved.push(name), set: (s) => states.push(s) })
  return { dl, states, saved }
}

// Antes un <a download> no veía el status: un 404 de site bajaba el texto del error como archivo.
test('preparando y luego listo con el nombre del server; un 404 de site dice que falta build', async () => {
  const ok = harness(async () => new Response('zip', { headers: { 'content-disposition': 'attachment; filename="nimbus-abc1234-codigo.zip"' } }))
  await ok.dl.start('source')
  expect(ok.states.map((s) => s.kind)).toEqual(['preparing', 'ready'])
  expect(ok.saved).toEqual(['nimbus-abc1234-codigo.zip'])
  const missing = harness(async () => Response.json({ error: 'esta versión no tiene build' }, { status: 404 }))
  await missing.dl.start('site')
  expect(missing.states.at(-1)).toMatchObject({ kind: 'error', format: 'site', message: expect.stringContaining('no tiene build') })
  expect(missing.saved).toEqual([])
})

// A7: si se pide otra descarga mientras la primera viaja, la tardía no se guarda ni pisa el estado.
test('una descarga superada no guarda ni pisa el estado de la nueva', async () => {
  let release: (r: Response) => void = () => {}
  const slow = new Promise<Response>((r) => { release = r })
  const h = harness((url) => (url.endsWith('source') ? slow : Promise.resolve(new Response('zip', { headers: { 'content-disposition': 'attachment; filename="s.zip"' } }))))
  const first = h.dl.start('source')
  await h.dl.start('site')
  release(new Response('zip', { headers: { 'content-disposition': 'attachment; filename="c.zip"' } }))
  await first
  expect(h.saved).toEqual(['s.zip'])
  expect(h.states.at(-1)).toEqual({ kind: 'ready', format: 'site', filename: 's.zip' })
})

test('el nombre sale de filename o filename*, con respaldo', () => {
  expect(filenameOf("attachment; filename*=UTF-8''p%C3%A1gina.html", 'page')).toBe('página.html')
  expect(filenameOf(null, 'brief')).toBe('brief')
})

// ec: sitio y página salen del commit de la versión; con el ws en otra, 409 not-at-commit. Otro 409 sigue siendo "sin versión".
test('un 409 not-at-commit dice que solo se exporta la última versión; otro 409, que no hay versión', async () => {
  const h = harness(async () => Response.json({ error: 'el workspace no está en esa versión', code: 'not-at-commit' }, { status: 409 }))
  await h.dl.start('site')
  expect(h.states.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('Solo se puede exportar la última versión') })
  expect(h.saved).toEqual([])
  expect(downloadError(409, 'todavía no tiene versión', 'source')).toContain('Todavía no hay una versión')
})
