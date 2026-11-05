import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreviewPool, serverErrorLine } from '../src/runtime/preview';

// security-reviewer E3: el GET del hilo con el doble montaje de StrictMode pedía dos previews a la vez del mismo workspace.
test('dos ensure() simultáneos del mismo workspace arrancan un solo server y devuelven la misma url', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-pool-'));
  const server = join(dir, 'fake-vite.js');
  writeFileSync(server, [
    "const fs = require('fs'); const http = require('http');",
    "fs.appendFileSync(require('path').join(process.cwd(), 'starts.log'), 'start\\n');",
    "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
    "http.createServer((_q, r) => r.end('ok')).listen(port, '127.0.0.1');",
  ].join('\n'));
  const pool = new PreviewPool(5420, 10_000, {}, [process.execPath, server]);
  try {
    const [a, b] = await Promise.all([pool.ensure(dir), pool.ensure(dir)]);
    expect(a.url).toBe(b.url);
    expect(readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    pool.stopAll();
  }
});

// security-reviewer E3: cada GET /chats levantaba un vite sin tope.
test('con el tope lleno se apaga el preview usado hace más tiempo, salvo el de un workspace con corrida en curso', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-cap-'));
  const server = join(root, 'fake-vite.js');
  writeFileSync(server, "require('http').createServer((_q, r) => r.end('ok')).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');");
  const ws = (n: string) => { const d = join(root, n); mkdirSync(d); return d; };
  const [a, b, c] = [ws('a'), ws('b'), ws('c')];
  const pool = new PreviewPool(5430, 10_000, {}, [process.execPath, server], 2);
  const up = async (url: string) => fetch(url).then((r) => r.ok, () => false);
  try {
    const pa = await pool.ensure(a);
    const pb = await pool.ensure(b);
    pool.protect = (d) => d === a;
    await pool.ensure(c);
    await new Promise((r) => setTimeout(r, 300));
    expect(await up(pa.url)).toBe(true);
    expect(await up(pb.url)).toBe(false);
  } finally {
    pool.stopAll();
  }
});

test('la terminal de vite: cuenta los errores del server y no lo que reenvía del navegador ni los frames', () => {
  expect(serverErrorLine('\x1b[31m[vite] Internal server error: Transform failed\x1b[39m')).toBe('[vite] Internal server error: Transform failed');
  // live3/live4: un error no capturado del navegador durante el HMR del turno; lo cuenta el sensor del navegador.
  expect(serverErrorLine("[vite] (client) [Unhandled error] TypeError: Cannot read properties of null (reading 'useState')")).toBeUndefined();
  expect(serverErrorLine('[vite] (client) [console.error] x')).toBeUndefined();
  expect(serverErrorLine('    at error-overlay.mjs:12:3')).toBeUndefined();
  expect(serverErrorLine('[vite] hmr update /src/App.tsx')).toBeUndefined();
});

// S0: el arnés cruza las recargas del preview con el log del turno; sin archivo, la terminal de vite se perdía.
test('con logDir, cada línea de la terminal de vite queda con su hora en <logDir>/<workspace>.vite.log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-vlog-'));
  const dir = join(root, 'ws1');
  mkdirSync(dir);
  const logDir = join(root, 'logs');
  mkdirSync(logDir);
  const server = join(root, 'fake-vite.js');
  writeFileSync(server, [
    "console.log('[vite] page reload index.html');",
    "require('http').createServer((_q, r) => r.end('ok')).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');",
  ].join('\n'));
  const pool = new PreviewPool(5440, 10_000, {}, [process.execPath, server]);
  pool.logDir = logDir;
  try {
    await pool.ensure(dir);
    await new Promise((r) => setTimeout(r, 200));
    const lines = readFileSync(join(logDir, 'ws1.vite.log'), 'utf8').trim().split('\n');
    expect(lines.some((l) => /^\d{4}-\d{2}-\d{2}T\S+Z \[vite\] page reload index\.html$/.test(l))).toBe(true);
  } finally {
    pool.stopAll();
  }
});
