// Condición 5 / hallazgo 2 de QA sobre #596: un Stop antes del compose (aquí, conectando apps) rompe ese await con una
// excepción. Debe cerrar stopped, sin evento error, y no failed. Sin LLM ni reloj: el conector se suelta a mano.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connectors } from '../src/runtime/connectors';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type ComposeRequest } from '../src/runtime/server';
import type { MessageEntry } from '../src/runtime/shared';

let tmp: string;
let root: string;
let server: Server | undefined;
let entered = false;
let fail!: (e: Error) => void;
let composed = false;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'stop-before-'));
  root = join(tmp, 'state');
  mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  entered = false;
  composed = false;
});
afterEach(() => { server?.close(); server = undefined; rmSync(tmp, { recursive: true, force: true }); });

const connectors = { mcp: () => { entered = true; return new Promise<never>((_, reject) => { fail = reject; }); } } as unknown as Connectors;
const compose = async (_req: ComposeRequest): Promise<PageModel> => { composed = true; return { sections: [], agent: { files: [], summary: '', missing: [] } } as unknown as PageModel; };

const logOf = (id: string): EngineEvent[] => readEvents(join(root, 'logs'), id).events;
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`${what} no llegó`);
}

test('un Stop mientras se conectan las apps cierra stopped, sin evento error', async () => {
  const t = new Runtime({ root, allow: {}, agent: true, compose, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), connectors });
  server = t.listen(0);
  await new Promise((r) => server!.once('listening', r));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown) => fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post('/runs', { prompt: 'landing', messageId: 's1', connectors: ['slack'] })).status).toBe(202);
  await until('conectores', () => entered);
  expect((await post('/runs/s1/cancel', {})).status).toBe(202);
  // El await de conectores no mira la señal: revienta cuando el abort ya ocurrió, como un install o un montaje cortados.
  fail(new Error('aborted'));
  await until('settled', () => logOf('s1').some((e) => e.type === 'settled'));
  const evs = logOf('s1');
  expect(evs.some((e) => e.type === 'error')).toBe(false);
  expect(evs.find((e) => e.type === 'message.end')).toMatchObject({ outcome: 'stopped', finishReason: 'stopped' });
  const entry = (JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, MessageEntry>).s1;
  expect(entry?.outcome).toBe('stopped');
  expect(composed).toBe(false);
});
