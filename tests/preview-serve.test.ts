import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreviewPool } from '../src/runtime/preview';
import { distFile, hostWsMatcher, startPreviewServer, takeRequest, type PreviewResolve } from '../src/runtime/preview-serve';

const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });
function track<T extends Server>(s: T): T { servers.push(s); return s; }
function addr(s: Server): number { return (s.address() as { port: number }).port; }

// Un "vite" falso en TCP crudo: eco del path pedido (prefijado por `label`), y upgrade WS con handshake + frame de texto.
function fakeVite(label: string): Server {
  const srv = createServer((sock) => {
    let b = '';
    sock.on('data', (c: Buffer) => {
      b += c.toString('latin1');
      const end = b.indexOf('\r\n\r\n');
      if (end < 0) return;
      const path = (b.split('\r\n')[0] ?? '').split(' ')[1] ?? '';
      if (/upgrade:\s*websocket/i.test(b)) {
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        const f = Buffer.from('hi'); sock.write(Buffer.concat([Buffer.from([0x81, f.length]), f]));
      } else {
        const body = `${label}:${path}`;
        sock.write(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
        sock.end();
        b = '';
      }
    });
  });
  return track(srv.listen(0, '127.0.0.1'));
}

// Un vite que responde con un cuerpo de `size` bytes en una sola escritura (cabeceras + cuerpo juntos).
function bigVite(size: number): Server {
  const body = 'a'.repeat(size);
  const srv = createServer((sock) => sock.on('data', (c: Buffer) => {
    if (!c.toString().includes('\r\n\r\n')) return;
    sock.write(`HTTP/1.1 200 OK\r\ncontent-type: text/javascript\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    sock.end();
  }));
  return track(srv.listen(0, '127.0.0.1'));
}

function resolve(dir: string | undefined, dist?: string, ready = true): PreviewResolve {
  return { dirFor: () => dir, distFor: () => dist, ready: () => ready };
}

// Un pool sin vite vivo, con see/ensure no-op: el camino de placeholder los llama (R5.4, ensure bajo demanda).
const idlePool = (): PreviewPool => ({ live: () => undefined, see: () => {}, ensure: async () => undefined }) as unknown as PreviewPool;

// Lee una respuesta HTTP completa de un socket (por Content-Length), dejando el resto para la siguiente.
function readResponse(sock: import('node:net').Socket, carry: { buf: string }): Promise<string> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timeout')), 3000);
    const tryParse = (): boolean => {
      const end = carry.buf.indexOf('\r\n\r\n');
      if (end < 0) return false;
      const len = Number(/content-length:\s*(\d+)/i.exec(carry.buf.slice(0, end))?.[1] ?? '0');
      if (carry.buf.length < end + 4 + len) return false;
      const resp = carry.buf.slice(0, end + 4 + len);
      carry.buf = carry.buf.slice(end + 4 + len);
      clearTimeout(timer); sock.off('data', onData); res(resp);
      return true;
    };
    const onData = (c: Buffer): void => { carry.buf += c.toString('latin1'); tryParse(); };
    if (!tryParse()) sock.on('data', onData);
  });
}

// Envía una petición cruda por un socket nuevo y devuelve la respuesta (por Content-Length; las de error van con len 0).
function rawRequest(port: number, raw: string): Promise<string> {
  return new Promise((res, rej) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(raw));
    const carry = { buf: '' };
    readResponse(sock, carry).then((r) => { sock.destroy(); res(r); }).catch(rej);
  });
}

// R5.5: el origen es por ws (`<ws>.localhost:<port>`). Un Host ajeno (sin ese shape) → 421; un ws fuera del índice → 404.
test('Host ajeno da 421 y un ws sin workspace da 404; el listener no expone la API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-ps-'));
  const pool = { live: () => undefined } as unknown as PreviewPool;
  // dirFor resuelve solo 'abc'; cualquier otro ws no tiene workspace.
  const res: PreviewResolve = { dirFor: (ws) => (ws === 'abc' ? dir : undefined), distFor: () => undefined, ready: () => false };
  const p = addr(track(startPreviewServer(pool, res, 0)));
  expect(await rawRequest(p, 'GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n')).toContain('421'); // sin shape de preview
  expect(await rawRequest(p, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\n\r\n`)).toContain('421'); // sin subdominio
  expect(await rawRequest(p, `GET / HTTP/1.1\r\nHost: otro.localhost:${p}\r\n\r\n`)).toContain('404'); // ws fuera del índice
  expect((await fetch(`http://127.0.0.1:${p}/preview/abc/`)).status).toBe(421); // fetch manda Host 127.0.0.1: no es preview
});

test('con vite vivo, rutea al vite del ws conservando el path (servido en la raíz)', async () => {
  const vite = fakeVite('V');
  const pool = { live: () => ({ port: addr(vite), url: '', localUrl: '' }) } as unknown as PreviewPool;
  const p = addr(track(startPreviewServer(pool, resolve('/any'), 0)));
  expect(await rawRequest(p, `GET /assets/x.js HTTP/1.1\r\nHost: abc.localhost:${p}\r\n\r\n`)).toMatch(/V:\/assets\/x\.js$/);
});

// R5.5: dos ws por el MISMO puerto con Hosts distintos, cada uno a su vite (antes era el riesgo del keep-alive por ruta).
test('dos ws por el mismo socket con Hosts distintos van cada uno a su vite', async () => {
  const viteA = fakeVite('A'); const viteB = fakeVite('B');
  const pool = { live: (dir: string) => ({ port: addr(dir.endsWith('A') ? viteA : viteB), url: '', localUrl: '' }) } as unknown as PreviewPool;
  const resolveAB: PreviewResolve = { dirFor: (ws) => `/ws/${ws.toUpperCase()}`, distFor: () => undefined, ready: () => false };
  const p = addr(track(startPreviewServer(pool, resolveAB, 0)));
  const sock = connect(p, '127.0.0.1');
  const carry = { buf: '' };
  await new Promise<void>((r) => sock.on('connect', () => r()));
  sock.write(`GET / HTTP/1.1\r\nHost: a.localhost:${p}\r\nConnection: keep-alive\r\n\r\n`);
  const r1 = await readResponse(sock, carry);
  sock.write(`GET / HTTP/1.1\r\nHost: b.localhost:${p}\r\nConnection: keep-alive\r\n\r\n`);
  const r2 = await readResponse(sock, carry);
  sock.destroy();
  expect(r1.endsWith('A:/')).toBe(true);
  expect(r2.endsWith('B:/')).toBe(true);
});

test('el upgrade de HMR se proxya a vite (101 y frame del upstream llegan al cliente)', async () => {
  const vite = fakeVite('V');
  const pool = { live: () => ({ port: addr(vite), url: '', localUrl: '' }) } as unknown as PreviewPool;
  const p = addr(track(startPreviewServer(pool, resolve('/any'), 0)));
  const raw = await new Promise<string>((res, rej) => {
    const sock = connect(p, '127.0.0.1', () => sock.write(`GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    let buf = '';
    // Se espera el frame entero (0x81, largo 2, 'hi'): "Switching" del 101 ya contiene 'hi', y bajo carga el 101 llega en
    // un chunk aparte y resolvía antes del frame (QA, suite completa sobre af9fe60a).
    sock.on('data', (c: Buffer) => { buf += c.toString('binary'); if (buf.includes('\x81\x02hi')) { res(buf); sock.destroy(); } });
    sock.on('error', rej);
    setTimeout(() => rej(new Error('timeout')), 3000);
  });
  expect(raw).toContain('101 Switching Protocols');
  expect(raw.endsWith('hi')).toBe(true);
});

// La causa del preview en blanco del banco: el primer chunk de vite trae cabeceras + >64 KB de cuerpo (@vite/client).
test('una respuesta de upstream >64KB en un solo write pasa entera (M3 no corta el cuerpo)', async () => {
  const size = 100 * 1024;
  const pool = { live: () => ({ port: addr(bigVite(size)), url: '', localUrl: '' }) } as unknown as PreviewPool;
  const p = addr(track(startPreviewServer(pool, resolve('/any'), 0)));
  const got = await rawRequest(p, `GET /@vite/client HTTP/1.1\r\nHost: abc.localhost:${p}\r\n\r\n`);
  const e = got.indexOf('\r\n\r\n');
  expect(got.length - e - 4).toBe(size);
});

test('distFile sirve index.html en la raíz y bloquea traversal', () => {
  const dist = mkdtempSync(join(tmpdir(), 'wt-dist-'));
  writeFileSync(join(dist, 'index.html'), 'ROOT');
  mkdirSync(join(dist, 'assets')); writeFileSync(join(dist, 'assets', 'app.js'), 'JS');
  expect(distFile(dist, '/')).toBe(join(dist, 'index.html'));
  expect(distFile(dist, '/assets/app.js')).toBe(join(dist, 'assets', 'app.js'));
  expect(distFile(dist, '/nope.js')).toBe(join(dist, 'index.html')); // SPA fallback
  expect(distFile(dist, '/../../../../etc/passwd')).toBe('forbidden');
  expect(distFile('/does/not/exist', '/')).toBeUndefined();
});

// security-reviewer M1: un symlink dentro de dist que apunta fuera NO se sirve (realpath, no solo string).
test('distFile no sirve un symlink que escapa de dist', () => {
  const dist = mkdtempSync(join(tmpdir(), 'wt-sym-'));
  writeFileSync(join(dist, 'index.html'), 'ROOT');
  symlinkSync('/etc/hosts', join(dist, 'leak.txt'));
  expect(distFile(dist, '/leak.txt')).toBe('forbidden');
});

// security-reviewer H1: un Host inválido NO tumba el proceso; da 421 y el listener sigue sirviendo la siguiente.
test('un Host inválido da 421 y el proceso sigue vivo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-h1-'));
  const p = addr(track(startPreviewServer(idlePool(), resolve(dir), 0)));
  expect(await rawRequest(p, 'GET / HTTP/1.1\r\nHost: %E0%A4%A.localhost\r\n\r\n')).toContain('421');
  expect(await rawRequest(p, `GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\n\r\n`)).toContain('200'); // sigue arriba
});

// R5.4 / ADR §3.4: "Play" abre la url estable sin pasar por el latido. Un GET a un ws válido sin vite ni dist arranca vite
// (ensure) en vez de quedar en blanco para siempre.
test('un GET sin vite a un ws válido dispara el ensure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-ens-'));
  const ensured: string[] = []; const seen: string[] = [];
  const pool = { live: () => undefined, see: (d: string) => seen.push(d), ensure: async (d: string) => { ensured.push(d); return undefined; } } as unknown as PreviewPool;
  const p = addr(track(startPreviewServer(pool, resolve(dir), 0)));
  await rawRequest(p, `GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\n\r\n`);
  expect(ensured).toContain(dir);
  expect(seen).toContain(dir);
});

// security-reviewer M1: un ws a medio install NO arranca vite (R1.3 prohíbe `bunx vite` antes de terminar el install).
test('un ws no instalado sirve el placeholder sin arrancar vite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-m1-'));
  const ensured: string[] = [];
  const pool = { live: () => undefined, see: () => {}, ensure: async (d: string) => { ensured.push(d); return undefined; } } as unknown as PreviewPool;
  const p = addr(track(startPreviewServer(pool, resolve(dir, undefined, false), 0))); // ready=false
  const got = await rawRequest(p, `GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\n\r\n`);
  expect(got).toContain('http-equiv="refresh"'); // placeholder
  expect(ensured).toEqual([]); // no arrancó vite
});

// Bench robustez (133b918b, 0158db20): la marca deja el logo en public/brand/logo.<ext> y la página lo pide ABSOLUTO desde la
// raíz (brand.ts:55,81-82; la sección escribe src="/brand/logo.svg"). Con la url bajo /preview/<ws>/ esa ruta caía en la raíz
// del listener y daba 404; con un origen por ws la raíz ES la del ws y el asset sale de su dist, sin reescribir el código.
test('un asset de public/ pedido en absoluto (/brand/logo.svg) se sirve del dist del ws en su propio origen', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'wt-logo-'));
  mkdirSync(join(dist, 'brand'));
  writeFileSync(join(dist, 'index.html'), 'ROOT');
  writeFileSync(join(dist, 'brand', 'logo.svg'), '<svg id="logo"/>');
  const p = addr(track(startPreviewServer(idlePool(), resolve('/any', dist), 0)));
  const got = await rawRequest(p, `GET /brand/logo.svg HTTP/1.1\r\nHost: abc.localhost:${p}\r\n\r\n`);
  expect(got).toContain('200 OK');
  expect(got).toContain('content-type: image/svg+xml');
  expect(got.endsWith('<svg id="logo"/>')).toBe(true);
});

// El placeholder se reintenta solo hasta tener contenido (meta refresh), si no "Play" quedaría en blanco para siempre.
test('el placeholder sin vite lleva el reintento', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-ph-'));
  const p = addr(track(startPreviewServer(idlePool(), resolve(dir), 0)));
  const got = await rawRequest(p, `GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\n\r\n`);
  expect(got).toContain('http-equiv="refresh"');
});

// security-reviewer L1: 421/404 cierran la conexión (si no, MAX_CONNS 64 se agota con Hosts distintos en keep-alive).
test('tras 421 el listener cierra la conexión', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-l1close-'));
  const p = addr(track(startPreviewServer(idlePool(), resolve(dir), 0)));
  const closedWith421 = await new Promise<boolean>((res, rej) => {
    const sock = connect(p, '127.0.0.1', () => sock.write('GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: keep-alive\r\n\r\n'));
    let got = '';
    sock.on('data', (c: Buffer) => { got += c.toString('latin1'); });
    sock.on('close', () => res(got.includes('421')));
    sock.on('error', () => res(got.includes('421')));
    setTimeout(() => rej(new Error('no cerró')), 3000);
  });
  expect(closedWith421).toBe(true);
});

// security-reviewer M3: cabeceras que pasan del tope se rechazan con 431 (solo cabeceras, no el cuerpo — ver test >64KB).
test('cabeceras por encima del tope se rechazan con 431', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-m3-'));
  const pool = { live: () => undefined } as unknown as PreviewPool;
  const p = addr(track(startPreviewServer(pool, resolve(dir), 0)));
  const huge = `GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\nX-Big: ${'a'.repeat(70 * 1024)}`; // sin terminador
  expect(await rawRequest(p, huge)).toContain('431');
});

// Arq sobre 95db283: cabeceras completas (con terminador) pero >64 KB en el mismo chunk también topan: cliente → 431.
test('cabeceras completas pero enormes se rechazan con 431', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-m3b-'));
  const pool = { live: () => undefined } as unknown as PreviewPool;
  const p = addr(track(startPreviewServer(pool, resolve(dir), 0)));
  const huge = `GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\nX-Big: ${'a'.repeat(70 * 1024)}\r\n\r\n`; // CON terminador
  expect(await rawRequest(p, huge)).toContain('431');
});

// Arq sobre 95db283: si vite manda cabeceras completas pero enormes, el proxy cierra sin servir una respuesta válida.
test('cabeceras de upstream completas pero enormes cierran la conexión', async () => {
  const bigHeaderVite = track(createServer((sock) => sock.on('data', (c: Buffer) => {
    if (!c.toString().includes('\r\n\r\n')) return;
    sock.write(`HTTP/1.1 200 OK\r\nx-big: ${'a'.repeat(70 * 1024)}\r\ncontent-length: 2\r\n\r\nok`);
  })).listen(0, '127.0.0.1'));
  const pool = { live: () => ({ port: addr(bigHeaderVite), url: '', localUrl: '' }) } as unknown as PreviewPool;
  const p = addr(track(startPreviewServer(pool, resolve('/any'), 0)));
  const got = await new Promise<string>((res, rej) => {
    const sock = connect(p, '127.0.0.1', () => sock.write(`GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\n\r\n`));
    let buf = '';
    sock.on('data', (c: Buffer) => { buf += c.toString('latin1'); });
    sock.on('close', () => res(buf));
    sock.on('error', () => res(buf));
    setTimeout(() => rej(new Error('timeout')), 3000);
  });
  expect(got).not.toContain('200 OK'); // nunca se escribió la respuesta: se cerró antes
});

// security-reviewer L1: Transfer-Encoding y Content-Length inválido en la petición → 400.
test('takeRequest rechaza Transfer-Encoding y Content-Length inválido con 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-l1-'));
  const pool = { live: () => undefined } as unknown as PreviewPool;
  const p = addr(track(startPreviewServer(pool, resolve(dir), 0)));
  expect(await rawRequest(p, `POST / HTTP/1.1\r\nHost: abc.localhost:${p}\r\nTransfer-Encoding: chunked\r\n\r\n`)).toContain('400');
  expect(await rawRequest(p, `POST / HTTP/1.1\r\nHost: abc.localhost:${p}\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n`)).toContain('400');
  expect(takeRequest(Buffer.from('POST / HTTP/1.1\r\nHost: h\r\nContent-Length: abc\r\n\r\n'))).toBe('bad');
});

test('hostWsMatcher exige <ws>.<baseHost> exacto y sigue el host de previewOrigin, y takeRequest', () => {
  const m = hostWsMatcher('localhost:5391');
  expect(m('chat123.localhost:5391')).toBe('chat123');
  expect(m('CHAT123.localhost:5391')).toBe('chat123'); // el Host llega en minúsculas
  expect(m('chat123.localhost:9999')).toBeUndefined(); // puerto ajeno
  expect(m('chat123.example.com:5391')).toBeUndefined(); // dominio ajeno
  expect(m('localhost:5391')).toBeUndefined(); // sin subdominio
  // Sigue el host de previewOrigin (bloqueante Arq): un origin de dominio acepta su subdominio, no localhost.
  const d = hostWsMatcher('preview.x.dev');
  expect(d('abc.preview.x.dev')).toBe('abc');
  expect(d('abc.localhost:5391')).toBeUndefined();
  // Etiqueta DNS (RFC 1035): sin guion bajo, hasta 63.
  expect(m('a_b.localhost:5391')).toBeUndefined();
  expect(m(`${'a'.repeat(64)}.localhost:5391`)).toBeUndefined();
  expect(m(`${'a'.repeat(63)}.localhost:5391`)).toBe('a'.repeat(63));
  const t = takeRequest(Buffer.from('GET /x HTTP/1.1\r\nHost: abc.localhost:5391\r\n\r\nLEFTOVER'));
  expect(t && t !== 'bad' && t !== 'too-large' ? t.req.host : null).toBe('abc.localhost:5391');
  expect(t && t !== 'bad' && t !== 'too-large' ? t.rest.toString() : null).toBe('LEFTOVER');
  expect(takeRequest(Buffer.from('GET / HTTP/1.1\r\nHost: h\r\n'))).toBeUndefined(); // cabeceras incompletas
});

// H4: solo el builder enmarca el preview. La cabecera va en el placeholder, en el dist y en lo que sirve vite, y no se
// manda sin origen del builder (frame-ancestors 'self' a secas dejaría al builder sin preview).
test('las respuestas del preview llevan frame-ancestors del builder y nada sin builder', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'wt-ps-csp-'));
  writeFileSync(join(dist, 'index.html'), '<h1>ok</h1>');
  const csp = "content-security-policy: frame-ancestors 'self' http://localhost:5173 http://127.0.0.1:5173";
  const get = (p: number) => rawRequest(p, `GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\n\r\n`);
  const builder = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  expect(await get(addr(track(startPreviewServer(idlePool(), resolve('/any'), 0, '127.0.0.1', undefined, builder))))).toContain(csp);
  expect(await get(addr(track(startPreviewServer(idlePool(), resolve('/any', dist), 0, '127.0.0.1', undefined, builder))))).toContain(csp);
  const vite = { live: () => ({ port: addr(fakeVite('V')), url: '', localUrl: '' }) } as unknown as PreviewPool;
  expect(await get(addr(track(startPreviewServer(vite, resolve('/any'), 0, '127.0.0.1', undefined, builder))))).toContain(csp);
  expect((await get(addr(track(startPreviewServer(idlePool(), resolve('/any', dist), 0))))).toLowerCase()).not.toContain('content-security-policy');
});
