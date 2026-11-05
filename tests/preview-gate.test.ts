// Token de preview con alcance de ws (identidad-sesion.md §9-§10 fase 4): sin token, con el de otro ws o vencido → 401;
// el token de la query se canjea por cookie con un 307; el upgrade de HMR pasa solo con la cookie. Reloj inyectado.
import { afterAll, expect, test } from 'bun:test';
import { connect, createServer, type Server } from 'node:net';
import type { PreviewPool } from '../src/runtime/preview';
import { PREVIEW_COOKIE, PREVIEW_TOKEN_PARAM, startPreviewServer, type PreviewResolve } from '../src/runtime/preview-serve';
import { PreviewDist } from '../src/runtime/preview-dist';
import { previewTokenExp, signPreviewToken, verifyPreviewToken } from '../src/runtime/preview-token';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = Buffer.alloc(32, 7);
const NOW = 1_800_000_000_000;
const gate = { secret: SECRET, now: () => NOW };
const tokenFor = (ws: string, exp = NOW + 60_000, secret = SECRET): string => signPreviewToken({ ws, owner: 'a', exp }, secret);

const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });
const track = (s: Server): Server => { servers.push(s); return s; };
const addr = (s: Server): number => (s.address() as { port: number }).port;

// Vite falso: eco del path y upgrade WS con 101.
function fakeVite(): Server {
  return track(createServer((sock) => sock.on('data', (c: Buffer) => {
    const b = c.toString('latin1');
    if (!b.includes('\r\n\r\n')) return;
    if (/upgrade:\s*websocket/i.test(b)) { sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); return; }
    const body = `V:${(b.split('\r\n')[0] ?? '').split(' ')[1]}`;
    sock.write(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    sock.end();
  })).listen(0, '127.0.0.1'));
}

function gatedServer(): number {
  const vite = fakeVite();
  const pool = { live: () => ({ port: addr(vite), url: '', localUrl: '' }) } as unknown as PreviewPool;
  const resolve: PreviewResolve = { dirFor: (ws) => (ws === 'abc' || ws === 'otro' ? `/ws/${ws}` : undefined), distFor: () => undefined, ready: () => true };
  return addr(track(startPreviewServer(pool, resolve, 0, '127.0.0.1', undefined, undefined, gate)));
}

/** Primera respuesta cruda de una petición: cabeceras y lo que llegue hasta el cierre o 300 ms. */
function raw(port: number, req: string): Promise<string> {
  return new Promise((res) => {
    let out = '';
    const sock = connect(port, '127.0.0.1', () => sock.write(req));
    const finish = (): void => { sock.destroy(); res(out); };
    const timer = setTimeout(finish, 300);
    sock.on('data', (c: Buffer) => { out += c.toString('latin1'); if (/\r\n\r\n/.test(out) && (/^HTTP\/1\.1 (101|307|401)/.test(out) || /V:/.test(out))) { clearTimeout(timer); finish(); } });
    sock.on('close', () => { clearTimeout(timer); res(out); });
    sock.on('error', () => res(out));
  });
}

