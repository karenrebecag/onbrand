import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect, createServer as netCreateServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAll, initRepo, restoreTree } from '../src/runtime/git-workspace';
import type { PreviewPool } from '../src/runtime/preview';
import { Runtime, type Composer } from '../src/runtime/server';
import type { Allowlist } from '../src/runtime/runner';

const allow: Allowlist = {};

let tmp: string;
let server: Server;
let base: string;
let root: string;
let seen: string[];
let ensured: string[];
let liveDirs: Set<string>;
let shas: Record<string, string>;

const wsDir = (ws: string): string => join(root, 'ws', ws);

// Un workspace sembrado: repo con un commit, instalado salvo que se pida lo contrario, con dist si se pide.
function makeWs(ws: string, opts: { installed?: boolean; dist?: boolean } = {}): string {
  const dir = wsDir(ws);
  mkdirSync(dir, { recursive: true });
  initRepo(dir);
  writeFileSync(join(dir, 'page.json'), '{}');
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
  const commit = commitAll(dir, ws);
  if (opts.installed !== false) { mkdirSync(join(dir, 'node_modules'), { recursive: true }); writeFileSync(join(dir, 'node_modules', '.wt-installed'), ''); }
  if (opts.dist) { const d = join(dir, '.wt', 'dist', commit); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'index.html'), 'DIST'); writeFileSync(join(d, '.base'), '/'); } // .base = snapshot de R5.5 (raíz)
  return commit;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'wt-hb-'));
  root = join(tmp, 'state');
  mkdirSync(root, { recursive: true });
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  seen = []; ensured = []; liveDirs = new Set();
  // Los workspaces y su entrada en el índice (isValidWs exige que el ws exista en el índice).
  shas = { live1: makeWs('live1'), dist1: makeWs('dist1', { dist: true }), absent1: makeWs('absent1'), prep1: makeWs('prep1', { installed: false }) };
  writeFileSync(join(root, 'index.json'), JSON.stringify(Object.fromEntries(Object.keys(shas).map((ws) => [ws, { ws }]))));
  const pool = {
    see: (d: string) => seen.push(d),
    live: (d: string) => (liveDirs.has(d) ? { port: 1, url: '', localUrl: '' } : undefined),
    ensure: async (d: string) => { ensured.push(d); return { port: 1, url: '', localUrl: '' }; },
  } as unknown as PreviewPool;
  const compose: Composer = async () => ({ sections: [] });
  const t = new Runtime({ root, allow, compose, build: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), previews: pool, previewPort: 0, previewOrigin: 'http://preview.test' });
  server = t.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });

