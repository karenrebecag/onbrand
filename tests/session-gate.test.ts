import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Allowlist } from '../src/runtime/runner';
import { ALL_SCOPES, isRejection, localVerifier, type SessionVerifier } from '../src/runtime/session';
import { Runtime, type RuntimeOptions } from '../src/runtime/server';

// docs/spec/identidad-sesion.md §4 y §10 fase 1: el verifier decide antes de cualquier ruta; callbacks del CLI y catálogos
// de modelos quedan fuera; con trust el arranque exige verifier.
const allow: Allowlist = {};
const SECRET = 's'.repeat(32);
let tmp: string;
let server: Server;

async function boot(extra: Partial<RuntimeOptions> = {}): Promise<string> {
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  const t = new Runtime({ root: join(tmp, 'state'), allow, compose: async () => ({ sections: [] }), build: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), models: [{ id: 'm', name: 'M', provider: 'test' }], ...extra });
  server = t.listen(0);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'session-gate-'));
  mkdirSync(join(tmp, 'vault'));
});
afterEach(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const denyAll: SessionVerifier = { verify: async () => ({ code: 'no-session' }) };
const trust = { secret: SECRET };
const withSecret = { 'x-origin-secret': SECRET };

test('localVerifier: loopback es el dueño local con todos los scopes; un Host ajeno es 401', async () => {
  const ok = await localVerifier.verify({ host: '127.0.0.1:5300' });
  expect(isRejection(ok)).toBe(false);
  if (!isRejection(ok)) {
    expect(ok.owner).toBe('local');
    expect(ok.scopes).toEqual(ALL_SCOPES);
  }
  expect(await localVerifier.verify({ host: 'evil.example' })).toMatchObject({ code: 'no-session' });
  // El secreto de origen no es identidad: con Host ajeno y secreto válido sigue sin sesión.
  expect(await localVerifier.verify({ host: 'evil.example', 'x-origin-secret': SECRET })).toMatchObject({ code: 'no-session' });
});

test('sin sesión: 401 con code y WWW-Authenticate, y no lee el body; con loopback pasa', async () => {
  const at = await boot({ session: denyAll });
  const res = await fetch(`${at}/brands`);
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
  expect(await res.json()).toEqual({ error: 'inicia sesión', code: 'no-session' });
  const post = await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  expect(post.status).toBe(401);
  server.close();
  const local = await boot();
  expect((await fetch(`${local}/brands`)).status).toBe(200);
});

test('las rutas de callback del CLI y los catálogos de modelos no piden sesión', async () => {
  const at = await boot({ session: denyAll });
  expect((await fetch(`${at}/models`)).status).toBe(200);
  expect((await fetch(`${at}/image-models`)).status).toBe(200);
  // El callback llega al handler del token de la corrida, que puede responder 401 con su propio cuerpo: no el de sesión.
  for (const path of ['/approval-requests', '/mcp/x']) {
    const cb = await fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(cb.headers.get('www-authenticate')).toBeNull();
    expect(await cb.json()).not.toMatchObject({ code: 'no-session' });
  }
});

test('con trust y sin verifier el arranque falla; con verifier el secreto solo no basta', async () => {
  expect(() => new Runtime({ root: join(tmp, 's1'), allow, compose: async () => ({ sections: [] }), build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), trust })).toThrow('SessionVerifier');
  const at = await boot({ trust, session: denyAll });
  expect((await fetch(`${at}/brands`, { headers: withSecret })).status).toBe(401);
  expect((await fetch(`${at}/models`, { headers: withSecret })).status).toBe(200);
  expect((await fetch(`${at}/brands`)).status).toBe(403);
});

test('un verifier que lanza o que trae su propio texto: 401 con el texto fijo, sin filtrar el mensaje', async () => {
  const boom: SessionVerifier = { verify: async () => { throw new Error('sdk secreto interno'); } };
  const at = await boot({ session: boom });
  const res = await fetch(`${at}/brands`);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: 'inicia sesión', code: 'no-session' });
  server.close();
  const chatty: SessionVerifier = { verify: async () => ({ code: 'expired', message: 'token abc vencido en tenant X' } as never) };
  const at2 = await boot({ session: chatty });
  const expired = await fetch(`${at2}/brands`);
  expect(expired.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  expect(await expired.json()).toEqual({ error: 'la sesión venció', code: 'expired' });
});
