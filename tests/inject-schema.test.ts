import { describe, expect, test } from 'bun:test';
import { injectBySchema } from '../src/catalog/inject-schema';
import type { JsonSchema } from '../src/catalog/schema-gen';
import type { CatalogEntry } from '../src/catalog/schema';
import type { RoleCopy } from '../src/copy';

const entry = (role: string): CatalogEntry => ({ role } as unknown as CatalogEntry);

const featuresCopy: RoleCopy = {
  features: {
    heading: 'Todo tu WhatsApp',
    description: 'Una sola plataforma.',
    items: [
      { title: 'Responde al instante', description: 'Acme contesta 24/7.' },
      { title: 'Cierra ventas', description: 'Del chat al carrito.' },
    ],
  },
} as unknown as RoleCopy;

describe('injectBySchema — contenido real sin inventar (paso 4.3b)', () => {
  test('llena los props de contenido escalares desde el copy del rol', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        title: { type: 'string', format: 'heading' },
        description: { type: 'string', format: 'description' },
        accent: { type: 'string', enum: ['blue', 'green'] }, // config: no se toca
      },
    };
    const props = injectBySchema(entry('features'), schema, featuresCopy);
    expect(props).toEqual({ title: 'Todo tu WhatsApp', description: 'Una sola plataforma.' });
  });

  test('llena un array de items PURO de contenido (features)', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          items: { type: 'object', required: ['title'], properties: { title: { format: 'heading' }, description: { format: 'description' } } },
        },
      },
    };
    const props = injectBySchema(entry('features'), schema, featuresCopy);
    expect(props?.cards).toEqual([
      { title: 'Responde al instante', description: 'Acme contesta 24/7.' },
      { title: 'Cierra ventas', description: 'Del chat al carrito.' },
    ]);
  });

  test('NO llena un array estructural de app (item requiere start/end que el copy no da)', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'title', 'start', 'end'],
            properties: { id: { type: 'string' }, title: { format: 'heading' }, start: { type: 'object' }, end: { type: 'object' } },
          },
        },
      },
    };
    // Sin ningún prop de contenido llenable, devuelve undefined: el bloque usa su demo, no un item roto.
    expect(injectBySchema(entry('features'), schema, featuresCopy)).toBeUndefined();
  });

  test('descarta un array de estado (defaultX) aunque su item parezca contenido', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        defaultCards: {
          type: 'array',
          items: { type: 'object', required: ['title'], properties: { title: { format: 'heading' } } },
        },
      },
    };
    expect(injectBySchema(entry('features'), schema, featuresCopy)).toBeUndefined();
  });

  test('undefined si el rol no trae copy para el bloque', () => {
    const schema: JsonSchema = { type: 'object', properties: { title: { format: 'heading' } } };
    expect(injectBySchema(entry('pricing'), schema, featuresCopy)).toBeUndefined();
  });
});
