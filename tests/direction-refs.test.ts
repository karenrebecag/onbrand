import { expect, test } from 'bun:test';
import { BLOCK_CANDIDATES, DIRECTIONS, directionReference, type BlockCandidate } from '../src/directions';
import { directionBlocks, directionRefDefects, traceBlocks } from '../src/direction-refs';

const d = DIRECTIONS.find((x) => x.id === 'premium-sobrio')!;
const call = (name: string, input: Record<string, unknown>) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const write = (slug: string, content = '') => call('Write', { file_path: `/ws/src/sections/${slug}.tsx`, content });
const read = (ref: string) => call('Read', { file_path: `/ws/src/components/relume/${ref}` });
const uses = (b: BlockCandidate) => `import { ${b.exportName} } from "${b.importPath}";\n<${b.exportName}${b.variant ? ` ${b.variant.prop}="${b.variant.value}"` : ''} />`;
const cand = (id: string) => BLOCK_CANDIDATES.find((c) => c.id === id)!;

test('directionBlocks lee de direction.md el bloque y la variante que eligió la corrida', () => {
  const blocks = directionBlocks(directionReference(d, undefined, 'semilla-1'));
  expect(Object.keys(blocks).length).toBeGreaterThan(0);
  for (const [role, b] of Object.entries(blocks)) expect(b!.forms).toContain(role === 'navbar' ? 'top-bar' : d.roles[role as keyof typeof d.roles].form);
  expect(blocks.navbar).toBeDefined();
});

test('sin bloque, cada sección cuenta como leída solo si su ref se citó antes del primer Write', () => {
  const stream = [read(d.roles.pricing.ref), write('06-precios'), write('04-testimonios'), read(d.roles.testimonials.ref), call('Edit', { file_path: '/ws/src/sections/04-testimonios.tsx' }), write('01-navbar')].join('\n');
  const r = directionRefDefects(stream, d);
  expect([r.checked, r.read, r.defects.map((x) => x.section)]).toEqual([2, 1, ['04-testimonios']]);
});

test('casos acepta el ref de testimonios o el bloque elegido para stats', () => {
  const blocks = { stats: cand('arc/stats-band:divided') };
  expect(directionRefDefects([read(d.roles.testimonials.ref), write('05-casos')].join('\n'), d, blocks).defects).toEqual([]);
  expect(directionRefDefects(write('05-casos', uses(blocks.stats)), d, blocks).defects).toEqual([]);
});

// #292: con Bloque en la fila el agente importa el bloque que eligió la corrida, con su variante; leer el ref no cumple.
test('con bloque exige el import y la variante elegidos, aunque lleguen en un Edit posterior', () => {
  const blocks = { hero: cand('arc/hero-section:split'), faq: cand('arc/faq-section:columns'), cta: cand('arc/cta-section:banner') };
  const stream = [
    write('02-hero', uses(cand('arc/hero-section:centered'))),
    read(d.roles.faq.ref), write('07-faq'),
    write('08-cierre'), call('Edit', { file_path: '/ws/src/sections/08-cierre.tsx', old_string: '', new_string: uses(blocks.cta) }),
  ].join('\n');
  const r = directionRefDefects(stream, d, blocks);
  expect([r.checked, r.defects.map((x) => x.section)]).toEqual([3, ['02-hero', '07-faq']]);
});

// #300: el elegido viaja en agent.trace.blocks; uno que salió del catálogo se exige igual por import y variante.
test('traceBlocks toma el candidato por id y conserva el que ya no está en el catálogo', () => {
  const known = cand('arc/faq-section:columns');
  const gone = { role: 'hero', id: 'x/viejo', importPath: '@/components/x/viejo/viejo', variant: { prop: 'variant', value: 'a' } };
  const blocks = traceBlocks([{ role: 'faq', id: known.id, importPath: known.importPath, variant: known.variant }, gone]);
  expect(blocks.faq).toBe(known);
  expect(directionRefDefects(write('02-hero', 'import { V } from "@/components/x/viejo/viejo";\n<V variant="a" />'), d, blocks).defects).toEqual([]);
});

test('con plan, solo se exigen las secciones del plan, y el defecto es de severidad A', () => {
  const blocks = { pricing: cand('morphin/morphin-pricing-table') };
  const stream = [write('06-precios'), write('03-hero')].join('\n');
  const r = directionRefDefects(stream, d, blocks, new Set(['06-precios']));
  expect(r.defects.map((x) => [x.section, x.severity])).toEqual([['06-precios', 'A']]);
});

test('con bloque de navbar, 01-navbar escrita sin importarlo es defecto', () => {
  const blocks = { navbar: cand('arc/site-header') };
  expect(directionRefDefects([write('01-navbar')].join('\n'), d, blocks).defects.map((x) => x.section)).toEqual(['01-navbar']);
  expect(directionRefDefects([write('01-navbar')].join('\n'), d).checked).toBe(0);
});
