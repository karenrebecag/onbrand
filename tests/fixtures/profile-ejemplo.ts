// Perfil de ejemplo para los tests del cargador (ADR 0017): las mismas decisiones que tenía el perfil de una distro (compose por la
// sesión local, imágenes y enhancer por proveedor externo, publish local, brandsRoot fuera del repo, puertos del orquestador), sin
// nombre de cliente. Un perfil real vive en su propio repo y se carga con WT_PROFILE_MODULE.

import { join } from 'node:path';
import { webflowFacts } from '../../src/brand-facts-source';
import { REPO_ROOT } from '../../src/config';
import { fakeSandboxProvider } from '../../src/orchestrator/sandbox';
import type { ProfileAdapters, ProfileRole } from '../../src/profile';

export const name = 'ejemplo';

export const defaults = {
  composeProvider: 'cli',
  imageProvider: 'profile',
  enhancerProvider: 'gateway',
  transcribeProvider: 'gateway',
  publishProvider: 'local',
  sessionProvider: 'local',
  vaultRoot: '/vault/de/ejemplo',
  brandsRoot: join(REPO_ROOT, '..', 'packs-ejemplo'),
  builderOrigin: undefined,
} as const;

export function adapters(env: Readonly<Record<string, string | undefined>>, role: ProfileRole): ProfileAdapters {
  // Los SDK de los puertos del orquestador se importan con `await import()` DENTRO de la rama del rol y de la función que los usa,
  // nunca arriba del archivo: con el módulo en passEnv, el filtro por rol solo cubre este cuerpo, y un import de nivel superior
  // (un SDK de IdP, por ejemplo) se evaluaría en la VM junto al código del agente.
  if (role === 'orchestrator') {
    const sandbox = fakeSandboxProvider(async () => env.WT_EJEMPLO_VM_URL ?? 'http://127.0.0.1:1').provider;
    return {
      authenticate: async (req) => {
        await import('node:crypto'); // aquí iría el import del SDK del IdP
        const user = req.headers.get('x-ejemplo-user');
        return user ? { owner: user, scopes: new Set(['chat:read', 'chat:write', 'spend'] as const) } : { code: 'no-session' };
      },
      sandbox,
      gateway: { priceOf: () => 0, credential: async () => 'Bearer ejemplo', waitUntil: () => undefined, upstream: async () => new Response('{}') },
    };
  }
  return {
    facts: (base) => ({ factsSources: { ejemplo: webflowFacts(base, 'ejemplo') }, factsAssets: [{ host: 'cdn.ejemplo.test', prefixes: ['/assets/'] }] }),
    registry: async () => ({ pin: 'ejemplo', loadIndex: async () => ({}), getItem: async () => { throw new Error('ejemplo'); }, makeSchemaStore: () => () => null }),
    publish: { publish: async () => ({ url: 'https://ejemplo.test', files: 0, bytes: 0 }) },
    image: { gen: () => async () => ({ bytes: new Uint8Array(), mediaType: 'image/png' }), models: [{ id: 'ejemplo/imagen', name: 'Imagen de ejemplo', provider: 'ejemplo' }] },
    session: { verify: async () => ({ code: 'no-session' as const }) },
  };
}
