import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Allowlist, PageModel } from '../src/runtime/runner';
import { Runtime, type RuntimeOptions } from '../src/runtime/server';

const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};
const PAGE: PageModel = { sections: [{ role: 'hero', children: [{ component: 'hero' }] }] };

let tmp: string;
let server: Server;

async function boot(extra: Partial<RuntimeOptions> = {}): Promise<string> {
  const t = new Runtime({ root: join(tmp, 'state'), allow, compose: async () => PAGE, build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), ...extra });
  server = t.listen(0);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

// Bun deriva el content-type de la parte del nombre, no del Blob (un navegador real respeta el tipo del Blob): el nombre
// fija el tipo que el transport ve y valida.
const audioForm = (bytes: number[], name = 'recording.webm') => {
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(bytes)]), name);
  return f;
};
const post = (at: string, form: FormData) => fetch(`${at}/transcribe`, { method: 'POST', headers: { 'x-wt-request': '1' }, body: form });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'transcribe-'));
  mkdirSync(join(tmp, 'vault'));
});
afterEach(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

// El core no inyecta proveedor: la ruta responde un "no soportado" explícito, no 404 de ruta ni 415 del guard.
test('sin proveedor el transport responde 501, no 404 ni 415', async () => {
  const at = await boot();
  const res = await post(at, audioForm([1, 2, 3]));
  expect(res.status).toBe(501);
  expect(await res.json()).toEqual({ error: 'este transport no transcribe audio' });
});

// Con proveedor inyectado (variante de una distro) el audio llega al seam y su texto vuelve como {text}.
test('con proveedor transcribe el audio y devuelve el texto', async () => {
  let seen: { size: number; type: string } | undefined;
  const at = await boot({
    transcribe: async (audio, type) => { seen = { size: audio.byteLength, type }; return 'hola mundo'; },
  });
  const res = await post(at, audioForm([10, 20, 30, 40]));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: 'hola mundo' });
  expect(seen).toEqual({ size: 4, type: 'video/webm' });
});

// Spend/memoria: más de MAX_TRANSCRIBING en vuelo es 429, no se retiene otro buffer ni se gasta otra llamada.
test('con el cupo lleno la siguiente transcripción es 429', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const at = await boot({ transcribe: async () => { calls += 1; await gate; return 'ok'; } });
  const inflight = [post(at, audioForm([1])), post(at, audioForm([2]))];
  // Deja que las dos primeras ocupen el cupo antes de la tercera.
  await new Promise((r) => setTimeout(r, 50));
  const third = await post(at, audioForm([3]));
  expect(third.status).toBe(429);
  release();
  expect((await Promise.all(inflight)).map((r) => r.status)).toEqual([200, 200]);
  expect(calls).toBe(2);
});

// Input externo: un tipo fuera de la lista no gasta la transcripción.
test('un tipo de audio no aceptado es 415 y no llama al proveedor', async () => {
  let calls = 0;
  const at = await boot({ transcribe: async () => { calls += 1; return ''; } });
  const res = await post(at, audioForm([1, 2, 3], 'note.txt'));
  expect(res.status).toBe(415);
  expect(calls).toBe(0);
});
