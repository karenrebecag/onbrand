import { expect, test } from 'bun:test'

// H9 (export-zip-mcp.md §2): el puntero lleva ids y la config del MCP de lectura, nunca contenido ni token.
test('el puntero para MCP lleva los ids, la config con WT_RUNTIME_URL y nombra WT_MCP_TOKEN sin valor', async () => {
  const { mcpPointer } = await import('../apps/builder/src/lib/mcp-pointer')
  const base = { chatId: 'c1', messageId: 'm2', commit: 'abc1234' }
  const text = mcpPointer({ ...base, api: 'https://wt.example.com/api/', origin: 'http://localhost:5173' })
  const blocks = text.split('\n\n')
  expect(JSON.parse(blocks[1]!)).toEqual(base)
  expect(JSON.parse(blocks[3]!).mcpServers.onbrand).toEqual({ command: 'bun', args: ['<repo>/scripts/export-mcp.ts'], env: { WT_RUNTIME_URL: 'https://wt.example.com/api' } })
  expect(text).toContain('WT_MCP_TOKEN')
  expect(text).not.toMatch(/WT_MCP_TOKEN"?\s*[:=]/)
})

// H1 (publish-check-local.md §2): cada respuesta del gate cae en un solo estado; la ruta ausente no bloquea nada.
test('el gate de publicación mapea 404 de ruta, 409 no-build, 409 sin versión, 200 ok y 200 ok:false', async () => {
  const { publishGate } = await import('../apps/builder/src/lib/run-client')
  expect(publishGate(404, { error: 'ruta desconocida' })).toEqual({ state: 'unavailable' })
  expect(publishGate(404, { error: 'mensaje desconocido' })).toEqual({ state: 'error', message: 'mensaje desconocido' })
  expect(publishGate(409, { error: 'sin build', code: 'no-build' })).toEqual({ state: 'no-build' })
  expect(publishGate(409, { error: 'el mensaje m1 todavía no tiene versión' })).toEqual({ state: 'no-version', message: 'el mensaje m1 todavía no tiene versión' })
  expect(publishGate(200, { ok: true, externalOrigins: ['https://fonts.example'], files: 12, bytes: 40960 })).toEqual({ state: 'ok', files: 12, bytes: 40960, externalOrigins: ['https://fonts.example'] })
  expect(publishGate(200, { ok: false, errors: [{ code: 'forbidden-file', path: 'assets/a.js.map', detail: 'sourcemap' }, { nope: 1 }], files: 3, bytes: 100 }))
    .toEqual({ state: 'blocked', errors: [{ code: 'forbidden-file', path: 'assets/a.js.map', detail: 'sourcemap' }], files: 3, bytes: 100 })
})

// H1: el POST de publicar; 501 sin provider no es un error de la versión, y el 409 trae los errores del mismo gate.
test('publicar mapea 200 con url, 501 sin provider, 409 no-build y 409 not-publishable con sus errores', async () => {
  const { publishOutcome } = await import('../apps/builder/src/lib/run-client')
  expect(publishOutcome(200, { url: 'file:///tmp/pub/c1/abc', files: 4, bytes: 2048, externalOrigins: [] })).toEqual({ state: 'published', url: 'file:///tmp/pub/c1/abc', files: 4, bytes: 2048 })
  expect(publishOutcome(501, { error: 'publish no está habilitado' })).toEqual({ state: 'disabled' })
  expect(publishOutcome(409, { error: 'sin build', code: 'no-build' })).toEqual({ state: 'no-build' })
  expect(publishOutcome(409, { code: 'not-publishable', errors: [{ code: 'secret', path: 'assets/i.js', detail: 'sk-' }] })).toEqual({ state: 'blocked', errors: [{ code: 'secret', path: 'assets/i.js', detail: 'sk-' }] })
  expect(publishOutcome(200, {})).toEqual({ state: 'error', message: 'HTTP 200' })
})

// C3: sin ds no se pinta nada; el aviso de actualización solo con un latest distinto del pin.
test('el DS del chat muestra el pin y solo avisa de actualización si el registry publica otro', async () => {
  const { dsStatus, threadDs } = await import('../apps/builder/src/lib/run-client')
  expect(dsStatus(threadDs({}))).toBeNull()
  expect(dsStatus(threadDs({ ds: { pin: '' } }))).toBeNull()
  expect(dsStatus(threadDs({ ds: { pin: 'a1b2c3d4e5', latest: 'a1b2c3d4e5' } }))).toEqual({ pin: 'a1b2c3d4', update: null })
  expect(dsStatus(threadDs({ ds: { pin: 'a1b2c3d4e5', latest: 'f9e8d7c6b5' } }))).toEqual({ pin: 'a1b2c3d4', update: 'f9e8d7c6' })
  expect(dsStatus(threadDs({ ds: { pin: 'a1b2c3d4e5' } }))).toEqual({ pin: 'a1b2c3d4', update: null })
  expect(dsStatus(threadDs({ ds: { latest: 'f9e8d7c6b5' } }))).toEqual({ pin: null, update: 'f9e8d7c6' })
})

// #694: export y publish comparten el 409 not-at-commit; el copy dice lo que pasa, no el texto del servidor.
test('not-at-commit en publishable y en publish da el copy de la última versión', async () => {
  const { publishGate, publishOutcome, NOT_AT_COMMIT_PUBLISH } = await import('../apps/builder/src/lib/run-client')
  const body = { error: 'el workspace no está en el commit de la versión', code: 'not-at-commit' }
  expect(publishGate(409, body)).toEqual({ state: 'no-version', message: NOT_AT_COMMIT_PUBLISH })
  expect(publishOutcome(409, body)).toEqual({ state: 'error', message: NOT_AT_COMMIT_PUBLISH })
})

// #694: GET /publishable lanza el vite build; el menú decide con los formatos que ya pidió, sin el gate.
test('Publicar en este servidor se apaga sin pedir el gate: cargando, sin export o versión vieja', async () => {
  const { publishBlockedBy } = await import('../apps/builder/src/lib/export-download')
  expect(publishBlockedBy({ state: 'loading' })).toBe('Cargando…')
  expect(publishBlockedBy({ state: 'error' })).toBe('No disponible')
  expect(publishBlockedBy({ state: 'ready', formats: { site: false } })).toBe('Solo se puede publicar la última versión de este chat')
  expect(publishBlockedBy({ state: 'ready', formats: { site: true } })).toBeNull()
})
