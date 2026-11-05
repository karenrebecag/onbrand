import { describe, expect, test } from 'bun:test';
import { fillGeneratedKeys } from '../src/runtime/generated-keys';

// QA-FINAL (b): FeatureBento renderizaba una lista sin `key` porque el modelo omite features[].id, opcional en el
// schema por ser clave técnica. Se rellena en código, por schema, y nunca pisa un id que el modelo sí puso.
const schema = {
  type: 'object',
  properties: {
    heading: { type: 'string' },
    features: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, tags: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' } } } } } } },
    plans: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
    media: { 'x-slot': { accepts: ['media'] } },
  },
} as unknown;
const schemaOf = (slug: string) => (slug === 'features' ? (schema as never) : null);

describe('fillGeneratedKeys', () => {
  test('rellena id/key que faltan con prop-índice, anidado, y respeta los que vienen; arrays sin clave técnica no cambian', () => {
    const out = fillGeneratedKeys({ role: 'features', children: [{ component: 'features', props: { heading: 'H', features: [{ title: 'a', tags: [{ label: 'x' }] }, { id: 'propio', title: 'b' }], plans: [{ name: 'Team' }] } }] }, schemaOf);
    const props = (out.children[0] as unknown as { props: { features: { id: string; tags?: { key: string }[] }[]; plans: unknown[] } }).props;
    expect(props.features.map((f) => f.id)).toEqual(['features-0', 'propio']);
    expect(props.features[0].tags![0].key).toBe('tags-0');
    expect(props.plans).toEqual([{ name: 'Team' }]);
  });
  test('entra en los slots y deja igual a un componente sin schema o a un nodo de layout', () => {
    const out = fillGeneratedKeys({ role: 'hero', children: [{ layout: 'stack', children: [{ component: 'otro', props: { items: [{ a: 1 }] } }, { component: 'features', props: { media: { $slot: { component: 'features', props: { features: [{ title: 'z' }] } } } } }] }] } as never, schemaOf);
    const stack = out.children[0] as { children: { props: Record<string, unknown> }[] };
    expect(stack.children[0].props).toEqual({ items: [{ a: 1 }] });
    expect(((stack.children[1].props.media as { $slot: { props: { features: { id: string }[] } } }).$slot.props.features[0].id)).toBe('features-0');
  });
});
