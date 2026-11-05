import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, REPO_ROOT } from '../src/catalog/load';

// Compuestos (Dialog.Root…): sin interface de props que tsPropsOf lea, gen-schemas no les escribe schema.
// toggle-group entra aquí: es compuesto (ToggleGroup + ToggleGroupItem) y sus props son una unión
// discriminada con `extends` (Single | Multiple), que el parser plano de tsPropsOf no aplana.
const COMPOUNDS = new Set(['dialog', 'drawer', 'popover', 'tabs', 'toggle-group']);

describe('schemas de componentes', () => {
  test('todo átomo con props que puede ir en un slot tiene schema: sin él check_layout no ve sus required', () => {
    const missing = loadCatalog({ requireManifest: false })
      .filter((e) => e.library === 'arc' && e.kind === 'component' && e.emittable !== false && !COMPOUNDS.has(e.slug))
      .filter((e) => !existsSync(join(REPO_ROOT, 'catalog', 'schemas', 'components', `${e.slug}.schema.json`)))
      .map((e) => e.slug);
    expect(missing).toEqual([]);
  });
});
