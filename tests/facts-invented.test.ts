import { describe, expect, test } from 'bun:test';
import { applyEvent, emptyMessage, parseEvent, type EngineEvent } from '../src/runtime/event-model';

const ev = (body: Record<string, unknown>, seq: number): EngineEvent => parseEvent({ v: 1, messageId: 'm1', seq, at: 1, ...body });

describe('facts.invented', () => {
  test('el fold reemplaza lo inventado, no lo acumula', () => {
    const first = applyEvent(emptyMessage(), ev({ type: 'facts.invented', items: [{ slug: '01-hero', text: '3 cifras del mockup' }] }, 1));
    const second = applyEvent(first, ev({ type: 'facts.invented', items: [{ slug: '02-precios', text: 'precios' }] }, 2));
    expect(second.invented).toEqual([{ slug: '02-precios', text: 'precios' }]);
  });

  test('un plan sin nada inventado deja la lista vacía y los items mal formados se rechazan', () => {
    expect(applyEvent(emptyMessage(), ev({ type: 'facts.invented', items: [] }, 1)).invented).toEqual([]);
    expect(() => ev({ type: 'facts.invented', items: [{ slug: 'x' }] }, 1)).toThrow();
  });
});
