// C6 (docs/spec/contexto-agente.md §4): las instructions viajan con la versión. Un follow-up sin `instructions` hereda las
// del padre; uno con `[]` las quita a propósito. Regresión del flujo de #428: quitarlo rompería las reglas por chat.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/runtime/events';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type ComposeRequest } from '../src/runtime/server';
import { writeAgentPage } from './helpers/agent-compose';

let tmp: string;
let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

test('un follow-up sin instructions hereda las del padre; con [] no lleva ninguna', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'instructions-inherit-'));
  const root = join(tmp, 'state');
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  mkdirSync(join(tmp, 'vault'));
  const seen: ComposeRequest[] = [];
  const page: PageModel = { sections: [] };
  const t = new Runtime({ root, allow: {}, compose: async (req) => { seen.push(req); return writeAgentPage(req, page); }, agent: true, build: false, heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
  server = t.listen(0);
  await new Promise((r) => server!.once('listening', r));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const run = async (body: Record<string, unknown>): Promise<void> => {
    expect((await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).ok).toBe(true);
    await (await fetch(`${at}/runs/${body.messageId as string}/events?cursor=-1`)).text();
    expect(readEvents(join(root, 'logs'), body.messageId as string).done).toBe(true);
  };
  await run({ prompt: 'landing', messageId: 'c1', instructions: ['tono formal'] });
  await run({ prompt: 'cambia el hero', messageId: 'c2', parentId: 'c1' });
  await run({ prompt: 'sin reglas', messageId: 'c3', parentId: 'c2', instructions: [] });
  expect(seen.map((r) => r.instructions ?? [])).toEqual([['tono formal'], ['tono formal'], []]);
});
