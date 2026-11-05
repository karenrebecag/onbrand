import { expect, test } from 'bun:test'
import { createPreviewAccess, urlFor } from '../apps/builder/src/lib/preview-access'

const URL_C1 = 'http://c1.preview.localhost:5301/?v=3'

// identidad-sesion.md §9 + ajuste de ec: el token vigente va en cada montaje, porque la cookie vence aunque la url no cambie.
test('cada montaje lleva el token vigente del latido; sin token, la url tal cual', () => {
  expect(urlFor(URL_C1, 't/1')).toBe('http://c1.preview.localhost:5301/?v=3&wt_preview=t%2F1')
  expect(urlFor(URL_C1, undefined)).toBe(URL_C1)
  const a = createPreviewAccess()
  a.offer('c1', undefined)
  expect(a.srcFor('c1', 'desktop', 'k0', URL_C1)).toBe(URL_C1)
  a.offer('c1', 't/1')
  expect(a.srcFor('c1', 'desktop', 'k1', URL_C1)).toBe(urlFor(URL_C1, 't/1'))
})

// Cambiar el src navega el iframe: el token renovado no recarga el montaje vivo, entra en el próximo remonte.
test('un token renovado no cambia el src montado y va en el siguiente remonte', () => {
  const a = createPreviewAccess()
  a.offer('c1', 't1')
  const mounted = a.srcFor('c1', 'desktop', 'k0', URL_C1)
  a.offer('c1', 't2')
  expect(a.srcFor('c1', 'desktop', 'k0', URL_C1)).toBe(mounted)
  expect(a.srcFor('c1', 'desktop', 'k1', URL_C1)).toBe(urlFor(URL_C1, 't2'))
  // Móvil es otro marco del mismo ws: su primer montaje lleva el token del ws, sin tocar el de escritorio.
  expect(a.srcFor('c1', 'mobile', 'k0', URL_C1)).toBe(urlFor(URL_C1, 't2'))
  expect(a.srcFor('c1', 'desktop', 'k1', URL_C1)).toBe(urlFor(URL_C1, 't2'))
})