const heartbeat = async (visible: string[]): Promise<Record<string, { status: string; version: string | null; url: string }>> =>
  (await (await fetch(`${base}/preview/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visible }) })).json()).states;

// R5.2: el latido devuelve el estado servible de cada ws visible, con la url estable.
test('el latido clasifica cada ws: live, dist, absent (instalando) y desconocido', async () => {
  liveDirs.add(wsDir('live1'));
  const states = await heartbeat(['live1', 'dist1', 'absent1', 'prep1']); // 4 = MAX_LIVE, el tope no recorta
  expect(states.live1).toEqual({ status: 'live', version: shas.live1!, url: 'http://live1.preview.test/' });
  expect(states.dist1).toEqual({ status: 'dist', version: shas.dist1!, url: 'http://dist1.preview.test/' });
  expect(states.absent1!.status).toBe('absent');
  // Instalando: 'absent' (no 'preparing'): el cliente R4.6 solo conoce live|dist|absent y descarta otros status.
  expect(states.prep1!.status).toBe('absent');
  // Un ws que no está en el índice: absent con version null (no resuelve a ningún workspace).
  const gone = await heartbeat(['desconocido']);
  expect(gone.desconocido).toEqual({ status: 'absent', version: null, url: 'http://desconocido.preview.test/' });
});

// R5.2 / R1.3: arranca vite solo de lo instalado y no vivo; nunca el que está en install ni el que ya vive.
test('el latido marca lo visible y arranca vite solo de lo instalado y no vivo', async () => {
  liveDirs.add(wsDir('live1'));
  await heartbeat(['live1', 'absent1', 'prep1']);
  expect(seen).toContain(wsDir('live1'));
  expect(seen).toContain(wsDir('absent1'));
  expect(ensured).toContain(wsDir('absent1'));
  expect(ensured).not.toContain(wsDir('live1')); // ya vive
  expect(ensured).not.toContain(wsDir('prep1')); // sin instalar
});

// SEGURIDAD (Arq R5): un ws con traversal no resuelve a ningún directorio ni arranca vite.
test('el latido rechaza ws con traversal y no arranca nada', async () => {
  const states = await heartbeat(['..', '%2e%2e', '../../etc', 'live1/../..', 'desconocido123']);
  for (const ws of Object.keys(states)) expect(states[ws]!.status).toBe('absent');
  expect(ensured).toEqual([]); // ningún spawn
  expect(seen).toEqual([]); // no se marca visible un ws inválido
});

// Tope a lo visible (Arq R5): a lo sumo MAX_LIVE entradas, para que la página no pida arrancar N vites.
test('el latido topa la lista de visibles a MAX_LIVE', async () => {
  const many = Array.from({ length: 12 }, (_, i) => `ws${i}`);
  const states = await heartbeat(many);
  expect(Object.keys(states).length).toBeLessThanOrEqual(4);
});

// Sin previewPort no hay listener ni url estable: el latido responde 404 para que el builder (R4.6) lo apague.
test('sin previewPort, POST /preview/heartbeat da 404', async () => {
  const t2 = new Runtime({ root: join(tmp, 'state2'), allow, compose: async () => ({ sections: [] }), build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault') });
  const s2 = t2.listen(0);
  await new Promise((r) => s2.once('listening', r));
  const b2 = `http://127.0.0.1:${(s2.address() as { port: number }).port}`;
  expect((await fetch(`${b2}/preview/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"visible":["x"]}' })).status).toBe(404);
  s2.close();
});

// Bloqueante Arq (opción b): el listener acepta exactamente el Host que arma stableUrl (derivado de previewOrigin) y
// rechaza un puerto o host ajeno. Antes el matcher usaba localhost:previewPort hardcodeado y stableUrl el host de
// previewOrigin: con un origin distinto daba 421 siempre.
test('el listener acepta el Host de stableUrl y rechaza puerto/host ajeno', async () => {
  const freePort = await new Promise<number>((res) => { const s = netCreateServer(); s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => res(port)); }); });
  const pool = { live: () => undefined, see: () => {}, ensure: async () => undefined } as unknown as PreviewPool;
  const t = new Runtime({ root, allow, compose: async () => ({ sections: [] }), build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), previews: pool, previewPort: freePort });
  const s = t.listen(0);
  await new Promise((r) => s.once('listening', r));
  const raw = (host: string): Promise<string> => new Promise((res, rej) => {
    const sock = connect(freePort, '127.0.0.1', () => sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`));
    let buf = ''; sock.on('data', (c: Buffer) => { buf += c.toString('latin1'); if (buf.includes('\r\n\r\n')) { sock.destroy(); res(buf); } });
    sock.on('error', () => res(buf)); setTimeout(() => rej(new Error('timeout')), 3000);
  });
  try {
    // stableUrl de live1 = http://live1.localhost:<freePort>/; ese Host rutea al ws (sin vite vivo → placeholder 200).
    expect(await raw(`live1.localhost:${freePort}`)).toContain('200');
    expect(await raw('live1.localhost:9999')).toContain('421'); // puerto ajeno
    expect(await raw(`nope.localhost:${freePort}`)).toContain('404'); // ws fuera del índice
  } finally {
    s.close();
  }
});

// Bloqueante Arq: un previewOrigin con IP se rechaza al arrancar (el subdominio por ws no funciona sobre una IP).
test('previewOrigin con IP falla al arrancar con error claro', async () => {
  const pool = { live: () => undefined, see: () => {}, ensure: async () => undefined } as unknown as PreviewPool;
  const mk = (origin: string) => new Runtime({ root: join(tmp, 'ipstate'), allow, compose: async () => ({ sections: [] }), build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), previews: pool, previewPort: 5599, previewOrigin: origin });
  expect(() => mk('http://127.0.0.1:5599').listen(0)).toThrow(/IP/);
  // IPv6: URL.hostname = "[::1]"; sin quitar los corchetes isIP no la reconoce y la IP pasaría.
  expect(() => mk('http://[::1]:5599').listen(0)).toThrow(/IP/);
});

// L-1: el latido reporta 'dist' por distFor (marcador `.base`), no por existsSync; un snapshot sin `.base` sale 'absent',
// así el estado coincide con lo que el listener sirve.
test('el latido reporta absent si el snapshot no tiene el marcador .base', async () => {
  rmSync(join(wsDir('dist1'), '.wt', 'dist', shas.dist1!, '.base'));
  const states = await heartbeat(['dist1']);
  expect(states.dist1!.status).toBe('absent');
});

