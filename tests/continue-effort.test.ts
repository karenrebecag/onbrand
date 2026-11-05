// QA cierre-modulo §2 fila 1 (arnes/robustez.md Caso 1, puntos 4 y 7): kill -9 con un follow-up vivo en effort != default,
// reiniciar el transport, recargar el builder y pulsar Continuar. La sesión se retoma (--resume), pero con el effort por
// defecto: MessageEntry guarda model y no thinking (shared.ts:284), GET /chats no lo devuelve, y tras recargar el composer
// del builder arranca en el defaultEffort del modelo (chat-panel.tsx:111-112) y lo manda explícito (continueRequest,
// use-builder.ts:101). Continuar sin thinking hereda el del turno interrumpido (MessageEntry.thinking). El builder
// tiene que dejar de forzar el default en Continuar (o hidratarlo del hilo) para que el arreglo del transport se vea.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '../src/runtime/events';
import type { Allowlist, PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest } from '../src/runtime/server';
import { writeAgentPage } from './helpers/agent-compose';

const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};
const PAGE: PageModel = { sections: [{ role: 'hero', children: [{ component: 'hero' }] }] };

let tmp: string;
let root: string;
let servers: Server[];
let compose: Composer;
let seen: ComposeRequest[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'continue-effort-'));
  root = join(tmp, 'state');
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  servers = [];
  seen = [];
  compose = async () => PAGE;
});
afterEach(() => {
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function boot(extra: Partial<ConstructorParameters<typeof Runtime>[0]> = {}): Promise<string> {
  const t = new Runtime({ root, allow, compose: async (req, log) => { seen.push(req); const p = await compose(req, log); return p.agent ? p : writeAgentPage(req, p); }, agent: true, build: false, heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), ...extra });
  const s = t.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
const post = (at: string, body: unknown) => fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const events = async (at: string, id: string): Promise<EngineEvent[]> =>
  (await (await fetch(`${at}/runs/${id}/events?cursor=-1`)).text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EngineEvent);

test('Continuar tras kill -9 sin thinking en el pedido corre con el effort del turno interrumpido', async () => {
  const at = await boot();
  await post(at, { prompt: 'a', messageId: 'e1' });
  await events(at, 'e1');
  const ws = join(root, 'ws', 'e1');
  compose = async () => {
    writeFileSync(join(ws, 'src', 'a-medias.tsx'), 'export {}\n');
    mkdirSync(join(ws, '.wt'), { recursive: true });
    writeFileSync(join(ws, '.wt', 'agent-stream.ndjson'), `${JSON.stringify({ wt_at: Date.now(), type: 'system', subtype: 'init', session_id: 'sess-e' })}\n`);
    return new Promise<never>(() => {});
  };
  await post(at, { prompt: 'b', messageId: 'e2', parentId: 'e1', thinking: { effort: 'low' } });
  while (!existsSync(join(ws, '.wt', 'agent-stream.ndjson'))) await new Promise((r) => setTimeout(r, 10));
  expect(seen.at(-1)?.thinking).toEqual({ effort: 'low' });
  compose = async () => PAGE;
  // El segundo transport sobre el mismo root hace de proceso reiniciado tras el kill -9.
  const again = await boot();
  await events(again, 'e2');
  expect((await post(again, { parentId: 'e2', continue: true, messageId: 'e3' })).status).toBe(202);
  await events(again, 'e3');
  expect(seen.at(-1)).toMatchObject({ resume: 'sess-e', thinking: { effort: 'low' } });
  // GET /chats lo devuelve para que el builder hidrate el composer de Continuar tras recargar.
  const thread = (await (await fetch(`${again}/chats/e1`)).json()) as { messages: { messageId: string; thinking?: unknown }[] };
  expect(thread.messages.find((m) => m.messageId === 'e2')?.thinking).toEqual({ effort: 'low' });
});

test('Continuar tras kill -9 sin model en el pedido sigue con el modelo del turno interrumpido, no con el default', async () => {
  const models = [{ id: 'm-default', name: 'D', provider: 't' }, { id: 'm-elegido', name: 'E', provider: 't' }];
  const at = await boot({ models });
  await post(at, { prompt: 'a', messageId: 'e1' });
  await events(at, 'e1');
  const ws = join(root, 'ws', 'e1');
  compose = async () => {
    writeFileSync(join(ws, 'src', 'a-medias.tsx'), 'export {}\n');
    mkdirSync(join(ws, '.wt'), { recursive: true });
    writeFileSync(join(ws, '.wt', 'agent-stream.ndjson'), `${JSON.stringify({ wt_at: Date.now(), type: 'system', subtype: 'init', session_id: 'sess-m' })}\n`);
    return new Promise<never>(() => {});
  };
  await post(at, { prompt: 'b', messageId: 'e2', parentId: 'e1', model: 'm-elegido' });
  while (!existsSync(join(ws, '.wt', 'agent-stream.ndjson'))) await new Promise((r) => setTimeout(r, 10));
  compose = async () => PAGE;
  const again = await boot({ models });
  await events(again, 'e2');
  expect((await post(again, { parentId: 'e2', continue: true, messageId: 'e3' })).status).toBe(202);
  await events(again, 'e3');
  expect(seen.at(-1)).toMatchObject({ resume: 'sess-m', model: 'm-elegido' });
});
