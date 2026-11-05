import { describe, expect, test } from 'bun:test';
import { migrateAttrs } from '../src/motion-attrs';
import { flashes, mergeGateRecords, normalizeHtml, renderVerdict, type MotionRun, type NodeState } from '../src/motion-render';

const n = (opacity: number, visible = opacity > 0.99): NodeState => ({ opacity, transform: '0,0', visible });
const html = '<div data-anm-x="" style="padding:40px"><p>a</p></div>';
const clean: MotionRun = { t0: [n(0)], mid: [n(0.5)], end: [n(1)], before: html, afterCleanup: html, afterResizeCleanup: html, reducedHtml: html, shown: { baseline: { chars: 4, media: 1 }, best: { chars: 4, media: 1 }, reduced: { chars: 4, media: 1 } }, errors: [] };

describe('flashes', () => {
  test('visible en t0, menos visible a mitad y visible al final: apareció antes de su entrada', () => {
    expect(flashes({ t0: [n(0), n(1), n(1)], mid: [n(0.8), n(0.6), n(1)], end: [n(1), n(1), n(1)] })).toEqual([1]);
  });

  test('moverse con el scroll sin perder opacidad no es flash (parallax, velocity)', () => {
    expect(flashes({ t0: [n(1)], mid: [{ ...n(1), transform: '12,0' }], end: [n(1)] })).toEqual([]);
  });
});

describe('normalizeHtml', () => {
  test('la reescritura del style por el navegador no es residuo', () => {
    expect(normalizeHtml('<div style="padding:40px">')).toBe(normalizeHtml('<div style="padding: 40px;">'));
    expect(normalizeHtml('<p style="">x</p>')).toBe('<p>x</p>');
  });

  test('un style que el efecto dejó sí es residuo', () => {
    expect(normalizeHtml('<div>')).not.toBe(normalizeHtml('<div style="opacity: 0;">'));
  });
});

describe('renderVerdict', () => {
  test('una entrada limpia pasa', () => {
    expect(renderVerdict(clean)).toEqual({ pass: true, failures: [] });
  });

  test('residuo tras cleanup, tras resize y DOM tocado con reduced-motion fallan por separado', () => {
    const dirty = html.replace('<p>', '<p style="opacity: 0;">');
    const rules = renderVerdict({ ...clean, afterCleanup: dirty, afterResizeCleanup: dirty, reducedHtml: dirty }).failures.map((f) => f.rule);
    expect(rules).toEqual(['residue', 'residue-resize', 'reduced-touched']);
  });

  test('ver menos que sin el módulo falla; lo que ya no se veía sin él (opacidad del autor, imagen rota) no', () => {
    const shown = (best: number, reduced = 4) => ({ baseline: { chars: 4, media: 1 }, best: { chars: best, media: 1 }, reduced: { chars: reduced, media: 1 } });
    expect(renderVerdict({ ...clean, shown: shown(2) }).failures.map((f) => f.rule)).toEqual(['not-visible']);
    expect(renderVerdict({ ...clean, shown: shown(4, 1) }).failures.map((f) => f.rule)).toEqual(['reduced-hidden']);
    expect(renderVerdict({ ...clean, shown: { baseline: { chars: 2, media: 0 }, best: { chars: 2, media: 0 }, reduced: { chars: 2, media: 0 } } }).pass).toBe(true);
  });

  test('sin nodos de contenido falla', () => {
    expect(renderVerdict({ ...clean, t0: [], mid: [], end: [] }).failures.map((f) => f.rule)).toEqual(['no-roots']);
  });
});

describe('migrateAttrs', () => {
  test('usa el map explícito y, si no, el único hook que termina en el mismo nombre', () => {
    const hooks = ['data-3d-hover-target', 'data-3d-hover-target-max-rotate'];
    expect(migrateAttrs('<div data-3d-hover-target data-max-rotate="20">', hooks)).toBe('<div data-3d-hover-target data-3d-hover-target-max-rotate="20">');
    expect(migrateAttrs('<div data-anm-start="top">', ['data-anm-x'], { 'data-anm-start': 'data-anm-x-start' })).toBe('<div data-anm-x-start="top">');
  });

  test('un atributo que no corresponde a un solo hook queda igual', () => {
    expect(migrateAttrs('<div data-start="1">', ['data-a-start', 'data-b-start'])).toBe('<div data-start="1">');
  });
});

describe('mergeGateRecords', () => {
  test('lo corrido reemplaza su entrada, lo no corrido se conserva y las claves quedan ordenadas', () => {
    const rec = (sha: string, result: 'ok' | 'fail') => ({ sha, result, at: '2026-10-22T00:00:00.000Z' });
    const merged = mergeGateRecords({ 'motion-b': rec('1', 'fail'), 'motion-c': rec('2', 'ok') }, { 'motion-b': rec('3', 'ok'), 'motion-a': rec('4', 'ok') });
    expect(Object.keys(merged)).toEqual(['motion-a', 'motion-b', 'motion-c']);
    expect(merged['motion-b'].sha).toBe('3');
    expect(merged['motion-c'].sha).toBe('2');
  });
});
