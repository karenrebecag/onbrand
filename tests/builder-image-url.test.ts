import { expect, test } from 'bun:test'
import { isImageUrl } from '../apps/builder/src/lib/image-url'

// Enter URL de Stitch rechaza lo que no es una URL de imagen antes de cargarla; aquí además lo que cerraría el literal.
test('Ingresar URL solo deja pasar https sin caracteres que cierren el src', () => {
  expect(isImageUrl('https://picsum.photos/id/64/200/200')).toBe(true)
  expect(isImageUrl('  https://a.com/b.png  ')).toBe(true)
  expect(isImageUrl('http://a.com/b.png')).toBe(false)
  expect(isImageUrl('javascript:alert(1)')).toBe(false)
  expect(isImageUrl('data:image/png;base64,AAAA')).toBe(false)
  expect(isImageUrl('https://a.com/b.png" onerror="x')).toBe(false)
  expect(isImageUrl('no es una url')).toBe(false)
})