const get = (port: number, path: string, ws = 'abc', cookie?: string): Promise<string> =>
  raw(port, `GET ${path} HTTP/1.1\r\nHost: ${ws}.localhost:${port}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);

test('el token solo vale para su ws, sin alterar y antes de vencer', () => {
  expect(verifyPreviewToken(tokenFor('abc'), SECRET, 'abc', NOW)).toEqual({ ok: true, owner: 'a', exp: NOW + 60_000 });
  expect(verifyPreviewToken(tokenFor('otro'), SECRET, 'abc', NOW)).toEqual({ ok: false, code: 'invalid' });
  expect(verifyPreviewToken(tokenFor('abc', NOW), SECRET, 'abc', NOW)).toEqual({ ok: false, code: 'expired' });
  expect(verifyPreviewToken(tokenFor('abc', NOW + 60_000, Buffer.alloc(32, 9)), SECRET, 'abc', NOW)).toEqual({ ok: false, code: 'invalid' });
  const [payload, sig] = tokenFor('abc').split('.');
  const forged = Buffer.from(JSON.stringify({ ws: 'abc', owner: 'b', exp: NOW + 60_000 })).toString('base64url');
  expect(verifyPreviewToken(`${forged}.${sig}`, SECRET, 'abc', NOW).ok).toBe(false);
  expect(verifyPreviewToken(`${payload}`, SECRET, 'abc', NOW).ok).toBe(false);
  expect(() => signPreviewToken({ ws: 'abc', owner: 'a', exp: NOW }, Buffer.alloc(16))).toThrow('32 bytes');
});

test('sin token, con el de otro ws o vencido → 401; un ws inexistente también 401 (no se sondea el índice)', async () => {
  const p = gatedServer();
  const denied = await get(p, '/');
  expect(denied).toStartWith('HTTP/1.1 401');
  expect(denied).toContain('www-authenticate: Bearer');
  expect(await get(p, `/?${PREVIEW_TOKEN_PARAM}=${tokenFor('otro')}`)).toStartWith('HTTP/1.1 401');
  expect(await get(p, '/', 'abc', `${PREVIEW_COOKIE}=${tokenFor('otro')}`)).toStartWith('HTTP/1.1 401');
  expect(await get(p, '/', 'abc', `${PREVIEW_COOKIE}=${tokenFor('abc', NOW - 1)}`)).toStartWith('HTTP/1.1 401');
  expect(await get(p, `/?${PREVIEW_TOKEN_PARAM}=${tokenFor('abc', NOW)}`)).toStartWith('HTTP/1.1 401');
  expect(await get(p, '/', 'noexiste')).toStartWith('HTTP/1.1 401');
});

test('el token de la query se canjea por cookie con 307 a la misma ruta sin el token, y la cookie sirve la página', async () => {
  const p = gatedServer();
  const t = tokenFor('abc');
  const r = await get(p, `/app?x=1&${PREVIEW_TOKEN_PARAM}=${t}`);
  expect(r).toStartWith('HTTP/1.1 307');
  expect(r).toMatch(/\r\nlocation: \/app\?x=1\r\n/);
  expect(r).toContain(`set-cookie: ${PREVIEW_COOKIE}=${t}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=60`);
  expect(r).toContain('referrer-policy: no-referrer');
  expect(r).not.toContain('V:');
  expect(await get(p, '/app?x=1', 'abc', `otra=1; ${PREVIEW_COOKIE}=${t}`)).toContain('V:/app?x=1');
});

test('el upgrade de HMR pasa con la cookie del ws y sin ella se rechaza', async () => {
  const p = gatedServer();
  const upgrade = (cookie?: string): Promise<string> =>
    raw(p, `GET /?token=hmr HTTP/1.1\r\nHost: abc.localhost:${p}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);
  expect(await upgrade(`${PREVIEW_COOKIE}=${tokenFor('abc')}`)).toStartWith('HTTP/1.1 101');
  expect(await upgrade()).toStartWith('HTTP/1.1 401');
  expect(await upgrade(`${PREVIEW_COOKIE}=${tokenFor('otro')}`)).toStartWith('HTTP/1.1 401');
  // El token en la query del upgrade no se canjea: el WS no puede recibir Set-Cookie.
  expect(await raw(p, `GET /?${PREVIEW_TOKEN_PARAM}=${tokenFor('abc')} HTTP/1.1\r\nHost: abc.localhost:${p}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)).toStartWith('HTTP/1.1 401');
});

// security-reviewer: hallazgos sobre el gate, cada uno con su repro.
test('H1: un token con cola tras "=" o con CRLF no verifica ni llega a Set-Cookie', async () => {
  const t = tokenFor('abc');
  expect(verifyPreviewToken(`${t}=`, SECRET, 'abc', NOW).ok).toBe(false);
  expect(verifyPreviewToken(`${t}=\r\nSet-Cookie: x=y`, SECRET, 'abc', NOW).ok).toBe(false);
  const p = gatedServer();
  const r = await get(p, `/?${PREVIEW_TOKEN_PARAM}=${t}%3D%0D%0ASet-Cookie:%20x=y`);
  expect(r).toStartWith('HTTP/1.1 401');
  expect(r).not.toContain('x=y');
});

test('M2: el 307 nunca apunta a otro host (//evil)', async () => {
  const p = gatedServer();
  const r = await get(p, `/.//evil.com/x?${PREVIEW_TOKEN_PARAM}=${tokenFor('abc')}`);
  expect(r).toStartWith('HTTP/1.1 307');
  const location = /\r\nlocation: ([^\r]*)\r\n/.exec(r)?.[1] ?? '';
  expect(location).toStartWith('/');
  expect(location).not.toStartWith('//');
});

