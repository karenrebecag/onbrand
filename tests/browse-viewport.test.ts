import { describe, expect, test } from 'bun:test';
import { segmentsOf } from '../src/runtime/browser';
import { parseBrowseInput } from '../src/runtime/workspace-tools';

const person = { width: 390, height: 844 };

describe('Q6: browser a la medida de la persona', () => {
  test('sin viewport mide al de la persona, con su alto', () => {
    const r = parseBrowseInput({}, person);
    expect(r.ok && r.value.viewport).toBe(390);
    expect(r.ok && r.value.height).toBe(844);
  });

  test('1440 y 375 siguen valiendo y no arrastran el alto de la persona', () => {
    const r = parseBrowseInput({ viewport: 1440 }, person);
    expect(r.ok && r.value.viewport).toBe(1440);
    expect(r.ok && r.value.height).toBeUndefined();
  });

  test('un ancho que no es fijo ni el de la persona se rechaza; sin persona, el viewport sigue siendo obligatorio', () => {
    expect(parseBrowseInput({ viewport: 800 }, person).ok).toBe(false);
    expect(parseBrowseInput({}).ok).toBe(false);
  });

  test('los tramos usan el alto del viewport de la persona', () => {
    expect(segmentsOf(2000, 390, true, 0, undefined, 844).map((s) => s.height)).toEqual([844, 844, 312]);
  });
});
