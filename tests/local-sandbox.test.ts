import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config';
import type { ChatEntry } from '../src/orchestrator/chat-index';
import { DEFAULT_COMMAND, localSandboxProvider, VM_ENV_ALLOW, VM_ENV_DENY, type LocalSandboxOptions } from '../src/orchestrator/local-sandbox';
import { codeFiles, ROOT } from './estandares-scan';
import type { SandboxEnv } from '../src/orchestrator/sandbox';

const FAKE = join(REPO_ROOT, 'tests', 'fixtures', 'fake-runtime.ts');
const chat = (id: string): ChatEntry => ({ chatId: id, owner: 'u', title: '', sandbox: { name: '' }, head: { messageId: '', commit: '' }, updatedAt: 0, spend: 0 });
const envFor = (id: string): SandboxEnv => ({ WT_IDENTITY_PUBLIC_KEY: 'PUB', WT_PREVIEW_PUBLIC_KEY: 'PUB', WT_CHAT_ID: id });
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops.splice(0)) await s(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function rig(extra: { env?: Record<string, string | undefined>; gatewayUrl?: string; startupMs?: number } & Partial<LocalSandboxOptions> = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-sandbox-'));
  dirs.push(rootDir);
  const { env, ...rest } = extra;
  const p = localSandboxProvider({ rootDir, command: ['bun', '--no-env-file', FAKE], passEnv: ['FAKE_RUNTIME_MODE'], log: () => undefined, retryAfterMs: 0, env: { PATH: process.env.PATH, WT_ORCH_PRIVATE_KEY: 'SECRETO', WT_TZ: 'x', ...env }, ...rest });
  const vm = (id: string) => JSON.parse(readFileSync(join(rootDir, id, 'vm.json'), 'utf8')) as { pid: number; argv: string[]; env: Record<string, string> };
  return { p, rootDir, vm };
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50)); };

