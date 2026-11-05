import { afterAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobConflictError, BlobExistsError, createChatIndex, type BlobClient } from '../src/orchestrator/chat-index';
import { createGatewayProxy, runTokenVerifier } from '../src/orchestrator/gateway-proxy';
import { prefixedBlob } from '../src/orchestrator/prefixed-blob';
import { createOrchestrator } from '../src/orchestrator/routes';
import { fsBlobClient } from '../src/orchestrator/fs-blob';
import { Runtime } from '../src/runtime/server';
import { ALL_SCOPES, type Session } from '../src/runtime/session';
import { signedVerifier } from '../src/runtime/signed-verifier';

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
  close(): Promise<void>;
}

async function rig(cap: number, make: MakeBlob): Promise<Rig> {
  const tmp = mkdtempSync(join(tmpdir(), 'orq-e2e-'));
  const blob = prefixedBlob(make(tmp), 'e2e/');
  const index = createChatIndex({ blob, daily: true });
  const pending: Promise<unknown>[] = [];
  const gateway = createGatewayProxy({
    verify: runTokenVerifier(keys.publicKey, MAX_RUN), index, caps: { owner: cap }, priceOf,
    credential: async () => 'Bearer orquestador', waitUntil: (p) => { pending.push(p); },
    upstream: async () => new Response(JSON.stringify(USAGE), { headers: { 'content-type': 'application/json' } }),
  });
  mkdirSync(join(tmp, 'vault')); mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  const runtimes: Server[] = [];
  const composeSeen: Rig['composeSeen'] = [];
  const bases = new Map<string, string>();
  let origin = '';
  const sessionOf = async (req: Request): Promise<Session | { code: 'no-session' }> => {
    const user = req.headers.get('x-test-user');
    return user ? { owner: user, scopes: ALL_SCOPES } : { code: 'no-session' };
  };
  const orch = createOrchestrator({
    authenticate: sessionOf, index, privateKey: keys.privateKey, gateway: (r) => gateway(r), ownerCapUsd: cap,
    runtimeUrl: async (chat) => {
      const known = bases.get(chat.chatId);
      if (known) return known;
      // Una "VM" por chat: un Runtime que solo acepta la identidad firmada de ese chat.
      const rt = new Runtime({
        root: join(tmp, chat.chatId), allow: {}, build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'),
        session: signedVerifier(keys.publicKey, chat.chatId),
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
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      bases.set(chat.chatId, base);
      return base;
    },
  });
  const server = Bun.serve({ port: 0, fetch: orch });
  origin = `http://127.0.0.1:${server.port}`;
  return {
    origin, index, runtimes, composeSeen,
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

describe.each(STORES)('orquestador de punta a punta (almacén en %s)', (_name, make) => {
  test('crear chat -> correr con identidad y token firmados -> el proxy cobra y el gasto aparece en el índice y en GET /spend', async () => {
    const r = await rig(5, make);
    rigs.push(r);
    const created = await call(r, '/chats', 'user_a', { method: 'POST', body: JSON.stringify({ title: 'mi chat' }) });
    expect(created.status).toBe(201);
    const { chatId } = (await created.json()) as { chatId: string };
    expect((await r.index.getChat('user_a', chatId))?.title).toBe('mi chat');
    expect(((await (await call(r, '/chats', 'user_a')).json()) as { chats: unknown[] }).chats).toHaveLength(1);

    const run = await call(r, `/chats/${chatId}/runs`, 'user_a', { method: 'POST', body: JSON.stringify({ prompt: 'hola', messageId: 'otro-id-que-se-ignora' }) });
    expect(run.status).toBe(202);
    await until(() => r.composeSeen.length > 0);
    // El token que llegó a la corrida es el firmado por el orquestador, no algo que el cliente pudiera mandar.
    expect(r.composeSeen[0]!.token).toMatch(/\./);
    expect(r.composeSeen[0]!.status).toBe(200);
    const spend = (await (await call(r, '/spend', 'user_a')).json()) as { spentUsd: number; capUsd: number; window: string; resetsAt: number };
    expect(spend).toMatchObject({ spentUsd: 3, capUsd: 5, window: 'day' });
    expect(spend.resetsAt).toBeGreaterThan(Date.now());
    expect((await r.index.readSpend('user_a')).spent).toBe(3);
    // Otro dueño tiene su propio contador.
    expect(((await (await call(r, '/spend', 'user_b')).json()) as { spentUsd: number }).spentUsd).toBe(0);
  }, 60_000);

  test('un chat ajeno es 404, sin sesión es 401 y el Runtime no acepta nada que no venga firmado', async () => {
    const r = await rig(5, make);
    rigs.push(r);
    const { chatId } = (await (await call(r, '/chats', 'user_a', { method: 'POST', body: '{}' })).json()) as { chatId: string };
    expect((await call(r, `/chats/${chatId}/runs`, 'user_b', { method: 'POST', body: '{"prompt":"x"}' })).status).toBe(404);
    expect((await call(r, '/chats', undefined)).status).toBe(401);
    const noSession = await call(r, '/spend', undefined);
    expect(noSession.status).toBe(401);
    expect(noSession.headers.get('www-authenticate')).toBe('Bearer');
    // Levanta la "VM" del chat con una corrida legítima y le pega directo, sin pasar por el orquestador.
    await call(r, `/chats/${chatId}/runs`, 'user_a', { method: 'POST', body: '{"prompt":"x"}' });
    await until(() => r.composeSeen.length > 0);
    const rt = r.runtimes[0]!;
    const direct = await fetch(`http://127.0.0.1:${(rt.address() as { port: number }).port}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wt-run-token': 'robado' }, body: '{"prompt":"x"}' });
    expect(direct.status).toBe(401);
  }, 60_000);

  test('una llamada cuya reserva no cabe en el tope restante es 429 sin sumar nada, aunque el dueño esté en cero', async () => {
    const r = await rig(1, make);
    rigs.push(r);
    const { chatId } = (await (await call(r, '/chats', 'user_a', { method: 'POST', body: '{}' })).json()) as { chatId: string };
    await call(r, `/chats/${chatId}/runs`, 'user_a', { method: 'POST', body: '{"prompt":"x"}' });
    await until(() => r.composeSeen.length > 0);
    // La reserva (max_tokens 50 a precio de salida = ~2 USD) supera el tope de 1 USD: no llega al upstream y el contador sigue en 0.
    expect(r.composeSeen[0]!.status).toBe(429);
    expect((await r.index.readSpend('user_a')).spent).toBe(0);
  }, 60_000);
});
