import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTrustedRequest, Runtime } from '../src/runtime/server';
import { parsePreviewUrls, PreviewPool } from '../src/runtime/preview';

const SECRET = 's'.repeat(40);
const trust = { secret: SECRET, origin: 'https://builder.example.com' };

// deploy-ec.md: detrás del rewrite /api el Host es el del Sandbox; pasa el secreto que pone Vercel, nunca un Host loopback.
test('con secreto, solo pasa el header correcto, y con Origin solo el del builder', () => {
  expect(isTrustedRequest({ host: 'sb-1.example.run', 'x-origin-secret': SECRET }, trust)).toBe(true);
  expect(isTrustedRequest({ host: 'sb-1.example.run', 'x-origin-secret': SECRET, origin: 'https://builder.example.com' }, trust)).toBe(true);
  // Un POST de otra web contra el builder también recibe el secreto del rewrite: lo frena el Origin.
  expect(isTrustedRequest({ host: 'sb-1.example.run', 'x-origin-secret': SECRET, origin: 'https://evil.example' }, trust)).toBe(false);
  expect(isTrustedRequest({ host: 'sb-1.example.run', 'x-origin-secret': 'otro' }, trust)).toBe(false);
  // No se sabe qué Host pone el proxy del Sandbox: un Host loopback sin secreto no basta.
  expect(isTrustedRequest({ host: '127.0.0.1:5300' }, trust)).toBe(false);
  // Sin secreto configurado, el comportamiento local de siempre.
  expect(isTrustedRequest({ host: '127.0.0.1:5300' })).toBe(true);
  expect(isTrustedRequest({ host: 'sb-1.example.run', 'x-origin-secret': SECRET })).toBe(false);
});

test('WT_PREVIEW_URLS: un puerto por url, con tope de 14 y formato estricto', () => {
  const net = parsePreviewUrls('5310=https://a.example.run,5311=https://b.example.run/');
  expect(net.ports).toEqual([5310, 5311]);
  expect(net.publicUrl!(5311)).toBe('https://b.example.run/');
  expect(() => parsePreviewUrls('5310=ftp://a')).toThrow('WT_PREVIEW_URLS inválido');
  expect(() => parsePreviewUrls(Array.from({ length: 15 }, (_, i) => `${5310 + i}=https://p${i}.run`).join(','))).toThrow('hasta 15 puertos');
});

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

// Un puerto fuera de los declarados al crear el Sandbox escucharía sin url pública: el pool no sale de la lista.
test('con puertos declarados, el preview usa uno de ellos, da su url pública y la local, y no inventa otro', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-sbx-pool-'));
  const server = join(dir, 'fake-vite.js');
  writeFileSync(server, "require('http').createServer((_q, r) => r.end('ok')).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');");
  const ws = (n: string) => { const d = join(dir, n); mkdirSync(d); return d; };
  const pool = new PreviewPool(5440, 10_000, {}, [process.execPath, server], 4, { ports: [5447], publicUrl: (p) => `https://p${p}.example.run/` });
  stop = () => pool.stopAll();
  const p = await pool.ensure(ws('a'));
  // vite sin --base (R5.5): sirve en la raíz; la url pública y la local quedan en la raíz del puerto.
  expect(p).toEqual({ url: 'https://p5447.example.run/', localUrl: 'http://127.0.0.1:5447/', port: 5447 });
  await expect(pool.ensure(ws('b'))).rejects.toThrow('no queda puerto de preview libre entre 5447');
});

let srv: Server | undefined;
afterEach(() => { srv?.close(); srv = undefined; });

const transportWith = async (extra: Partial<ConstructorParameters<typeof Runtime>[0]>) => {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-sbx-t-'));
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose: async () => ({ sections: [] }), build: false, scaffoldDir: tmp, vaultRoot: tmp, ...extra });
  srv = t.listen(0);
  await new Promise((r) => srv!.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { base, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
};

// QA (deploy-qa.md): interruptor de la demo pública, sin abrir ninguna corrida.
test('con runsDisabled, POST /runs responde 503 con un mensaje claro', async () => {
  const { base, cleanup } = await transportWith({ runsDisabled: true });
  const r = await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) });
  expect(r.status).toBe(503);
  expect(((await r.json()) as { error: string }).error).toContain('pausadas');
  cleanup();
});

// Con secreto, las llamadas del CLI al propio transport no llevan x-origin-secret: las frena su token, no el origen.
test('con secreto, una ruta normal sin header es 403 de origen y el callback del CLI llega a su chequeo de token', async () => {
  // Con secreto el arranque exige un verifier (identidad §3); este test no llega a él: el origen y el token cortan antes.
  const { base, cleanup } = await transportWith({ trust, session: { verify: async () => ({ code: 'no-session' }) } });
  const runs = await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(runs.status).toBe(403);
  expect(((await runs.json()) as { error: string }).error).toBe('origen no permitido');
  const cb = await fetch(`${base}/approval-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(cb.status).toBe(403);
  expect(((await cb.json()) as { error: string }).error).toBe('token de aprobación inválido');
  cleanup();
});

// Staging V4: con hmr.clientPort 443 el preview-check (http://127.0.0.1:5310) abría ws://127.0.0.1:443 y contaba los fallos
// del socket como defectos. Sin clientPort, vite toma host y puerto de la página (client.mjs:940) en los dos accesos.
test('el scaffold publica los hosts del Sandbox sin fijar el puerto del cliente HMR', async () => {
  process.env.WT_ALLOWED_HOSTS = 'sb-1.example.run,sb-2.example.run';
  try {
    const { default: config } = await import(`../templates/base-scaffold/vite.config.ts?sbx=${Date.now()}`);
    expect(config.server?.allowedHosts).toEqual(['sb-1.example.run', 'sb-2.example.run']);
    expect(config.server?.hmr?.clientPort).toBeUndefined();
  } finally {
    delete process.env.WT_ALLOWED_HOSTS;
  }
});

// security-reviewer H1: sin cors:false vite refleja ACAO a cualquier origen localhost, y un ws leería el código y el token
// de HMR de otro ws en 127.0.0.1:<puerto>. El preview es same-origin: nada necesita ACAO.
test('el scaffold desactiva CORS de vite (no refleja ACAO entre ws)', async () => {
  const { default: config } = await import(`../templates/base-scaffold/vite.config.ts?cors=${Date.now()}`);
  expect(config.server?.cors).toBe(false);
});

// QA (generación limpia): vite no debe vigilar `.wt/`; si no, saveDist (que escribe `.wt/dist/<commit>` en settled)
// dispara un full-reload que remonta los iframes a mitad del asentado. El glob se suma a los ignores por defecto de vite.
test('el scaffold excluye .wt/ del watcher de vite', async () => {
  const { default: config } = await import(`../templates/base-scaffold/vite.config.ts?watch=${Date.now()}`);
  expect(config.server?.watch?.ignored).toContain('**/.wt/**');
});
