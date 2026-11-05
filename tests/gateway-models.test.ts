import { describe, expect, test } from 'bun:test';
import { allowList, gatewayModels, pickGatewayModels } from '../src/runtime/gateway-models';

const catalog = {
  data: [
    { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', type: 'language' },
    { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', type: 'language' },
    { id: 'anthropic/claude-opus-4.8-fast', name: 'Claude Opus 4.8 (Fast)', type: 'language' },
    { id: 'bfl/flux-3-image-klein', name: 'FLUX 3 klein', type: 'image' },
    'basura',
  ],
};

describe('catálogo de AI Gateway acotado por la lista permitida', () => {
  // Con la key de 15 USD, un visitante no puede elegir un modelo caro que el catálogo sí ofrece.
  test('solo los permitidos que existen con ese tipo, en el orden de la lista', () => {
    const allow = allowList('anthropic/claude-sonnet-5.5, anthropic/claude-opus-5.5,bfl/flux-3-image-klein,anthropic/no-existe', []);
    expect(pickGatewayModels(catalog, allow, 'language').map((m) => [m.id, m.name])).toEqual([
      ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'],
      ['anthropic/claude-opus-5.5', 'Claude Opus 5.5'],
    ]);
    expect(pickGatewayModels(catalog, allow, 'image').map((m) => m.id)).toEqual(['bfl/flux-3-image-klein']);
    expect(allowList('', ['a'])).toEqual(['a']);
  });

  test('sin catálogo quedan los permitidos con su id como nombre', async () => {
    const models = await gatewayModels(['anthropic/claude-opus-5.5'], 'language', async () => { throw new Error('HTTP 503'); });
    expect(models).toEqual([{ id: 'anthropic/claude-opus-5.5', name: 'anthropic/claude-opus-5.5', provider: 'ai-gateway' }]);
  });
});