// Nit Arq (distRootCache): servableDist cachea el veredicto por commit; sin invalidar en saveDist, un build nuevo del
// mismo commit seguiría sirviéndose como 'absent'. Con la invalidación, el snapshot recién grabado se sirve.
test('servableDist se recalcula tras saveDist: un snapshot nuevo del mismo commit se sirve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-cache-'));
  initRepo(dir);
  writeFileSync(join(dir, 'page.json'), '{}');
  const commit = commitAll(dir, 'v1');
  const t = new Runtime({ root: join(dir, 'state'), allow, compose: async () => ({ sections: [] }), build: false, scaffoldDir: join(dir, 'scaffold'), vaultRoot: join(dir, 'vault') });
  const inner = (t as unknown as { previewDist: { servableDist(d: string, c: string): string | undefined; saveDist(d: string, c: string): void } }).previewDist;
  expect(inner.servableDist(dir, commit)).toBeUndefined(); // aún sin dist → cachea false
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), 'OK');
  inner.saveDist(dir, commit); // graba `.base` e invalida la cache
  expect(inner.servableDist(dir, commit)).toBe(join(dir, '.wt', 'dist', commit));
  rmSync(dir, { recursive: true, force: true });
});

// L-4 (seguridad, reforzado tras Arq): servableDist se ancla al realpath del WS, no al de `.wt/dist`. Así ni
// `.wt/dist/<commit>`, ni `.wt/dist`, ni `.wt` symlinkeados a un dist ajeno (con `.base` válido) pasan: el chequeo viejo
// resolvía ambos lados por el mismo symlink y empataban. Y corre en cada request, así que un symlink puesto DESPUÉS del
// primer distFor tampoco se sirve por una cache vieja.
test('servableDist rechaza cualquier symlink a un dist ajeno y lo revalida en cada request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-l4-'));
  const t = new Runtime({ root: join(dir, 'state'), allow, compose: async () => ({ sections: [] }), build: false, scaffoldDir: join(dir, 'scaffold'), vaultRoot: join(dir, 'vault') });
  const inner = (t as unknown as { previewDist: { servableDist(d: string, c: string): string | undefined; saveDist(d: string, c: string): void } }).previewDist;
  const mkWs = (n: string): { ws: string; commit: string } => {
    const ws = join(dir, n); mkdirSync(ws, { recursive: true });
    initRepo(ws); writeFileSync(join(ws, 'page.json'), '{}');
    return { ws, commit: commitAll(ws, n) };
  };
  // Un dist cebo con `.base` válido bajo el commit de la víctima: el `.base` leído por el symlink pasa, el realpath no.
  const decoy = (commit: string): string => {
    const root = mkdtempSync(join(dir, 'decoy-'));
    const d = join(root, commit); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.base'), '/'); writeFileSync(join(d, 'index.html'), 'EVIL');
    return root;
  };

  // 1) `.wt/dist/<commit>` es el symlink.
  const a = mkWs('a'); mkdirSync(join(a.ws, '.wt', 'dist'), { recursive: true });
  symlinkSync(join(decoy(a.commit), a.commit), join(a.ws, '.wt', 'dist', a.commit));
  expect(readFileSync(join(a.ws, '.wt', 'dist', a.commit, '.base'), 'utf8')).toBe('/'); // el `.base` pasa por el symlink
  expect(inner.servableDist(a.ws, a.commit)).toBeUndefined();

  // 2) `.wt/dist` entero es el symlink (el chequeo viejo resolvía ambos lados por él y empataban).
  const b = mkWs('b'); mkdirSync(join(b.ws, '.wt'), { recursive: true });
  symlinkSync(decoy(b.commit), join(b.ws, '.wt', 'dist'));
  expect(inner.servableDist(b.ws, b.commit)).toBeUndefined();

  // 3) `.wt` entero es el symlink.
  const c = mkWs('c');
  const cRoot = mkdtempSync(join(dir, 'cdecoy-')); mkdirSync(join(cRoot, 'dist', c.commit), { recursive: true });
  writeFileSync(join(cRoot, 'dist', c.commit, '.base'), '/'); writeFileSync(join(cRoot, 'dist', c.commit, 'index.html'), 'EVIL');
  symlinkSync(cRoot, join(c.ws, '.wt'));
  expect(inner.servableDist(c.ws, c.commit)).toBeUndefined();

  // 4) Legítimo primero (se sirve y cachea el `.base`), luego symlink: la segunda consulta lo rechaza (realpath por request).
  const e = mkWs('e');
  mkdirSync(join(e.ws, 'dist'), { recursive: true }); writeFileSync(join(e.ws, 'dist', 'index.html'), 'OK'); inner.saveDist(e.ws, e.commit);
  expect(inner.servableDist(e.ws, e.commit)).toBe(join(e.ws, '.wt', 'dist', e.commit));
  rmSync(join(e.ws, '.wt', 'dist', e.commit), { recursive: true, force: true });
  symlinkSync(join(decoy(e.commit), e.commit), join(e.ws, '.wt', 'dist', e.commit));
  expect(inner.servableDist(e.ws, e.commit)).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

