import { test, expect } from 'bun:test';
import { liftNodeProvenance, normalizeProvenance, valueAtPath } from '../src/runtime/provenance';
import type { LayoutSection } from '../src/runtime/layout';

// QA (corrida real :5300, casos de 817da32c): el modelo parafrasea los claims, así que exigir literal
// perdía recall (tiraba nombre/cargo/empresa que SÍ inventó). La regla deriva el hecho del valor.
const section: LayoutSection = {
  role: 'hero',
  children: [
    { component: 'hero-signup', props: {
      count: 3800, // número → se conserva, claims []
      quote: 'Ya somos 3,800 personas esperando', // cifra en el valor → claim "3,800"
      author: 'Lucía Herrera', // nombre corto → claims [] (el valor es el hecho)
      role: 'Head of Product en Trazo', // cargo+empresa corto → claims []
      brand: 'Lumora', // marca → claims []
      headline: 'Convierte cada visita en una venta con tu lista', // copy con verbo de marketing → fuera
      description: 'La forma más simple de validar tu idea antes de construir el producto completo', // copy largo → fuera
      cta: { href: '#' }, // placeholder → claims []
    } } as any,
  ],
  provenance: {
    'children[0].props.count': { claims: ['3,800 personas ya están en la lista'] },
    'children[0].props.quote': { claims: ['3,800 personas ya están esperando en la lista'] },
    'children[0].props.author': { claims: ['Lucía Herrera, una persona ficticia'] },
    'children[0].props.role': { claims: ['es Head of Product en la empresa Trazo'] },
    'children[0].props.brand': { claims: ['Lumora es una marca inventada'] },
    'children[0].props.headline': { claims: ['promesa de valor inventada'] },
    'children[0].props.description': { claims: ['descripción de producto inventada'] },
    'children[0].props.cta.href': { claims: [] },
    'children[0].props.inexistente': { claims: ['algo'] },
  },
};

test('valueAtPath resuelve rutas de array y props', () => {
  expect(valueAtPath(section, 'children[0].props.count')).toBe(3800);
  expect(valueAtPath(section, 'children[0].props.cta.href')).toBe('#');
  expect(valueAtPath(section, 'children[0].props.inexistente')).toBeUndefined();
});

test('normalizeProvenance conserva hechos (nombre/cargo/marca/cifra/número/#) y descarta copy', () => {
  const out = normalizeProvenance(section).provenance!;
  expect(Object.keys(out).sort()).toEqual([
    'children[0].props.author',
    'children[0].props.brand',
    'children[0].props.count',
    'children[0].props.cta.href',
    'children[0].props.quote',
    'children[0].props.role',
  ]);
  expect(out['children[0].props.count'].claims).toEqual([]); // número
  expect(out['children[0].props.quote'].claims).toEqual(['3,800']); // cifra extraída del valor
  expect(out['children[0].props.author'].claims).toEqual([]); // nombre corto
  expect(out['children[0].props.role'].claims).toEqual([]); // cargo+empresa corto
  expect(out['children[0].props.brand'].claims).toEqual([]); // marca
  expect(out['children[0].props.cta.href'].claims).toEqual([]); // placeholder
  expect(out['children[0].props.headline']).toBeUndefined(); // copy con verbo → fuera
  expect(out['children[0].props.description']).toBeUndefined(); // copy largo → fuera
  expect(out['children[0].props.inexistente']).toBeUndefined(); // no resuelve
});

test('un claim literal del modelo se respeta tal cual', () => {
  const s: LayoutSection = {
    role: 'stats',
    children: [{ component: 'stats-band', props: { label: 'Más de 4,000 equipos confían en nosotros' } } as any],
    provenance: { 'children[0].props.label': { claims: ['4,000 equipos'] } },
  };
  expect(normalizeProvenance(s).provenance!['children[0].props.label'].claims).toEqual(['4,000 equipos']);
});

// Nimbus 91253120 (QA final2): el modelo dejó `provenance` dentro del nodo cta-section y el runner tumbó la
// página entera ("trae provenance fuera de props"). La información es correcta; se sube a la sección con la ruta.
test('liftNodeProvenance sube la provenance de un nodo a la sección con la ruta del nodo', () => {
  const s: LayoutSection = {
    role: 'cta',
    children: [
      { layout: 'stack', children: [
        { component: 'cta-section', props: { title: 'Únete a 4,000 equipos' }, provenance: { 'props.title': { claims: ['4,000'] } } } as any,
      ] },
    ],
    provenance: { 'children[0].children[0].props.href': { claims: [] } },
  };
  const out = liftNodeProvenance(s);
  expect((out.children[0] as any).children[0]).toEqual({ component: 'cta-section', props: { title: 'Únete a 4,000 equipos' } });
  expect(out.provenance).toEqual({
    'children[0].children[0].props.title': { claims: ['4,000'] },
    'children[0].children[0].props.href': { claims: [] },
  });
  expect((s.children[0] as any).children[0].provenance).toBeDefined(); // inmutable: la entrada no se tocó
  expect(liftNodeProvenance({ role: 'x', children: [{ component: 'a', props: {} }] })).toEqual({ role: 'x', children: [{ component: 'a', props: {} }] });
});
