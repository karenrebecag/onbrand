import { expect, test } from 'bun:test'

// El builder decide qué defectos de preview-check son "de runtime" (el botón de arreglar) y el transport decide cuándo
// lanza el auto-repair. Si las dos listas divergen, el builder ofrece reparar lo que el server no repara, o el server
// repara solo lo que el builder pinta como defecto de diseño (QA plan mode 2026-11-04: cta-wrap/contrast disparaban
// autoRepair runtime). La lista del server manda; esta comprobación avisa si el builder se queda atrás.
test('los kinds de runtime del builder son los mismos que repara el transport', async () => {
  const { RUNTIME_KINDS: builder } = await import('../apps/builder/src/lib/run-state')
  const { RUNTIME_KINDS: server } = await import('../src/runtime/runtime-repair')
  expect(server).toBeDefined()
  expect([...builder].sort()).toEqual([...(server as Iterable<string>)].sort())
})
