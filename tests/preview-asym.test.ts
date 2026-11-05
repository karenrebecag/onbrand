// Preview token asimétrico (deploy-sandbox.md §4): el orquestador firma Ed25519 (issuePreviewToken) y la VM verifica con
// la pública (verifyPreview), sin secreto HMAC en la VM. Cubre el gate real, el rechazo cruzado de modos, y typ identity.
import { afterAll, expect, test } from 'bun:test';
import { connect, createServer, type Server } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import type { PreviewPool } from '../src/runtime/preview';
import { PREVIEW_COOKIE, PREVIEW_TOKEN_PARAM, startPreviewServer, type PreviewGate, type PreviewResolve } from '../src/runtime/preview-serve';
import { previewTokenExp, signPreviewToken, verifyPreview, type PreviewKey } from '../src/runtime/preview-token';
import { sign } from '../src/signed-token';
import { issueIdentity, issuePreviewToken } from '../src/orchestrator/identity';

const keys = generateKeyPairSync('ed25519');
const PUB: PreviewKey = { mode: 'ed25519', publicKey: keys.publicKey };
const SECRET = Buffer.alloc(32, 7);
const HMAC: PreviewKey = { mode: 'hmac', secret: SECRET };
const NOW = 1_800_000_000_000;
const clock = () => NOW;
const issue = (ws = 'abc', owner = 'a') => issuePreviewToken(keys.privateKey, ws, owner, [], clock);

test('verifyPreview acepta un token Ed25519 recién firmado solo para su ws y antes de vencer', () => {
  const token = issue('abc');
  const ok = verifyPreview(token, PUB, 'abc', NOW);
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(ok.owner).toBe('a');
  expect(verifyPreview(token, PUB, 'otro', NOW)).toEqual({ ok: false, code: 'invalid' });
  if (ok.ok) expect(verifyPreview(token, PUB, 'abc', ok.exp + 1)).toEqual({ ok: false, code: 'expired' });
});

test('un token HMAC no vale en modo asimétrico y uno Ed25519 no vale en HMAC', () => {
  const hmacToken = signPreviewToken({ ws: 'abc', owner: 'a', exp: NOW + 60_000 }, SECRET);
  expect(verifyPreview(hmacToken, PUB, 'abc', NOW)).toEqual({ ok: false, code: 'invalid' });
  const edToken = issue('abc');
  expect(verifyPreview(edToken, HMAC, 'abc', NOW)).toEqual({ ok: false, code: 'invalid' });
});

test('un token de identidad (typ identity) no vale como preview aunque comparta par de llaves', () => {
  const identity = issueIdentity(keys.privateKey, { owner: 'user_1', scopes: new Set() }, 'abc', 60_000, clock);
  expect(verifyPreview(identity, PUB, 'abc', NOW)).toEqual({ ok: false, code: 'invalid' });
});

test('verifyPreview rechaza un preview firmado para el dueño local (como signedVerifier)', () => {
  // '' no se puede firmar (sign lo rechaza); 'local' sí, y es el caso bogus real bajo el orquestador.
  const token = sign(keys.privateKey, { typ: 'preview', owner: 'local', scopes: [], chat: 'abc', exp: previewTokenExp(NOW) });
  expect(verifyPreview(token, PUB, 'abc', NOW)).toEqual({ ok: false, code: 'invalid' });
});

test('previewTokenExp deja holgura bajo las 2 h: un token firmado en el límite de hora vale con la VM 1 min atrás', () => {
  // NOW cae en un límite de hora exacto; antes de la holgura exp era NOW+2h y la VM un poco atrás lo daba expired.
  const token = issue('abc');
  expect(previewTokenExp(NOW) - NOW).toBeLessThan(2 * 3_600_000);
  expect(verifyPreview(token, PUB, 'abc', NOW - 60_000).ok).toBe(true);
});

// --- Gate real: un net.createServer con el gate asimétrico canjea el token por cookie y deja pasar el HMR. ---

const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });
const track = (s: Server): Server => { servers.push(s); return s; };
const addr = (s: Server): number => (s.address() as { port: number }).port;

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

function gatedServer(gate: PreviewGate): number {
  const vite = fakeVite();
  const pool = { live: () => ({ port: addr(vite), url: '', localUrl: '' }) } as unknown as PreviewPool;
  const resolve: PreviewResolve = { dirFor: (ws) => (ws === 'abc' ? `/ws/${ws}` : undefined), distFor: () => undefined, ready: () => true };
  return addr(track(startPreviewServer(pool, resolve, 0, '127.0.0.1', undefined, undefined, gate)));
}

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
const get = (port: number, path: string, cookie?: string): Promise<string> =>
  raw(port, `GET ${path} HTTP/1.1\r\nHost: abc.localhost:${port}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);

const owns = (_ws: string, owner: string): boolean => owner === 'a';

test('gate asimétrico: sin token 401; el token en query se canjea por cookie (307) y con la cookie pasa a vite', async () => {
  const port = gatedServer({ publicKey: keys.publicKey, ownsWs: owns, now: clock });
  expect(await get(port, '/')).toMatch(/^HTTP\/1\.1 401/);
  const token = issue('abc');
  const exchanged = await get(port, `/?${PREVIEW_TOKEN_PARAM}=${token}`);
  expect(exchanged).toMatch(/^HTTP\/1\.1 307/);
  const cookie = /set-cookie:\s*wt_preview=([^;]+)/i.exec(exchanged)?.[1];
  expect(cookie).toBe(token);
  expect(await get(port, '/', `${PREVIEW_COOKIE}=${token}`)).toContain('V:');
});

test('gate asimétrico: un token Ed25519 válido pero para un owner que no es dueño del ws no pasa (ownsWs)', async () => {
  const port = gatedServer({ publicKey: keys.publicKey, ownsWs: owns, now: clock });
  const otherOwner = issue('abc', 'b'); // firma válida del orquestador, owner 'b' ≠ dueño 'a'
  expect(await get(port, `/?${PREVIEW_TOKEN_PARAM}=${otherOwner}`)).toMatch(/^HTTP\/1\.1 401/);
  expect(await get(port, '/', `${PREVIEW_COOKIE}=${otherOwner}`)).toMatch(/^HTTP\/1\.1 401/);
});

test('gate asimétrico: el upgrade de HMR pasa con la cookie del token Ed25519', async () => {
  const port = gatedServer({ publicKey: keys.publicKey, ownsWs: owns, now: clock });
  const token = issue('abc');
  const upgrade = `GET / HTTP/1.1\r\nHost: abc.localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${PREVIEW_COOKIE}=${token}\r\n\r\n`;
  expect(await raw(port, upgrade)).toMatch(/^HTTP\/1\.1 101/);
});

test('gate asimétrico: un token HMAC en la cookie no pasa (no es firma Ed25519)', async () => {
  const port = gatedServer({ publicKey: keys.publicKey, ownsWs: owns, now: clock });
  const hmacToken = signPreviewToken({ ws: 'abc', owner: 'a', exp: NOW + 60_000 }, SECRET);
  expect(await get(port, '/', `${PREVIEW_COOKIE}=${hmacToken}`)).toMatch(/^HTTP\/1\.1 401/);
});
