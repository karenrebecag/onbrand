import { describe, expect, test } from 'bun:test';
import { MEMORY_FULL } from '../src/runtime/memory-edit';
import { REMEMBER_DEF, rememberFact } from '../src/runtime/memory-tool';

const ctx = { messageId: 'm1', date: '2026-11-04' };
const FACT = 'La marca habla de tú y sin tecnicismos';

describe('remember', () => {
  test('agrega una línea con messageId y fecha', () => {
    const r = rememberFact('', { fact: FACT }, ctx);
    expect(r).toMatchObject({ ok: true, added: true, text: `- ${FACT} · m1 · 2026-11-04\n` });
  });

  test('un duplicado exacto responde que ya lo sabía y no cambia el texto', () => {
    const first = rememberFact('', { fact: FACT }, ctx);
    const again = first.ok ? rememberFact(first.text, { fact: FACT }, { ...ctx, messageId: 'm2' }) : undefined;
    expect(again).toMatchObject({ ok: true, added: false, text: first.ok ? first.text : '' });
    expect(again?.reply).toContain('Ya lo sabía');
  });

  test('rechaza correo, teléfono, token y más de 200 caracteres', () => {
    for (const fact of ['Escribir a ana@acme.com', 'Llamar al +52 55 1234 5678', 'La key es sk_live_51HxYzAbCdEfGhIjKlMnOp', 'x'.repeat(201)]) {
      expect(rememberFact('', { fact }, ctx).ok).toBe(false);
    }
  });

  test('llena sin replaces falla con MEMORY_FULL; con replaces sustituye y devuelve la línea vieja', () => {
    const full = Array.from({ length: 40 }, (_, i) => `- hecho ${i} · seed · 2026-11-04`).join('\n');
    expect(rememberFact(full, { fact: FACT }, ctx)).toEqual({ ok: false, reply: MEMORY_FULL });
    const swap = rememberFact(full, { fact: FACT, replaces: 'hecho 7' }, ctx);
    expect(swap).toMatchObject({ ok: true, added: true, replaced: '- hecho 7 · seed · 2026-11-04' });
    expect(swap.ok && swap.text.split('\n').filter(Boolean)).toHaveLength(40);
  });

  test('replaces que no existe o que cae en varias líneas es error y no escribe', () => {
    const mem = '- tono cercano uno · a · 2026-11-04\n- tono cercano dos · a · 2026-11-04\n';
    expect(rememberFact(mem, { fact: FACT, replaces: 'inexistente' }, ctx).ok).toBe(false);
    expect(rememberFact(mem, { fact: FACT, replaces: 'tono cercano' }, ctx).ok).toBe(false);
  });

  test('un input sin fact es error, y la definición pide solo fact', () => {
    expect(rememberFact('', {}, ctx).ok).toBe(false);
    expect(rememberFact('', { fact: FACT, replaces: 3 }, ctx).ok).toBe(false);
    expect(REMEMBER_DEF.input_schema.required).toEqual(['fact']);
  });

  test('el fact que se emite es el que quedó guardado, con saltos colapsados y " · " normalizado', () => {
    const r = rememberFact('', { fact: 'Tono · cercano\nsin jerga' }, ctx);
    expect(r.ok && r.fact).toBe('Tono - cercano sin jerga');
    expect(r.ok && r.text).toBe('- Tono - cercano sin jerga · m1 · 2026-11-04\n');
  });
});
