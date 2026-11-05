import { describe, expect, test } from 'bun:test';
import { renderInputOf } from '../src/emit';
import { pageVerdict, parseRenderInput, propLeaves, type VisibleBlock } from '../src/render-gate';

const seen = (slug: string, role: string, text: string, extra: Partial<VisibleBlock> = {}): VisibleBlock =>
  ({ slug, role, text, height: 400, opacity: '1', images: 0, brokenImages: 0, ...extra });

describe('render-gate (RFO3): residuo = texto visible que no salió de los props emitidos', () => {
  test('el texto que vino del brief no es residuo; la demo cableada sí, y reprueba sobre el umbral', () => {
    const emitted = parseRenderInput(renderInputOf([
      { export: 'Hero', importPath: '@/h', role: 'hero', slug: 'hero-signup', props: { title: 'Cierra el mes', description: 'Para equipos de finanzas' } },
      { export: 'Cta', importPath: '@/c', role: 'cta', slug: 'cta-section', props: { title: 'Agenda una demo' } },
    ]));
    const { page, blocks } = pageVerdict([
      seen('hero-signup', 'hero', 'Cierra el mes  Para equipos de finanzas'),
      seen('cta-section', 'cta', 'Agenda una demo 1,283 finance teams are on the list'),
    ], emitted, new Set());
    expect(blocks[0].residueRatio).toBe(0);
    expect(blocks[1].residueRatio).toBeGreaterThan(0.5);
    expect(page.failing).toEqual(['cta-section']);
    expect(page.pass).toBe(false);
  });

  test('un slot lleno aporta su texto y su número; el slug del componente no cuenta como texto', () => {
    const leaves = propLeaves({ visuals: { f0: { $component: 'animated-counter', props: { value: 200, label: 'Equipos en lista', prefix: '+' } } }, size: 3 });
    expect(leaves).toEqual(['200', 'Equipos en lista', '+']);
  });

  test('el marco no reprueba por su residuo; una imagen rota o un bloque sin pareja emitida sí', () => {
    const emitted = parseRenderInput([{ role: 'footer', slug: 'site-footer', props: {} }, { role: 'features', slug: 'feature-bento', props: { title: 'T' } }]);
    const frameOnly = pageVerdict([seen('site-footer', 'footer', '© 2026 All systems normal'), seen('feature-bento', 'features', 'T')], emitted, new Set());
    expect(frameOnly.page.pass).toBe(true);
    const broken = pageVerdict([seen('site-footer', 'footer', ''), seen('feature-bento', 'features', 'T', { images: 1, brokenImages: 1 })], emitted, new Set());
    expect(broken.page.failing).toEqual(['feature-bento']);
    const stray = pageVerdict([seen('site-footer', 'footer', ''), seen('feature-bento', 'features', 'T'), seen('ghost', 'hero', 'x')], emitted, new Set());
    expect(stray.page.unmatched).toEqual(['ghost']);
    expect(stray.page.pass).toBe(false);
  });

  test('render-input mal formado falla en el límite, no mide a medias', () => {
    expect(() => parseRenderInput([{ role: 'hero' }])).toThrow('render-input[0]');
  });
});
