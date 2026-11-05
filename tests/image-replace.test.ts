import { expect, test } from 'bun:test'
import tsRuntime from '../templates/base-scaffold/node_modules/typescript'
import { replaceImage, uploadedImagePath, validImageSrc } from '../src/runtime/image-replace'

// El scaffold se resuelve por symlink a otro checkout: mismo módulo, identidad de tipos distinta para tsc.
const ts = tsRuntime as unknown as typeof import('typescript')

const hero = `export function Hero() {
  return (
    <section>
      <img src="/images/panel.png" alt="Panel" />
      <img src={'/images/team.jpg'} alt="Equipo" />
    </section>
  )
}
`

// Enter URL de Stitch (dinamico-rail.md, Cambiar imagen): el DOM trae el src absoluto; en el código está la ruta de
// public/, y solo cambia ese literal.
test('cambia el src de la imagen elegida, con la comilla que ya tenía', () => {
  const files = { 'src/sections/01-hero.tsx': hero }
  const r = replaceImage(ts, files, 'http://127.0.0.1:5360/images/panel.png', 'https://picsum.photos/id/64/200/200')
  expect(r.ok && r.source).toContain('<img src="https://picsum.photos/id/64/200/200" alt="Panel" />')
  const braced = replaceImage(ts, files, 'http://127.0.0.1:5360/images/team.jpg', '/uploads/equipo-a1b2c3.png')
  expect(braced.ok && braced.source).toContain(`<img src={'/uploads/equipo-a1b2c3.png'} alt="Equipo" />`)
})

test('un src que sale de un import, repetido o con srcSet va a Editar con IA', () => {
  const imported = { 'src/App.tsx': `import logo from './logo.png'\nexport const A = () => <img src={logo} alt="" />` }
  expect(replaceImage(ts, imported, 'http://x/assets/logo-abc.png', 'https://a.com/b.png')).toMatchObject({ ok: false, reason: 'not-found' })
  const twice = { 'src/App.tsx': `export const A = () => <div><img src="/a.png" alt="" /><img src="/a.png" alt="" /></div>` }
  expect(replaceImage(ts, twice, 'http://x/a.png', 'https://a.com/b.png')).toMatchObject({ ok: false, reason: 'ambiguous' })
  const srcset = { 'src/App.tsx': `export const A = () => <img src="/a.png" srcSet="/a@2x.png 2x" alt="" />` }
  expect(replaceImage(ts, srcset, 'http://x/a.png', 'https://a.com/b.png')).toMatchObject({ ok: false, reason: 'unsafe' })
})

// El src nuevo entra a un literal del código: nada que lo cierre ni otro esquema que https.
test('solo acepta URLs https o archivos de public/uploads, sin caracteres que cierren el literal', () => {
  expect(validImageSrc('https://a.com/b.png')).toBe(true)
  expect(validImageSrc('http://a.com/b.png')).toBe(false)
  expect(validImageSrc('/uploads/foto-abc123.webp')).toBe(true)
  expect(validImageSrc('/uploads/foto-abc123.svg')).toBe(false)
  expect(validImageSrc('javascript:alert(1)')).toBe(false)
  expect(validImageSrc('data:image/png;base64,AAAA')).toBe(false)
  expect(validImageSrc('https://a.com/b.png" onerror="x')).toBe(false)
  expect(validImageSrc('/uploads/../../etc/passwd')).toBe(false)
  expect(replaceImage(ts, { 'src/App.tsx': hero }, 'http://x/images/panel.png', "https://a.com/'+x+'")).toMatchObject({ ok: false, reason: 'invalid' })
})

test('el archivo subido toma el nombre de Stitch: slug y seis hex del sha256', () => {
  expect(uploadedImagePath('Foto Equipo (1).PNG', 'image/png', 'a1b2c3d4e5')).toEqual({ file: 'public/uploads/foto-equipo-1-a1b2c3.png', src: '/uploads/foto-equipo-1-a1b2c3.png' })
  expect(uploadedImagePath('doc.pdf', 'application/pdf', 'a1b2c3')).toBeNull()
})