test('ensure levanta un Runtime por chat en puertos propios, con la identidad firmada y sin la llave del orquestador', async () => {
  const { p, vm } = rig({ gatewayUrl: 'http://localhost:5400/' });
  stops.push(() => p.stop('chat-a'));
  const h = await p.ensure(chat('chat-a'), envFor('chat-a'));
  expect(h.name).toBe('local-chat-a');
  expect(h.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(h.previewUrl).toMatch(/^http:\/\/localhost:\d+$/);
  const seen = vm('chat-a');
  expect(seen.env).toMatchObject({ WT_SESSION_PROVIDER: 'signed', WT_CHAT_ID: 'chat-a', WT_IDENTITY_PUBLIC_KEY: 'PUB', WT_PREVIEW_PUBLIC_KEY: 'PUB', WT_TZ: 'x', WT_GATEWAY_BASE_URL: 'http://localhost:5400/gw/claude-code' });
  expect(seen.env.WT_ORCH_PRIVATE_KEY).toBeUndefined();
  expect(seen.argv).toContain('--root');
});

test('un segundo ensure, también simultáneo, reutiliza la misma VM; chats distintos tienen puertos distintos', async () => {
  const { p, vm } = rig();
  stops.push(() => p.stop('chat-a'), () => p.stop('chat-b'));
  const [a1, a2] = await Promise.all([p.ensure(chat('chat-a'), envFor('chat-a')), p.ensure(chat('chat-a'), envFor('chat-a'))]);
  expect(a2).toBe(a1);
  expect((await p.ensure(chat('chat-a'), envFor('chat-a'))).apiUrl).toBe(a1.apiUrl);
  const b = await p.ensure(chat('chat-b'), envFor('chat-b'));
  expect(b.apiUrl).not.toBe(a1.apiUrl);
  expect(vm('chat-a').pid).not.toBe(vm('chat-b').pid);
});

test('stop mata el proceso y el siguiente ensure levanta otro; si el proceso muere solo, también', async () => {
  const { p, vm } = rig();
  stops.push(() => p.stop('chat-a'));
  const first = await p.ensure(chat('chat-a'), envFor('chat-a'));
  const pid = vm('chat-a').pid;
  await p.stop('chat-a');
  await until(() => !alive(pid));
  expect(alive(pid)).toBe(false);
  const second = await p.ensure(chat('chat-a'), envFor('chat-a'));
  expect(second.apiUrl).not.toBe(first.apiUrl);
  const pid2 = vm('chat-a').pid;
  process.kill(pid2, 'SIGKILL');
  await until(() => !alive(pid2));
  const third = await p.ensure(chat('chat-a'), envFor('chat-a'));
  expect(vm('chat-a').pid).not.toBe(pid2);
  expect(third.name).toBe('local-chat-a');
});

test('un Runtime que sale o no responde antes de estar listo rechaza con su salida', async () => {
  const dead = rig({ env: { FAKE_RUNTIME_MODE: 'die' } });
  await expect(dead.p.ensure(chat('chat-d'), envFor('chat-d'))).rejects.toThrow(/salió con 3 antes de estar listo/);
  const silent = rig({ env: { FAKE_RUNTIME_MODE: 'silent' }, startupMs: 300 });
  await expect(silent.p.ensure(chat('chat-s'), envFor('chat-s'))).rejects.toThrow('no arrancó en 300 ms');
});

// Hallazgos del security-reviewer sobre el proveedor local.
test('la VM solo hereda una lista permitida: ninguna llave ni secreto del orquestador llega a vm.json', async () => {
  const { p, vm } = rig({ passEnv: ['PERFIL_OK'], env: { ANTHROPIC_API_KEY: 'k1', WT_PREVIEW_SECRET: 'k2', WT_ORIGIN_SECRET: 'k3', BLOB_READ_WRITE_TOKEN: 'k4', AI_GATEWAY_API_KEY: 'k5', VERCEL_OIDC_TOKEN: 'k6', WT_FOO_TOKEN: 'k7', WT_BAR_API_KEY: 'k8', PERFIL_SECRETO: 'k9', PERFIL_OK: 'va', WT_COMPOSE_PROVIDER: 'cli', WT_PROFILE_MODULE: '/perfil.ts' } });
  stops.push(() => p.stop('chat-a'));
  await p.ensure(chat('chat-a'), envFor('chat-a'));
  const seen = vm('chat-a').env;
  for (const name of ['ANTHROPIC_API_KEY', 'WT_PREVIEW_SECRET', 'WT_ORIGIN_SECRET', 'BLOB_READ_WRITE_TOKEN', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'WT_FOO_TOKEN', 'WT_BAR_API_KEY', 'PERFIL_SECRETO', 'WT_ORCH_PRIVATE_KEY', 'WT_PROFILE_MODULE']) expect(seen[name]).toBeUndefined();
  expect(seen).toMatchObject({ PERFIL_OK: 'va', WT_COMPOSE_PROVIDER: 'cli', WT_IDENTITY_PUBLIC_KEY: 'PUB' });
  // El proceso real no carga el .env de la raíz del repo (una llave del orquestador ahí llegaría a la VM).
  expect(DEFAULT_COMMAND).toContain('--no-env-file');
});

test('el módulo del perfil solo llega a la VM si el perfil lo pide por passEnv', async () => {
  const { p, vm } = rig({ passEnv: ['WT_PROFILE_MODULE'], env: { WT_PROFILE_MODULE: '/perfil.ts' } });
  stops.push(() => p.stop('chat-p'));
  await p.ensure(chat('chat-p'), envFor('chat-p'));
  expect(vm('chat-p').env.WT_PROFILE_MODULE).toBe('/perfil.ts');
});

test('un chatId con barras o puntos se rechaza antes de crear nada', async () => {
  const { p, rootDir } = rig();
  for (const bad of ['../x', 'a/b', '', 'a'.repeat(65), 'a b']) await expect(p.ensure(chat(bad), envFor('x'))).rejects.toThrow('chatId inválido');
  expect(existsSync(join(rootDir, '..', 'x'))).toBe(false);
});

test('stop durante el arranque lo cancela y la VM no queda registrada ni viva', async () => {
  const { p, vm } = rig({ env: { FAKE_RUNTIME_MODE: 'slow' } });
  const starting = p.ensure(chat('chat-x'), envFor('chat-x'));
  await new Promise((r) => setTimeout(r, 100));
  await p.stop('chat-x');
  await expect(starting).rejects.toThrow('se detuvo durante el arranque');
  const pid = vm('chat-x').pid;
  await until(() => !alive(pid));
  expect(alive(pid)).toBe(false);
});

test('puertos distintos y un segundo intento si el primer arranque sale (puerto ocupado)', async () => {
  const seq = [7001, 7001, 7002, 7003, 7004];
  const { p, vm } = rig({ env: { FAKE_RUNTIME_MODE: 'die-once' }, freePort: async () => seq.shift() ?? 7999 });
  stops.push(() => p.stop('chat-a'));
  await p.ensure(chat('chat-a'), envFor('chat-a'));
  const argv = vm('chat-a').argv;
  const api = argv[argv.indexOf('--port') + 1];
  const preview = argv[argv.indexOf('--preview-port') + 1];
  expect(api).not.toBe(preview);
});

test('tope de VM global y por dueño, y espera mínima tras un arranque fallido', async () => {
  const { p } = rig({ maxVms: 2, maxPerOwner: 1 });
  stops.push(() => p.stop('c1'), () => p.stop('c2'));
  await p.ensure({ ...chat('c1'), owner: 'a' }, envFor('c1'));
  await expect(p.ensure({ ...chat('c2'), owner: 'a' }, envFor('c2'))).rejects.toThrow('máximo de VM');
  await p.ensure({ ...chat('c2'), owner: 'b' }, envFor('c2'));
  await expect(p.ensure({ ...chat('c3'), owner: 'c' }, envFor('c3'))).rejects.toThrow('demasiadas VM');
  // Un arranque fallido no se reintenta de inmediato.
  let t = 1000;
  const slow = rig({ env: { FAKE_RUNTIME_MODE: 'die' }, retryAfterMs: 500, now: () => t });
  await expect(slow.p.ensure(chat('chat-f'), envFor('chat-f'))).rejects.toThrow('salió con 3');
  await expect(slow.p.ensure(chat('chat-f'), envFor('chat-f'))).rejects.toThrow('reintenta en unos segundos');
  t += 600;
  await expect(slow.p.ensure(chat('chat-f'), envFor('chat-f'))).rejects.toThrow('salió con 3');
});

test('el error de arranque no lleva la salida del hijo (puede llegar a HTTP); el detalle va al log', async () => {
  const logs: string[] = [];
  const { p } = rig({ env: { FAKE_RUNTIME_MODE: 'die' }, log: (m) => logs.push(m) });
  const err = await p.ensure(chat('chat-d'), envFor('chat-d')).catch((e: Error) => e);
  expect((err as Error).message).not.toContain('no puedo arrancar');
  expect(logs.join('\n')).toContain('no puedo arrancar');
});

test('la allowlist de env de la VM cubre exactamente los WT_* que lee el runtime: nada sin clasificar, nada viejo', () => {
  // Todo lo que corre dentro de la VM o la arranca: el runtime, serve.ts, los MCP/proxies hijos y el scaffold. Sin comentarios, para que
  // una mención en prosa no cuente como lectura.
  const files = [...codeFiles(['src']).filter((f) => !f.startsWith('src/orchestrator/')), ...codeFiles(['scripts']), ...codeFiles(['templates/base-scaffold']).filter((f) => /vite\.config\./.test(f))];
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const read = new Set<string>();
  for (const f of files) {
    const src = strip(readFileSync(join(ROOT, f), 'utf8'));
    // process.env.X, env.X, env['X'], constantes *_ENV = 'WT_X' (lectura dinámica) y destructuring de process.env/env.
    for (const m of src.matchAll(/(?:process\.env|\benv)(?:\.|\[['"])(WT_[A-Z0-9_]+)/g)) read.add(m[1]!);
    for (const m of src.matchAll(/_ENV\s*=\s*['"](WT_[A-Z0-9_]+)['"]/g)) read.add(m[1]!);
    for (const d of src.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\.env|env)\b/g)) for (const n of d[1]!.matchAll(/\bWT_[A-Z0-9_]+/g)) read.add(n[0]);
  }
  const classified = new Set([...VM_ENV_ALLOW, ...VM_ENV_DENY]);
  expect([...read].filter((n) => !classified.has(n)).sort(), 'WT_* leídos por el runtime sin clasificar en VM_ENV_ALLOW o VM_ENV_DENY').toEqual([]);
  expect([...VM_ENV_ALLOW].filter((n) => !read.has(n)).sort(), 'VM_ENV_ALLOW trae variables que nadie lee').toEqual([]);
  expect([...VM_ENV_ALLOW].filter((n) => VM_ENV_DENY.has(n))).toEqual([]);
});

test('un WT_* con un secreto sin palabra clave en el nombre no llega a la VM', async () => {
  const { p, vm } = rig({ env: { WT_DB_PASS: 's1', WT_API_AUTH: 's2', WT_SENTRY_DSN: 's3', WT_TZ: 'UTC' } });
  stops.push(() => p.stop('chat-w'));
  await p.ensure(chat('chat-w'), envFor('chat-w'));
  const seen = vm('chat-w').env;
  for (const name of ['WT_DB_PASS', 'WT_API_AUTH', 'WT_SENTRY_DSN']) expect(seen[name]).toBeUndefined();
  expect(seen.WT_TZ).toBe('UTC');
});
