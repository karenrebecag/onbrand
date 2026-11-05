import { describe, expect, test } from 'bun:test';
import { parsePagePlanMd } from '../src/page-plan-md';
import { MAX_PLAN_BYTES, changesBlock, mergePlanEdit, stripUserMarks, userLines } from '../src/runtime/plan-edit';

const ORIGINAL = [
  'Objetivo: landing de Acme',
  'idioma: es',
  '',
  '## Cambios',
  '## 01-hero · #inicio',
  '- titular: Atiende por WhatsApp',
  '- cta: Hablar con ventas',
  '- inventado: nada',
  '## 02-precios',
  '- titular: Planes',
  '- conteo: 3 tarjetas',
  '',
  '## Archivos',
  '- src/sections/01-hero.tsx: crear',
  '',
  '## Preguntas',
  '- focal: supongo la foto del equipo',
].join('\n');

const edit = (from: string, to: string, text = ORIGINAL): string => text.replace(from, to);
const ok = (original: string, edited: string) => {
  const r = mergePlanEdit(original, edited);
  if (!r.ok) throw new Error(r.message);
  return r;
};

describe('mergePlanEdit', () => {
  test('marca dentro de la línea solo lo que la persona cambió y el parser sigue leyendo el campo', () => {
    const edited = edit('- titular: Atiende por WhatsApp', '- titular: Vende por WhatsApp');
    const r = ok(ORIGINAL, edited);
    expect(r.plan).toContain('- titular: usuario: Vende por WhatsApp');
    expect(r.userLines).toBe(1);
    const hero = parsePagePlanMd(changesBlock(r.plan)!).sections[0]!;
    expect(hero.slug).toBe('01-hero');
    expect(hero.fields.titular).toBe('usuario: Vende por WhatsApp');
    expect(ok(ORIGINAL, ORIGINAL).userLines).toBe(0);
  });

  test('es idempotente: guardar el borrador ya marcado da el mismo plan', () => {
    const first = ok(ORIGINAL, edit('- conteo: 3 tarjetas', '- conteo: 4 tarjetas')).plan;
    expect(ok(ORIGINAL, first).plan).toBe(first);
    expect(stripUserMarks(first)).toBe(edit('- conteo: 3 tarjetas', '- conteo: 4 tarjetas'));
  });

  test('una entrada nueva lleva todos sus campos marcados aunque alguno coincida con el original, y el encabezado no', () => {
    const edited = edit('## Archivos', '## 03-faq\n- titular: Preguntas\n- inventado: nada\n\n## Archivos');
    const r = ok(ORIGINAL, edited);
    expect(r.plan).toContain('## 03-faq\n- titular: usuario: Preguntas\n- inventado: usuario: nada');
    expect(r.plan).toContain('- inventado: nada\n## 02-precios');
  });

  test('viñetas y líneas sueltas fuera de Cambios usan las otras dos formas; los encabezados nunca', () => {
    const edited = edit('Objetivo: landing de Acme', 'Objetivo: landing de Acme Academy', edit('- src/sections/01-hero.tsx: crear', '- src/sections/01-hero.tsx (editar)'));
    const r = ok(ORIGINAL, edited);
    expect(r.plan).toContain('usuario: Objetivo: landing de Acme Academy');
    expect(r.plan).toContain('- usuario: src/sections/01-hero.tsx (editar)');
    expect(userLines(r.plan).map((l) => l.text)).toEqual(['Objetivo: landing de Acme Academy', '- src/sections/01-hero.tsx (editar)']);
    expect(r.plan.split('\n').filter((l) => l.includes('usuario: #'))).toEqual([]);
  });

  test('changesBlock corta en la siguiente sección: el focal de Preguntas no pisa a la última entrada', () => {
    const precios = parsePagePlanMd(changesBlock(ORIGINAL)!).sections.at(-1)!;
    expect(precios.slug).toBe('02-precios');
    expect(precios.fields.focal).toBeUndefined();
    expect(parsePagePlanMd(ORIGINAL).sections.at(-1)!.fields.focal).toBe('supongo la foto del equipo');
  });

  test('rechaza con código: tamaño, sin Cambios, sin entradas y slug repetido', () => {
    const code = (edited: string) => {
      const r = mergePlanEdit(ORIGINAL, edited);
      return r.ok ? 'ok' : r.code;
    };
    expect(code(ORIGINAL + 'x'.repeat(MAX_PLAN_BYTES))).toBe('too_large');
    expect(code(edit('## Cambios', '## Plan'))).toBe('no_changes_section');
    expect(code('## Cambios\nsin entradas\n## Archivos')).toBe('no_entries');
    expect(code(edit('## 02-precios', '## 01-hero'))).toBe('duplicate_slug');
  });
});
