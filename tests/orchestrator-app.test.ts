import { afterAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobConflictError, BlobExistsError, createChatIndex, type BlobClient } from '../src/orchestrator/chat-index';
import { createOrchestratorApp } from '../src/orchestrator/app';
import { fakeSandboxProvider, type FakeSandbox } from '../src/orchestrator/sandbox';
import { prefixedBlob } from '../src/orchestrator/prefixed-blob';
import { fsBlobClient } from '../src/orchestrator/fs-blob';
import { Runtime } from '../src/runtime/server';
import { ALL_SCOPES } from '../src/runtime/session';
import { signedVerifierFromEnv } from '../src/runtime/signed-verifier';

// deploy-sandbox.md §6 paso 2: el orquestador real (rutas, índice, identidad, run token, proxy) contra un Runtime con sessionProvider
// 'signed'. Crear chat -> índice en Blob -> POST /chats/:id/runs -> la corrida llama al proxy con su token -> el gasto queda en el
// índice. El upstream de Gateway es falso (sin gasto); el almacén corre en memoria y en disco (fs-blob), el mismo contrato que cualquier adaptador.

class MemBlob implements BlobClient {
  readonly files = new Map<string, { text: string; etag: number }>();
  private seq = 0;
  async read(p: string) { const h = this.files.get(p); return h ? { text: h.text, etag: `e${h.etag}` } : undefined; }
  async create(p: string, body: string) { if (this.files.has(p)) throw new BlobExistsError(p); this.files.set(p, { text: body, etag: ++this.seq }); return { etag: `e${this.seq}` }; }
  async replace(p: string, body: string, ifMatch: string) {
    const h = this.files.get(p);
    if (!h || `e${h.etag}` !== ifMatch) throw new BlobConflictError(p);
    this.files.set(p, { text: body, etag: ++this.seq });
    return { etag: `e${this.seq}` };
  }
  async list(prefix: string) { return [...this.files.keys()].filter((k) => k.startsWith(prefix)); }
}

type MakeBlob = (dir: string) => BlobClient;
const STORES: readonly (readonly [string, MakeBlob])[] = [['memoria', () => new MemBlob()], ['disco', (dir) => fsBlobClient(join(dir, 'blob'))]];
const keys = generateKeyPairSync('ed25519');
const MAX_RUN = 2 * 3_600_000;
const USAGE = { model: 'm', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
// 1 USD por 100 tokens de entrada y 2 por 50 de salida: el gasto de una llamada es exactamente 3 USD.
const priceOf = (_m: string, u: { input: number; output: number }): number => u.input / 100 + u.output / 25;

interface Rig {
  readonly origin: string;
  readonly index: ReturnType<typeof createChatIndex>;
  readonly runtimes: Server[];
  readonly composeSeen: { token?: string; status?: number }[];
  readonly sandbox: FakeSandbox;
  close(): Promise<void>;
}

async function rig(cap: number, make: MakeBlob): Promise<Rig> {
  const tmp = mkdtempSync(join(tmpdir(), 'orq-e2e-'));
  mkdirSync(join(tmp, 'vault')); mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  const blob = make(tmp);
  const pending: Promise<unknown>[] = [];
  const runtimes: Server[] = [];
  const composeSeen: Rig['composeSeen'] = [];
  let origin = '';
  // La "VM" de cada chat: un Runtime que solo acepta la identidad firmada de ese chat y recibe la pública por su entorno.
  const sandbox = fakeSandboxProvider(async (chat, env) => {
    const rt = new Runtime({
      root: join(tmp, chat.chatId), allow: {}, build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'),
      session: signedVerifierFromEnv(env),
      compose: async (req) => {
        const r = await fetch(`${origin}/gw/claude-code/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${req.runToken}`, 'content-type': 'application/json' }, body: '{"model":"m","max_tokens":50,"messages":[]}' });
        await r.arrayBuffer();
        composeSeen.push({ token: req.runToken, status: r.status });
        return { sections: [] };
      },
    });
    const server = rt.listen(0);
    await new Promise((r) => server.once('listening', r));
    runtimes.push(server);
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  const orch = createOrchestratorApp({
    authenticate: async (req) => { const user = req.headers.get('x-test-user'); return user ? { owner: user, scopes: ALL_SCOPES } : { code: 'no-session' }; },
    blob, blobPrefix: 'e2e/', sandbox: sandbox.provider, privateKey: keys.privateKey, ownerCapUsd: cap,
    gateway: { priceOf, credential: async () => 'Bearer orquestador', waitUntil: (p) => { pending.push(p); }, upstream: async () => new Response(JSON.stringify(USAGE), { headers: { 'content-type': 'application/json' } }) },
  });
  const server = Bun.serve({ port: 0, fetch: orch });
  origin = `http://127.0.0.1:${server.port}`;
  const index = createChatIndex({ blob: prefixedBlob(blob, 'e2e/'), daily: true });
  return {
    origin, index, runtimes, composeSeen, sandbox,
    async close() {
      await Promise.allSettled(pending);
      server.stop(true);
      for (const r of runtimes) r.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const call = (r: Rig, path: string, user: string | undefined, init: RequestInit = {}) =>
  fetch(`${r.origin}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...(init.headers as Record<string, string> | undefined) } });
const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25)); };

const rigs: Rig[] = [];
afterAll(async () => { for (const r of rigs) await r.close(); });

describe.each(STORES)('createOrchestratorApp (almacén en %s)', (_name, make) => {
  test('la VM nace con la pública y el chat, se anota en el índice y se reutiliza en la segunda corrida; el gasto se cobra', async () => {
    const r = await rig(5, make);
    rigs.push(r);
    const { chatId } = (await (await call(r, '/chats', 'user_a', { method: 'POST', body: '{}' })).json()) as { chatId: string };
    expect((await call(r, `/chats/${chatId}/runs`, 'user_a', { method: 'POST', body: '{"prompt":"hola"}' })).status).toBe(202);
    await until(() => r.composeSeen.length > 0);
    const env = r.sandbox.envs.get(chatId)!;
    expect(env.WT_CHAT_ID).toBe(chatId);
    expect(env.WT_IDENTITY_PUBLIC_KEY).toContain('BEGIN PUBLIC KEY');
    // Nada que firme o gaste viaja en el entorno de la VM.
    expect(Object.keys(env).sort()).toEqual(['WT_CHAT_ID', 'WT_IDENTITY_PUBLIC_KEY', 'WT_PREVIEW_PUBLIC_KEY']);
    expect((await r.index.getChat('user_a', chatId))?.sandbox.name).toBe(`fake-${chatId}`);
    // Segunda corrida (follow-up del mismo ws): ensure otra vez, pero no hay VM nueva.
    await call(r, `/chats/${chatId}/runs`, 'user_a', { method: 'POST', body: JSON.stringify({ prompt: 'otra', parentId: chatId }) });
    expect(r.sandbox.calls.filter((c) => c === `ensure:${chatId}`).length).toBeGreaterThanOrEqual(1);
    expect(r.runtimes).toHaveLength(1);
    expect((await r.index.readSpend('user_a')).spent).toBeGreaterThanOrEqual(3);
  }, 60_000);
});
