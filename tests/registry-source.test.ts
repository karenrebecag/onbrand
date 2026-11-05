import { test, expect } from 'bun:test';
import { openRegistry, type BlobReader } from '../src/runtime/registry-source';

// Reader falso: el índice inmutable + dos items. Prueba la lógica del adaptador sin red ni creds
// (CI no tiene blob.env). El e2e contra el registry real se corre a mano con blob.env.
const INDEX = {
  version: 'testsha',
  items: {
    accordion: { path: 'r/accordion@aa.json', allow: { kind: 'component', category: 'disclosure' }, hasSchema: true },
    badge: { path: 'r/badge@bb.json', allow: { kind: 'component', category: 'data' }, hasSchema: true },
  },
};
const ITEMS: Record<string, unknown> = {
  'r/accordion@aa.json': { name: 'accordion', type: 'registry:ui', files: [{ path: 'accordion.tsx', content: 'x' }], schema: { type: 'object' } },
  'r/badge@bb.json': { name: 'badge', type: 'registry:ui', files: [], schema: { type: 'string' } },
};
const fakeRead: BlobReader = async (path) => {
  if (path === 'index@testsha.json') return INDEX;
  if (ITEMS[path]) return ITEMS[path];
  throw new Error(`404 ${path}`);
};

test('el adaptador del registry resuelve pin, allow, item y schema-store', async () => {
  const reg = await openRegistry({ pin: 'testsha', read: fakeRead });
  expect(reg.pin).toBe('testsha');

  // loadIndex arma el AllowEntry por slug (para shortlist de #68)
  const allow = await reg.loadIndex();
  expect(Object.keys(allow)).toEqual(['accordion', 'badge']);
  expect(allow.accordion.category).toBe('disclosure');

  // getItem baja el item por su path (con el sha) y cachea
  const item = await reg.getItem('accordion');
  expect(item.files.length).toBe(1);

  // makeSchemaStore solo resuelve lo ya traído (mismo set que va a check_layout); lo no traído = null
  const store = reg.makeSchemaStore();
  expect(store('accordion')).toEqual({ type: 'object' });
  expect(store('badge')).toBeNull();

  // slug desconocido falla cerrada
  await expect(reg.getItem('no-existe')).rejects.toThrow('slug desconocido');
});

// Spec ranuras-de-marca: las ranuras van por ruta en el índice; un pin anterior no las trae y se devuelve undefined
// para que quien valida un pack con `components` falle cerrado.
test('extensionPoints sale de la ruta del índice y es undefined en un pin sin ella', async () => {
  const points = { button: { prop: 'variant', slots: ['bg'], base: ['primary'] } };
  const reads: string[] = [];
  const read: BlobReader = async (path) => {
    reads.push(path);
    if (path === 'index@withpts.json') return { ...INDEX, extensionPoints: 'extension-points@pp.json' };
    if (path === 'extension-points@pp.json') return points;
    return fakeRead(path);
  };
  const reg = await openRegistry({ pin: 'withpts', read });
  expect(await reg.extensionPoints?.()).toEqual(points);
  await reg.extensionPoints?.();
  expect(reads.filter((p) => p.startsWith('extension-points@'))).toHaveLength(1);
  expect(await (await openRegistry({ pin: 'testsha', read: fakeRead })).extensionPoints?.()).toBeUndefined();
});