// R5.3 + R2.1 (Arq): el snapshot vive en .wt/dist/<commit>; restoreTree hace `git clean -e /.wt`, así que no lo borra.
test('el dist por versión sobrevive a restoreTree y a un build nuevo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-distkeep-'));
  initRepo(dir);
  writeFileSync(join(dir, 'a.txt'), '1');
  const c1 = commitAll(dir, 'v1');
  const snap = join(dir, '.wt', 'dist', c1);
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, 'index.html'), 'SNAP1');
  writeFileSync(join(dir, 'b.txt'), '2');
  commitAll(dir, 'v2');
  writeFileSync(join(dir, 'untracked.txt'), 'dirty');
  restoreTree(dir, c1);
  expect(existsSync(join(dir, 'untracked.txt'))).toBe(false); // el clean borra lo no versionado fuera de .wt
  expect(existsSync(join(snap, 'index.html'))).toBe(true); // .wt/dist/<commit> intacto
  rmSync(dir, { recursive: true, force: true });
});

// security-reviewer M1: saveDist no copia un symlink al snapshot servible (un `dist/leak -> /etc/hosts` que dejara el
// build no debe quedar bajo .wt/dist/<commit>, donde el proxy lo serviría).
test('saveDist excluye symlinks al guardar el dist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-savesym-'));
  initRepo(dir);
  writeFileSync(join(dir, 'page.json'), '{}');
  const commit = commitAll(dir, 'v1');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), 'OK');
  symlinkSync('/etc/hosts', join(dir, 'dist', 'leak.txt'));
  const t = new Runtime({ root: join(dir, 'state'), allow, compose: async () => ({ sections: [] }), build: false, scaffoldDir: join(dir, 'scaffold'), vaultRoot: join(dir, 'vault') });
  (t as unknown as { previewDist: { saveDist(d: string, c: string): void } }).previewDist.saveDist(dir, commit);
  const snap = join(dir, '.wt', 'dist', commit);
  expect(existsSync(join(snap, 'index.html'))).toBe(true); // el archivo real sí
  expect(existsSync(join(snap, 'leak.txt'))).toBe(false); // el symlink no
  rmSync(dir, { recursive: true, force: true });
});

// Arq R5: un snapshot que no se puede guardar (`.wt/dist` es un symlink) NO debe tumbar un run ya commiteado. saveDist
// lanza, pero trySaveDist lo traga y la versión queda completa sin dist (ADR 0013 §1: el snapshot es derivado).
test('trySaveDist no lanza aunque .wt/dist sea un symlink, y no deja snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-trysave-'));
  initRepo(dir);
  writeFileSync(join(dir, 'page.json'), '{}');
  const commit = commitAll(dir, 'v1');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), 'OK');
  mkdirSync(join(dir, '.wt'), { recursive: true });
  symlinkSync('/tmp', join(dir, '.wt', 'dist')); // .wt/dist apunta afuera
  const t = new Runtime({ root: join(dir, 'state'), allow, compose: async () => ({ sections: [] }), build: false, scaffoldDir: join(dir, 'scaffold'), vaultRoot: join(dir, 'vault') });
  const inner = (t as unknown as { previewDist: { saveDist(d: string, c: string): void; trySaveDist(d: string, c: string): void } }).previewDist;
  expect(() => inner.saveDist(dir, commit)).toThrow(); // saveDist sí lanza con el guard de M1
  expect(() => inner.trySaveDist(dir, commit)).not.toThrow(); // trySaveDist lo traga: el run sigue
  expect(existsSync(join('/tmp', commit))).toBe(false); // no escribió el snapshot a través del symlink
  rmSync(dir, { recursive: true, force: true });
});
