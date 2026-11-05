import { describe, expect, test } from 'bun:test';
import { filesSha } from '../src/files-sha';

describe('filesSha', () => {
  test('no depende del orden de files pero sí de la ruta', () => {
    const a = { path: 'src/a.ts', content: 'x' };
    const b = { path: 'src/b.ts', content: 'y' };
    expect(filesSha([a, b])).toBe(filesSha([b, a]));
    expect(filesSha([a])).not.toBe(filesSha([{ ...a, path: 'src/c.ts' }]));
    expect(filesSha([a])).toMatch(/^[0-9a-f]{64}$/);
  });
});
