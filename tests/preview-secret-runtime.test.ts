// Identidad §9 fase 4 por el Runtime entero, con el gate encendido (opts.previewSecret) y dos dueños: el latido da token
// solo para el ws propio; la url de thread() sin token es 401 en el listener; el canje 307 + cookie da 200; el token de un
// ws no abre otro; el HMR pasa con la cookie. Vite falso (eco y 101) en lugar del pool real: el gate es del listener.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreviewPool } from '../src/runtime/preview';
import { PREVIEW_COOKIE, PREVIEW_TOKEN_PARAM } from '../src/runtime/preview-serve';
import { Runtime } from '../src/runtime/server';
import { ALL_SCOPES, type SessionVerifier } from '../src/runtime/session';

const SECRET = Buffer.alloc(32, 9);
const USER = 'x-qa-user';
const cleanup: (() => void)[] = [];
afterAll(() => { for (const f of cleanup) f(); });

// Dos dueños por header; sin header, 401 como un proveedor real.
const verifier: SessionVerifier = {
  verify: async (h: Readonly<IncomingHttpHeaders>) => {
    const u = h[USER];
    return u === 'A' || u === 'B' ? { owner: u, scopes: ALL_SCOPES } : { status: 401, code: 'no-session', message: 'inicia sesión' };
  },
};

function fakeVite(): Server {
  const s = createServer((sock) => sock.on('data', (c: Buffer) => {
    const b = c.toString('latin1');
    if (!b.includes('\r\n\r\n')) return;
    if (/upgrade:\s*websocket/i.test(b)) { sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); return; }
    const body = `V:${(b.split('\r\n')[0] ?? '').split(' ')[1]}`;
    sock.write(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    sock.end();
  })).listen(0, '127.0.0.1');
  cleanup.push(() => s.close());
  return s;
}

const portOf = (s: { address: () => unknown }): number => (s.address() as { port: number }).port;

async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const p = portOf(s);
  await new Promise((r) => s.close(r));
  return p;
}

/** Primera respuesta cruda: cabeceras y lo que llegue hasta el cierre o 500 ms. */
function raw(port: number, req: string): Promise<string> {
  return new Promise((res) => {
    let out = '';
    const sock = connect(port, '127.0.0.1', () => sock.write(req));
    const done = (): void => { sock.destroy(); res(out); };
    const timer = setTimeout(done, 500);
    sock.on('data', (c: Buffer) => { out += c.toString('latin1'); if (/\r\n\r\n/.test(out) && /^HTTP\/1\.1 (101|307|401)|V:/.test(out)) { clearTimeout(timer); done(); } });
    sock.on('close', () => { clearTimeout(timer); res(out); });
    sock.on('error', () => res(out));
  });
}

function chatWs(root: string, ws: string): string {
  const dir = join(root, 'ws', ws);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'v1');
  return git('rev-parse', 'HEAD');
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wt-preview-secret-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const index = Object.fromEntries((['A', 'B'] as const).map((o) => {
    const ws = `ws-${o.toLowerCase()}`;
    return [ws, { ws, owner: o, title: ws, prompt: 'p', at: 1, endedAt: 2, commit: chatWs(root, ws), outcome: 'ok' }];
  }));
  writeFileSync(join(root, 'index.json'), JSON.stringify(index));
  const vite = fakeVite();
  await new Promise((r) => vite.once('listening', r));
  const pool = { live: () => ({ port: portOf(vite), url: '', localUrl: '' }), see: () => {}, ensure: async () => {}, stableUrl: () => '' } as unknown as PreviewPool;
  const previewPort = await freePort();
  const scaffold = join(root, 'scaffold');
  mkdirSync(scaffold);
  const s = new Runtime({ root, allow: {}, compose: async () => ({ sections: [] }), build: false, scaffoldDir: scaffold, vaultRoot: join(root, 'vault'), session: verifier, previewSecret: SECRET, previews: pool, previewPort }).listen(0, '127.0.0.1');
  cleanup.push(() => s.close());
  await new Promise((r) => s.once('listening', r));
  const api = `http://127.0.0.1:${portOf(s)}`;
  const as = (user: string, path: string, init: RequestInit = {}) => fetch(`${api}${path}`, { ...init, headers: { 'content-type': 'application/json', [USER]: user, ...(init.headers ?? {}) } });
  const beat = async (user: string): Promise<Record<string, { previewToken?: string; url: string }>> =>
    ((await (await as(user, '/preview/heartbeat', { method: 'POST', body: JSON.stringify({ visible: ['ws-a', 'ws-b'] }) })).json()) as { states: Record<string, { previewToken?: string; url: string }> }).states;
  const get = (ws: string, path: string, cookie?: string, upgrade = false): Promise<string> =>
    raw(previewPort, `GET ${path} HTTP/1.1\r\nHost: ${ws}.localhost:${previewPort}\r\n${upgrade ? 'Upgrade: websocket\r\nConnection: Upgrade\r\n' : ''}${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);
  return { as, beat, get };
}

test('gate encendido: token solo del ws propio, url de thread() sin token 401, canje 307 + cookie 200, HMR con cookie', async () => {
  const { as, beat, get } = await setup();

  const a = await beat('A');
  const b = await beat('B');
  expect(typeof a['ws-a']?.previewToken).toBe('string');
  expect(a['ws-b']?.previewToken).toBeUndefined();
  expect(typeof b['ws-b']?.previewToken).toBe('string');
  expect(b['ws-a']?.previewToken).toBeUndefined();
  const tokenA = a['ws-a']!.previewToken!;

  // La url que da thread() es la misma estable del latido, sin token.
  const thread = (await (await as('A', '/chats/ws-a')).json()) as { preview: string | null };
  expect(thread.preview).toBeString();
  expect(thread.preview).not.toContain(PREVIEW_TOKEN_PARAM);
  expect(await get('ws-a', '/')).toStartWith('HTTP/1.1 401');

  // Canje: 307 a la misma ruta sin el token, con la cookie del ws.
  const ex = await get('ws-a', `/?${PREVIEW_TOKEN_PARAM}=${tokenA}`);
  expect(ex).toStartWith('HTTP/1.1 307');
  expect(ex).toMatch(/\r\nlocation: \/\r\n/i);
  const cookie = `${PREVIEW_COOKIE}=${tokenA}`;
  expect(ex).toContain(`set-cookie: ${cookie};`);
  expect(await get('ws-a', '/', cookie)).toContain('V:/');

  // El token de A no abre el ws de B, ni por query ni por cookie.
  expect(await get('ws-b', `/?${PREVIEW_TOKEN_PARAM}=${tokenA}`)).toStartWith('HTTP/1.1 401');
  expect(await get('ws-b', '/', cookie)).toStartWith('HTTP/1.1 401');

  // HMR: el upgrade pasa con la cookie y sin ella se rechaza.
  expect(await get('ws-a', '/', cookie, true)).toStartWith('HTTP/1.1 101');
  expect(await get('ws-a', '/', undefined, true)).toStartWith('HTTP/1.1 401');
}, 30_000);
