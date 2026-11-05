import { expect, test } from 'bun:test';
import { contrastDefects } from '../src/contrast-sensor';

// Arq: el aviso de contraste del builder necesita sección, par de colores y razón del peor texto sin volver a medir.
// contrast queda fuera de RUNTIME_KINDS (no auto-repair), solo se reporta como preview issue para el arreglo manual.
test('contrastDefects: un defecto por sección con el peor par de colores (hex) y su razón', () => {
  const [d, ...rest] = contrastDefects(
    [
      { slug: '03-hero', text: 'gris medio', fg: [120, 120, 120], bg: [255, 255, 255], large: false },
      { slug: '03-hero', text: 'gris claro', fg: [200, 200, 200], bg: [255, 255, 255], large: false },
    ],
    1440,
  );
  expect(rest).toHaveLength(0);
  expect(d.kind).toBe('contrast');
  expect(d.slug).toBe('03-hero');
  // El peor par es el gris más claro sobre blanco; es el que el aviso muestra.
  expect(d.colors).toEqual({ fg: '#c8c8c8', bg: '#ffffff' });
  expect(d.ratio).toBeGreaterThan(1);
  expect(d.ratio).toBeLessThan(4.5);
  expect(d.message).toContain('2 textos');
});
