// QA sobre #635 (cerrado por H1, Secondary): GET /runs/:id/publishable existe para un mensaje con versión
// (publish-check-local.md:16). El builder ya no lo pide desde #704 (lanza el vite build, #694); la ruta sigue en el runtime
// y este test la fija.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/runtime/events';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type ComposeRequest } from '../src/runtime/server';

let tmp: string;
let server: Server | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'publishable-'));
  mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
});
afterEach(() => { server?.close(); rmSync(tmp, { recursive: true, force: true }); });

test('GET /runs/:id/publishable existe para un mensaje con versión', async () => {
  const compose = async (req: ComposeRequest) => {
    writeFileSync(join(req.workspace?.dir as string, 'src', 'a.tsx'), 'export {}\n');
    return { sections: [], agent: { files: ['src/a.tsx'], summary: 'Listo', missing: [], sessionId: 's' } } as unknown as PageModel;
  };
  const root = join(tmp, 'state');
  const t = new Runtime({ root, allow: {}, agent: true, compose: compose as never, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), autoRepair: false });
  server = t.listen(0);
  await new Promise((r) => server!.once('listening', r));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  expect((await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'base', messageId: 'a0' }) })).status).toBe(202);
  for (let i = 0; i < 1000 && !readEvents(join(root, 'logs'), 'a0').events.some((e) => e.type === 'settled'); i++) await new Promise((r) => setTimeout(r, 10));
  const res = await fetch(`${at}/runs/a0/publishable`);
  const body = (await res.json()) as { error?: string };
  // Sin vite instalado en el ws no hay paquete de export: 409 no-build; lo que no puede ser es la ruta desconocida.
  expect(body.error).not.toBe('ruta desconocida');
  expect([200, 409]).toContain(res.status);
});
