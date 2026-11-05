import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentProps, indexReference, propsOf, type LandingBlockRow } from '../src/ds-skill-agent';
import { BLOCK_CANDIDATES } from '../src/directions';

const schema = (slug: string) => JSON.parse(readFileSync(join(import.meta.dir, '..', 'catalog', 'schemas', `${slug}.schema.json`), 'utf8'));
const row = (role: string, slug: string, exportName: string): LandingBlockRow => ({ role, exportName, importPath: `@/components/arc/blocks/${slug}/${slug}`, props: propsOf(schema(slug), []) });

// El índice decía "lo que no está en esta tabla no existe" y solo listaba átomos: para el agente los bloques no existían.
test('el índice lista los bloques de landing con sus props de contenido, sin estado ni callbacks', () => {
  const md = indexReference([], [row('hero', 'hero-section', 'HeroSection'), row('faq', 'faq-section', 'FaqSection')]);
  const hero = md.split('\n').find((l) => l.startsWith('| hero |'))!;
  const faq = md.split('\n').find((l) => l.startsWith('| faq |'))!;
  for (const p of ['`title`', '`description`', '`primaryAction`']) expect(hero).toContain(p);
  expect(faq).toContain('`items`');
  expect(faq).not.toContain('`onValueChange`');
  expect(md).toContain('<Section id role slug bare>');
  // La fila de variantes de marca se inserta antes de "Reglas universales": los bloques van después para no partirla.
  expect(md.indexOf('## Reglas universales')).toBeLessThan(md.indexOf('## Secciones de landing'));
});

// Una sola colección (items, cards) ya es contenido: el título de la sección lo escribe el agente fuera del bloque.
test('cada bloque candidato de las direcciones tiene props de contenido en su schema', () => {
  for (const { role, id } of BLOCK_CANDIDATES) {
    const slug = id.split('/')[1].split(':')[0];
    expect({ slug, role, props: contentProps(propsOf(schema(slug), [])).length > 0 }).toEqual({ slug, role, props: true });
  }
});

// QA cuenta los elementos de itemsProp: si la prop no existe en el bloque, el conteo da cero sin avisar.
test('el itemsProp de cada candidato es una prop de colección del schema del bloque', () => {
  for (const { id, itemsProp } of BLOCK_CANDIDATES) {
    if (!itemsProp) continue;
    const slug = id.split('/')[1].split(':')[0];
    expect({ id, type: schema(slug).properties?.[itemsProp]?.type }).toEqual({ id, type: 'array' });
  }
});
