// Arranque del orquestador desde el entorno y los puertos de un perfil. Separado de scripts/orchestrator.ts para probarlo sin abrir
// un puerto. Sin perfil, la identidad es cualquier IdP con JWKS/PEM (adapters/jwt) y la VM es un proceso local; las credenciales de
// Gateway (precio, credencial) siempre las aporta el perfil, y sin ellas no arranca.

import { createPrivateKey, type KeyObject } from 'node:crypto';
import { resolve } from 'node:path';
import { jwtVerifierFromEnv } from '../adapters/jwt/verifier';
import { providerVerifier } from '../runtime/session';
import type { ProfileAdapters } from '../profile';
import { createOrchestratorApp } from './app';
import { fsBlobClient } from './fs-blob';
import { localSandboxProvider } from './local-sandbox';
import { ownerCapFromEnv } from './routes';

type Env = Readonly<Record<string, string | undefined>>;

/** WT_ORCH_PRIVATE_KEY: PEM Ed25519 del orquestador. Es la única llave que firma identidad y gasto; la VM solo recibe la pública. */
export function privateKeyFromEnv(env: Env): KeyObject {
  const pem = env.WT_ORCH_PRIVATE_KEY?.trim();
  if (!pem) throw new Error('orquestador: falta WT_ORCH_PRIVATE_KEY (PEM Ed25519 del orquestador)');
  let key: KeyObject;
  try { key = createPrivateKey(pem); } catch { throw new Error('orquestador: WT_ORCH_PRIVATE_KEY no es un PEM privado válido'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('orquestador: WT_ORCH_PRIVATE_KEY debe ser Ed25519');
  return key;
}

/** Una Function de Vercel corta a los 300 s por defecto: los streams se cierran a los 270 s y el builder reconecta por cursor. */
export const DEFAULT_STREAM_MAX_MS = 270_000;
export function streamMaxFromEnv(env: Env): number {
  const raw = env.WT_ORCH_STREAM_MAX_MS?.trim();
  if (!raw) return DEFAULT_STREAM_MAX_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000) throw new Error(`orquestador: WT_ORCH_STREAM_MAX_MS=${raw} debe ser un entero >= 1000 (ms)`);
  return n;
}

export interface OrchestratorBoot {
  readonly fetch: (req: Request) => Promise<Response>;
  readonly port: number;
  /** Dónde escucha: loopback salvo que el despliegue pida otra cosa con WT_ORCH_HOST. */
  readonly host: string;
  /** Precalienta lo que el arranque necesita de la red (las llaves del IdP): sin ellas no hay login posible, mejor no arrancar. */
  readonly warm: () => Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** `now`: reloj del índice y del día UTC de /spend; solo para tests que siembran gasto y lo leen con el mismo día. */
export function orchestratorFromEnv(env: Env, adapters: ProfileAdapters, now?: () => number): OrchestratorBoot {
  if (!adapters.gateway) throw new Error('orquestador: el perfil no aporta el puerto "gateway" (WT_PROFILE_MODULE)');
  const port = env.PORT ? Number(env.PORT) : 5400;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`orquestador: PORT=${env.PORT} debe ser un puerto válido`);
  const host = env.WT_ORCH_HOST?.trim() || '127.0.0.1';
  // La VM local no aísla (comparte máquina y usuario con el orquestador): fuera de loopback solo un proveedor real.
  if (!adapters.sandbox && !LOOPBACK.has(host)) throw new Error(`orquestador: WT_ORCH_HOST=${host} exige que el perfil aporte el puerto "sandbox"; la VM local solo sirve en loopback`);
  const jwt = adapters.authenticate ? undefined : jwtVerifierFromEnv(env);
  const inner = adapters.authenticate ?? ((req: Request) => jwt!.verify(Object.fromEntries(req.headers)));
  // Un authenticate del perfil no puede devolver el dueño 'local' ni uno vacío: compartiría datos con la sesión de loopback del core.
  const authenticate = (req: Request) => providerVerifier({ verify: () => inner(req) }).verify({});
  const sandbox = adapters.sandbox ?? localSandboxProvider({ rootDir: resolve(env.WT_SANDBOX_DIR ?? 'generated/orchestrator-vms'), gatewayUrl: `http://127.0.0.1:${port}` });
  return {
    port,
    host,
    warm: async () => { await jwt?.warm(); },
    fetch: createOrchestratorApp({
      authenticate,
      sandbox,
      gateway: adapters.gateway,
      // Sin BlobStore en el perfil, disco: sirve para local y un solo orquestador (fs-blob.ts lo advierte).
      blob: adapters.blob ?? fsBlobClient(resolve(env.WT_BLOB_DIR ?? 'generated/orchestrator-blob')),
      blobPrefix: env.WT_BLOB_PREFIX?.trim() || 'wt/',
      privateKey: privateKeyFromEnv(env),
      ownerCapUsd: ownerCapFromEnv(env),
      streamMaxMs: streamMaxFromEnv(env),
      ...(adapters.catalog ? { catalog: adapters.catalog } : {}),
      ...(adapters.connectors ? { connectors: adapters.connectors } : {}),
      ...(now ? { now } : {}),
    }),
  };
}
