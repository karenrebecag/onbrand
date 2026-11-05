import { afterEach, beforeEach, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueIdentity } from '../src/orchestrator/identity';
import { signedVerifierFromEnv } from '../src/runtime/signed-verifier';
import { ALL_SCOPES } from '../src/runtime/session';
import { Runtime } from '../src/runtime/server';

// deploy-sandbox.md §4/§6: WT_SESSION_PROVIDER=signed cablea signedVerifier desde el env de la VM.
const CHAT = 'chat0123456789abcdefghijklmn';
const OTHER = 'othr0123456789abcdefghijklmn';
const keys = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const env = { WT_IDENTITY_PUBLIC_KEY: publicPem, WT_CHAT_ID: CHAT };
let tmp: string;
let server: Server;

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'signed-boot-')); mkdirSync(join(tmp, 'vault')); });
afterEach(() => { server?.close(); rmSync(tmp, { recursive: true, force: true }); });

async function boot(session: ReturnType<typeof signedVerifierFromEnv>, withTrust = true): Promise<string> {
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose: async () => ({ sections: [] }), build: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), session, ...(withTrust ? { trust: { secret: 's'.repeat(32) } } : {}) });
  server = t.listen(0);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('arranque signed: header firmado = 200, sin header = 401', async () => {
  const base = await boot(signedVerifierFromEnv(env));
  const token = issueIdentity(keys.privateKey, { owner: 'user_1', scopes: ALL_SCOPES }, CHAT, 60_000);
  const headers = { 'x-origin-secret': 's'.repeat(32), host: '127.0.0.1' };
  expect((await fetch(`${base}/chats/${'a'.repeat(26)}`, { headers: { ...headers, 'x-wt-identity': token } })).status).toBe(404);
  expect((await fetch(`${base}/chats/${'a'.repeat(26)}`, { headers })).status).toBe(401);
});

test('signed reemplaza a localVerifier: loopback sin x-wt-identity es 401, también sin secreto de origen', async () => {
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose: async () => ({ sections: [] }), build: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), session: signedVerifierFromEnv(env) });
  server = t.listen(0);
  await new Promise((r) => server.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/chats/${'a'.repeat(26)}`);
  expect(res.status).toBe(401);
});

test('POST /runs de una sesión acotada a un chat no abre otro chat en la VM', async () => {
  const base = await boot(signedVerifierFromEnv(env), false);
  const token = issueIdentity(keys.privateKey, { owner: 'user_1', scopes: ALL_SCOPES }, CHAT, 60_000);
  const headers = { 'x-wt-identity': token, 'content-type': 'application/json' };
  const run = (messageId?: string) => fetch(`${base}/runs`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hola', ...(messageId ? { messageId } : {}) }) });
  expect((await run(OTHER)).status).toBe(404);
  expect((await run()).status).toBe(404);
  expect((await run(CHAT)).status).toBe(202);
});

test('WT_CHAT_ID débil no arranca', () => {
  expect(() => signedVerifierFromEnv({ ...env, WT_CHAT_ID: 'corto' })).toThrow('WT_CHAT_ID');
});

test('signedVerifierFromEnv falla con mensaje sin llave, sin chat, con una privada o con otra curva', () => {
  expect(() => signedVerifierFromEnv({ WT_CHAT_ID: 'c' })).toThrow('WT_IDENTITY_PUBLIC_KEY');
  expect(() => signedVerifierFromEnv({ WT_IDENTITY_PUBLIC_KEY: publicPem })).toThrow('WT_CHAT_ID');
  const priv = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  expect(() => signedVerifierFromEnv({ ...env, WT_IDENTITY_PUBLIC_KEY: priv })).toThrow('privada');
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  expect(() => signedVerifierFromEnv({ ...env, WT_IDENTITY_PUBLIC_KEY: ec })).toThrow('Ed25519');
  expect(() => signedVerifierFromEnv({ ...env, WT_IDENTITY_PUBLIC_KEY: publicPem.replace(/\n/g, '\\n') })).not.toThrow();
});

test('serve.ts con signed y sin llave pública sale con 2 y dice por qué', async () => {
  const p = Bun.spawn(['bun', 'scripts/serve.ts'], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', WT_SESSION_PROVIDER: 'signed' }, stdout: 'pipe', stderr: 'pipe' });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  expect(code).toBe(2);
  expect(err).toContain('WT_IDENTITY_PUBLIC_KEY');
});

test('estándar: el runtime nunca lee una llave privada', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const files = [...walk(join(import.meta.dir, '..', 'src', 'runtime')), join(import.meta.dir, '..', 'scripts', 'serve.ts')];
  const hits = files.filter((f) => /PRIVATE_KEY|createPrivateKey|privateKey/.test(readFileSync(f, 'utf8')));
  expect(hits).toEqual([]);
});
