import { describe, expect, test } from 'bun:test';
import { previewCheckWidths, reviewDefects, type ViewportMeasure } from '../src/render-review';

const vp = (width: number, pageOverflowPx: number, sections: ViewportMeasure['sections'], errors: string[] = []): ViewportMeasure => ({ width, pageOverflowPx, sections, errors });

describe('render-review: defectos de render sin LLM', () => {
  test('el desborde de una sección se acota al scroll real y el subpíxel no cuenta', () => {
    const d = reviewDefects([vp(1440, 1, [{ slug: '03-logos', role: 'logos', overflowPx: 1 }]), vp(375, 26, [{ slug: '09-faq', role: 'faq', overflowPx: 30 }])], []);
    expect(d).toEqual([{ kind: 'overflow', slug: '09-faq', role: 'faq', viewport: 375, px: 26, message: 'a 375 px la sección faq desborda 26 px' }]);
  });

  test('un 404 ya contado por brokenImages no se repite; otro error de página sí', () => {
    const d = reviewDefects([vp(1440, 0, [], ['Failed to load resource: the server responded with a status of 404 (Not Found)', 'Minified React error #31'])], []);
    expect(d.map((x) => [x.kind, x.message])).toEqual([['page-error', 'Minified React error #31']]);
  });

  test('un error que nombra el archivo de una sección medida vuelve a esa sección; si no está medida, a la página', () => {
    const d = reviewDefects([vp(1440, 0, [{ slug: '05-stats', role: 'stats', overflowPx: 0 }], [
      '/src/sections/05-stats.tsx: stats.map is not a function',
      '/src/sections/07-faq.tsx: boom',
    ])], []);
    expect(d.map((x) => [x.slug, x.role])).toEqual([['05-stats', 'stats'], ['-', '-']]);
  });

  test('un control que no cambia de estado o que tira error es defecto; uno que responde, no', () => {
    const d = reviewDefects([], [
      { slug: '09-faq', role: 'faq', control: 'expanded', name: 'Pregunta', changed: true },
      { slug: '08-pricing', role: 'pricing', control: 'tab', name: 'Anual', changed: false },
    ]);
    expect(d).toEqual([{ kind: 'control', slug: '08-pricing', role: 'pricing', message: 'tab "Anual" no cambia de estado al activarlo' }]);
  });
});

test('previewCheckWidths no mide dos veces un ancho: el 1280 de la persona coincide con el marco y no se repite', () => {
  expect(previewCheckWidths()).toEqual([1440, 375, 1280, 390]);
  expect(previewCheckWidths(1280)).toEqual([1440, 375, 1280, 390]);
  expect(previewCheckWidths(1024)).toEqual([1440, 375, 1280, 390, 1024]);
  expect(previewCheckWidths(Number.NaN)).toEqual([1440, 375, 1280, 390]);
  expect(previewCheckWidths(0)).toEqual([1440, 375, 1280, 390]);
});
