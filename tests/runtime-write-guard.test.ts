import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Allowlist, PageModel } from '../src/runtime/runner';
import { Runtime, type RuntimeOptions } from '../src/runtime/server';

// CSRF desde una página generada (Arq; zap-api-origen.md): el preview se sirve en un origen loopback, que isTrustedRequest
// acepta, y un POST text/plain o sin cuerpo no lleva preflight.
const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};
const PAGE: PageModel = { sections: [{ role: 'hero', children: [{ component: 'hero' }] }] };
const BUILDER = 'http://localhost:5298';

let tmp: string;
let server: Server;
let composed: number;

async function boot(extra: Partial<RuntimeOptions> = {}): Promise<string> {
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  const t = new Runtime({ root: join(tmp, 'state'), allow, compose: async () => { composed += 1; return PAGE; }, build: false, heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), builderOrigin: BUILDER, ...extra });
  server = t.listen(0);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'write-guard-'));
  mkdirSync(join(tmp, 'vault'));
  composed = 0;
});
afterEach(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('una escritura sin content-type JSON es 415 y no lanza nada: text/plain o sin cuerpo', async () => {
  const at = await boot();
  expect((await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ prompt: 'gasta', messageId: 'x1' }) })).status).toBe(415);
  expect((await fetch(`${at}/approvals/always/x`, { method: 'DELETE' })).status).toBe(415);
  expect((await fetch(`${at}/runs/x1/events?cursor=-1`)).status).toBe(404);
  expect(composed).toBe(0);
});

test('un Origin que no es el builder ni el runtime no escribe aunque sea loopback; el del builder sí', async () => {
  const at = await boot();
  const run = (origin: string, messageId: string) => fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ prompt: 'a', messageId }) });
  // El origen del listener de previews: una página generada.
  expect((await run('http://127.0.0.1:5311', 'p1')).status).toBe(403);
  expect((await run(BUILDER, 'p2')).status).toBe(202);
  await (await fetch(`${at}/runs/p2/events?cursor=-1`)).text();
  expect(composed).toBe(1);
});

test('la subida multipart necesita su header: sin él es 415', async () => {
  const at = await boot();
  const form = () => { const f = new FormData(); f.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'a.png'); return f; };
  expect((await fetch(`${at}/uploads`, { method: 'POST', body: form() })).status).toBe(415);
  expect((await fetch(`${at}/uploads`, { method: 'POST', headers: { 'x-wt-request': '1' }, body: form() })).status).not.toBe(415);
});
