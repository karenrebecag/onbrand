import { describe, expect, test } from 'bun:test';
import { contrast, parseColor } from '../src/color-contrast';

describe('parseColor', () => {
  test('oklch del contrato se lee: el preset neutral ya no se salta la medida', () => {
    // Anclas externas: el rojo de CSS Color 4 (§9.4, oklch(62.8% 0.2577 29.23) = #ff0000) y el gris medio #636363.
    expect(parseColor('oklch(62.8% 0.2577 29.23)')).toEqual([255, 0, 0]);
    expect(parseColor('oklch(50% 0 0)')).toEqual([99, 99, 99]);
    // foundation.css:163: el --accent del preset neutral, en % y en fracción.
    expect(parseColor('oklch(33% 0 0)')).toEqual([53, 53, 53]);
    expect(parseColor('oklch(0.33 0 0)')).toEqual([53, 53, 53]);
  });

  test('un translúcido se compone sobre el fondo y no se mide como opaco', () => {
    // foundation.css:164: --accent-subtle del preset violet sobre blanco.
    const subtle = parseColor('rgb(119 71 255 / .13)', [255, 255, 255]);
    expect(subtle).toEqual([237, 231, 255]);
    expect(contrast(subtle!, [255, 255, 255])).toBeLessThan(1.3);
    expect(parseColor('oklch(33% 0 0 / .1)', [255, 255, 255])).toEqual([235, 235, 235]);
  });

  test('un translúcido sin fondo conocido da null en vez de un contraste que la página no tiene', () => {
    expect(parseColor('rgb(119 71 255 / .13)')).toBeNull();
    expect(parseColor('rgba(0, 0, 0, 50%)')).toBeNull();
    expect(parseColor('rgba(0, 0, 0, 1)')).toEqual([0, 0, 0]);
  });
});
