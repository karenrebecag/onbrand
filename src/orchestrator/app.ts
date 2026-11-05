// Cableado del orquestador por inyección: el core no sabe de Clerk, Vercel ni de ningún proveedor. Quien arranca (la distro o un
// script local) entrega la autenticación, el almacén, la VM por chat y las credenciales del Gateway; aquí solo se conectan.

import { createPublicKey, type KeyObject } from 'node:crypto';
import { createChatIndex, type BlobClient } from './chat-index';
import { createGatewayProxy, runTokenVerifier, type GatewayProxyDeps } from './gateway-proxy';
import { prefixedBlob } from './prefixed-blob';
import { createOrchestrator, type OrchestratorDeps } from './routes';
import { cachedSandbox } from './cached-sandbox';
import type { SandboxProvider } from './sandbox';

export interface OrchestratorAppDeps {
  readonly authenticate: OrchestratorDeps['authenticate'];
  readonly blob: BlobClient;
  /** Prefijo de todo lo que el orquestador escribe (WT_BLOB_PREFIX); termina en `/`. */
  readonly blobPrefix: string;
  readonly sandbox: SandboxProvider;
  /** Par Ed25519 del orquestador: firma identidad y token de gasto; la VM solo recibe la pública. */
  readonly privateKey: KeyObject;
  readonly ownerCapUsd: number;
  readonly runTtlMs?: number;
  /** Lo del proxy que es del proveedor: precio, credencial, upstream y waitUntil de la Function. */
  readonly gateway: Pick<GatewayProxyDeps, 'priceOf' | 'credential' | 'upstream' | 'waitUntil' | 'onError' | 'upstreamUrl' | 'deadlineMs'>;
  /** Techo de vida de un token de corrida; el mismo valor lo usa el verificador del proxy. */
  readonly maxRunTtlMs?: number;
  readonly now?: () => number;
  readonly catalog?: OrchestratorDeps['catalog'];
  readonly connectors?: OrchestratorDeps['connectors'];
  readonly streamMaxMs?: number;
}

export const DEFAULT_MAX_RUN_TTL_MS = 2 * 3_600_000;

export function createOrchestratorApp(deps: OrchestratorAppDeps): (req: Request) => Promise<Response> {
  const index = createChatIndex({ blob: prefixedBlob(deps.blob, deps.blobPrefix), daily: true, ...(deps.now ? { now: deps.now } : {}) });
  // ensure de un proveedor real es una llamada a su API y el orquestador lo pide en cada request (SSE, reconexiones): cache corto.
  const sandbox = cachedSandbox(deps.sandbox);
  const publicPem = createPublicKey(deps.privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const gateway = createGatewayProxy({
    ...deps.gateway,
    verify: runTokenVerifier(createPublicKey(deps.privateKey), deps.maxRunTtlMs ?? DEFAULT_MAX_RUN_TTL_MS, deps.now),
    index,
    caps: { owner: deps.ownerCapUsd },
    ...(deps.now ? { now: deps.now } : {}),
  });
  return createOrchestrator({
    authenticate: deps.authenticate,
    index,
    privateKey: deps.privateKey,
    gateway,
    ownerCapUsd: deps.ownerCapUsd,
    ...(deps.runTtlMs === undefined ? {} : { runTtlMs: deps.runTtlMs }),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.catalog ? { catalog: deps.catalog } : {}),
    ...(deps.connectors ? { connectors: deps.connectors } : {}),
    ...(deps.streamMaxMs === undefined ? {} : { streamMaxMs: deps.streamMaxMs }),
    runtimeUrl: async (chat) => {
      const handle = await sandbox.ensure(chat, { WT_IDENTITY_PUBLIC_KEY: publicPem, WT_PREVIEW_PUBLIC_KEY: publicPem, WT_CHAT_ID: chat.chatId });
      // El nombre de la VM se anota una vez: el índice es la verdad de qué chat vive en qué sandbox (spec §3).
      if (chat.sandbox.name !== handle.name) await index.updateChat(chat.owner, chat.chatId, (c) => ({ ...c, sandbox: { ...c.sandbox, name: handle.name } }));
      return handle.apiUrl;
    },
  });
}
