import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANVAS_VIEWPORTS, PREVIEW_CHECK_VIEWPORTS } from '../src/render-review';

describe('preview-check a los anchos del lienzo (Q6b)', () => {
  // QA 2026-10-29: el builder muestra 1280 y 390 y verificábamos a 1440 y 375; lo que la persona mira no se medía.
  test('los anchos del check incluyen los marcos del builder, leídos de artboard-canvas.tsx', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'apps', 'builder', 'src', 'components', 'builder', 'artboard-canvas.tsx'), 'utf8');
    const frames = [...src.matchAll(/\{ id: '[a-z]+', label: '[^']+', x: [^,]+, w: (\d+), h: \d+ \}/g)].map((m) => Number(m[1]));
    expect(frames).toEqual([...CANVAS_VIEWPORTS]);
    expect(PREVIEW_CHECK_VIEWPORTS).toEqual([1440, 375, 1280, 390]);
  });
});