test('M3: una cookie basura plantada por otro ws (Domain del padre) no tapa la válida', async () => {
  const p = gatedServer();
  expect(await get(p, '/x', 'abc', `${PREVIEW_COOKIE}=basura; ${PREVIEW_COOKIE}=${tokenFor('abc')}`)).toContain('V:/x');
});

test('L4: el token no llega a vite; las demás cookies sí', async () => {
  let seen = '';
  const vite = track(createServer((sock) => sock.on('data', (c: Buffer) => {
    seen += c.toString('latin1');
    if (!seen.includes('\r\n\r\n')) return;
    sock.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'); sock.end();
  })).listen(0, '127.0.0.1'));
  const pool = { live: () => ({ port: addr(vite), url: '', localUrl: '' }) } as unknown as PreviewPool;
  const resolve: PreviewResolve = { dirFor: () => '/ws/abc', distFor: () => undefined, ready: () => true };
  const p = addr(track(startPreviewServer(pool, resolve, 0, '127.0.0.1', undefined, undefined, gate)));
  const t = tokenFor('abc');
  await get(p, '/', 'abc', `a=1; ${PREVIEW_COOKIE}=${t}; b=2`);
  expect(seen).not.toContain(t);
  expect(seen).toMatch(/\r\ncookie: a=1; b=2\r\n/i);
});

const HOUR = 3_600_000;
const SKEW = 5 * 60_000;
test('exp = siguiente límite de hora + 1 h menos la holgura: igual en toda la hora y bajo las 2 h', () => {
  const h = 500_000 * HOUR;
  expect(previewTokenExp(h)).toBe(h + 2 * HOUR - SKEW);
  expect(previewTokenExp(h + HOUR - 1)).toBe(h + 2 * HOUR - SKEW); // 10:59:59.999 → 12:00 − holgura, no 11:00
  expect(previewTokenExp(h + HOUR)).toBe(h + 3 * HOUR - SKEW);
  expect(previewTokenExp(h) - h).toBeLessThan(2 * HOUR); // nunca toca el tope, aunque la VM esté unos segundos atrás
});

test('el latido emite previewToken solo con secreto y para un ws del dueño; la url sigue sin token', () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-hb-'));
  const previews = { see: () => {}, live: () => undefined, ensure: async () => undefined } as unknown as PreviewPool;
  const base = { previews, previewOrigin: 'http://localhost:5301', wsDir: () => root, hasWs: () => true, now: () => NOW };
  const owns = (ws: string, owner: string): boolean => ws === 'abc' && owner === 'a';
  const on = new PreviewDist({ ...base, previewSecret: SECRET, ownsWs: owns });
  const s = on.heartbeat({ visible: ['abc', 'otro'] }, 'a').states;
  expect(s.abc!.url).toBe('http://abc.localhost:5301/');
  expect(verifyPreviewToken(s.abc!.previewToken ?? '', SECRET, 'abc', NOW)).toEqual({ ok: true, owner: 'a', exp: previewTokenExp(NOW) });
  expect(s.otro!.previewToken).toBeUndefined(); // ws de otro dueño
  expect(on.heartbeat({ visible: ['abc'] }).states.abc!.previewToken).toBeUndefined(); // sin dueño
  expect(new PreviewDist({ ...base, previewSecret: SECRET }).heartbeat({ visible: ['abc'] }, 'a').states.abc!.previewToken).toBeUndefined(); // antes de la fase 2
  expect(new PreviewDist({ ...base, ownsWs: owns }).heartbeat({ visible: ['abc'] }, 'a').states.abc!.previewToken).toBeUndefined(); // gate apagado
  expect(on.gate()?.secret).toBe(SECRET);
  expect(new PreviewDist(base).gate()).toBeUndefined();
});
