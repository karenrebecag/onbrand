import { describe, expect, test } from 'bun:test';
import { formOverlay, formTagsFor, itemCount } from '../src/content-form';
import type { RoleCopy } from '../src/copy';

const plan = (name: string, yearlyNote?: string) => ({
  name,
  monthlyPrice: '$19',
  features: ['a', 'b'],
  cta: 'Empezar',
  ...(yearlyNote ? { yearlyNote } : {}),
});

describe('content-form — forma del contenido a tags del selector', () => {
  test('itemCount lee la lista del rol', () => {
    const copy: RoleCopy = { hero: { heading: 'h', description: 'd', cta: 'c' }, pricing: { heading: 'p', plans: [plan('A'), plan('B')] } } as unknown as RoleCopy; // a propósito: copy parcial, solo el rol que se prueba
    expect(itemCount('pricing', copy)).toBe(2);
    expect(itemCount('features', copy)).toBe(0);
  });

  test('n items -> N Columns, con tope en 4', () => {
    const three: RoleCopy = { features: { heading: 'f', items: [1, 2, 3].map((n) => ({ title: `t${n}`, description: 'd' })) } } as RoleCopy;
    const five: RoleCopy = { features: { heading: 'f', items: [1, 2, 3, 4, 5].map((n) => ({ title: `t${n}`, description: 'd' })) } } as RoleCopy;
    const one: RoleCopy = { features: { heading: 'f', items: [{ title: 't', description: 'd' }] } } as RoleCopy;
    expect(formTagsFor('features', three)).toEqual(['3 Columns']);
    expect(formTagsFor('features', five)).toEqual(['4 Columns']);
    expect(formTagsFor('features', one)).toEqual(['1 Column']);
  });

  test('pricing con nota de precio anual suma Tabs; sin nota, no', () => {
    const yearly: RoleCopy = { pricing: { heading: 'p', plans: [plan('A', 'o 2 meses gratis'), plan('B')] } } as RoleCopy;
    const monthly: RoleCopy = { pricing: { heading: 'p', plans: [plan('A'), plan('B')] } } as RoleCopy;
    expect(formTagsFor('pricing', yearly)).toEqual(['2 Columns', 'Tabs']);
    expect(formTagsFor('pricing', monthly)).toEqual(['2 Columns']);
  });

  test('roles sin disposición en columnas no reciben N Columns (faq/logos/steps)', () => {
    const faq: RoleCopy = { faq: { heading: 'q', items: [1, 2, 3, 4].map((n) => ({ question: `q${n}`, answer: 'a' })) } } as RoleCopy;
    const logos: RoleCopy = { logos: { heading: 'l', brands: ['a', 'b', 'c'] } } as RoleCopy;
    const steps: RoleCopy = { steps: { heading: 's', steps: [1, 2, 3].map((n) => ({ tagline: `t${n}`, title: `t${n}`, description: 'd' })) } } as RoleCopy;
    expect(formTagsFor('faq', faq)).toEqual([]);
    expect(formTagsFor('logos', logos)).toEqual([]);
    expect(formTagsFor('steps', steps)).toEqual([]);
  });

  test('formOverlay solo incluye roles con forma', () => {
    const copy: RoleCopy = {
      hero: { heading: 'h', description: 'd', cta: 'c' },
      features: { heading: 'f', items: [{ title: 't', description: 'd' }, { title: 'u', description: 'e' }] },
    } as unknown as RoleCopy; // a propósito: copy parcial, solo los roles que se prueban
    const overlay = formOverlay(copy);
    expect(overlay).toEqual({ features: ['2 Columns'] });
    expect(overlay.pricing).toBeUndefined();
  });

  test('dos formas distintas de pricing dan tags distintos (deja de empatar)', () => {
    const twoAnnual: RoleCopy = { pricing: { heading: 'p', plans: [plan('A', 'anual'), plan('B')] } } as RoleCopy;
    const oneMonthly: RoleCopy = { pricing: { heading: 'p', plans: [plan('A')] } } as RoleCopy;
    expect(formTagsFor('pricing', twoAnnual)).not.toEqual(formTagsFor('pricing', oneMonthly));
  });
});
