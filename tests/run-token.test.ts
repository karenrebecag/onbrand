import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComposeRequest } from '../src/runtime/shared';
import { Runtime } from '../src/runtime/server';
import { writeAgentPage } from './helpers/agent-compose';
import { spawnAgentCli } from '../src/runtime/agent-loop';

// deploy-sandbox.md §1: el orquestador manda el token de gasto de la corrida en POST /runs (x-wt-run-token) y llega hasta el
// ANTHROPIC_AUTH_TOKEN del CLI, sin pasar por process.env.
let tmp: string;
let server: Server;
const seen: ComposeRequest[] = [];

async function boot(): Promise<string> {
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose: async (req) => { seen.push(req); return writeAgentPage(req, { sections: [] }); }, agent: true, build: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
  server = t.listen(0);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'run-token-')); mkdirSync(join(tmp, 'vault')); seen.length = 0; });
afterEach(() => { server?.close(); rmSync(tmp, { recursive: true, force: true }); });

const run = (base: string, token?: string) => fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-wt-run-token': token }) }, body: JSON.stringify({ prompt: 'hola' }) });
const waitCompose = async (): Promise<void> => { for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 20)); };

test('x-wt-run-token llega al ComposeRequest; sin header o con un valor no imprimible no hay token', async () => {
  const base = await boot();
  expect((await run(base, 'tok_abc.def-123')).status).toBe(202);
  await waitCompose();
  expect(seen[0]!.runToken).toBe('tok_abc.def-123');
  seen.length = 0;
  expect((await run(base)).status).toBe(202);
  await waitCompose();
  expect(seen[0]!.runToken).toBeUndefined();
  seen.length = 0;
  expect((await run(base, 'con espacio')).status).toBe(202);
  await waitCompose();
  expect(seen[0]!.runToken).toBeUndefined();
});

test('spawnAgentCli le da al CLI el token de la corrida como ANTHROPIC_AUTH_TOKEN, no el del proceso', async () => {
  const before = { ...process.env };
  process.env.ANTHROPIC_BASE_URL = 'https://orq.example/gw/claude-code';
  process.env.ANTHROPIC_AUTH_TOKEN = 'token-de-la-vm';
  try {
    const lines: string[] = [];
    await spawnAgentCli('env', [], '', tmp, (l) => lines.push(l), undefined, undefined, 'token-de-la-corrida').catch(() => 0);
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=token-de-la-corrida');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=token-de-la-vm');
  } finally {
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  }
});

test('el token no se escribe en request.json del workspace ni queda en su historial git', async () => {
  const base = await boot();
  const token = 'tok_secreto_de_la_corrida';
  expect((await run(base, token)).status).toBe(202);
  await waitCompose();
  const wsRoot = join(tmp, 'state', 'ws');
  const requestFile = (): string | undefined => {
    if (!existsSync(wsRoot)) return undefined;
    for (const ws of readdirSync(wsRoot)) { const f = join(wsRoot, ws, 'request.json'); if (existsSync(f)) return f; }
    return undefined;
  };
  for (let i = 0; i < 150 && !requestFile(); i++) await new Promise((r) => setTimeout(r, 20));
  const f = requestFile();
  expect(f).toBeDefined();
  expect(readFileSync(f!, 'utf8')).not.toContain(token);
  const dir = join(f!, '..');
  if (existsSync(join(dir, '.git'))) expect(spawnSync('git', ['log', '-p', '--all'], { cwd: dir, encoding: 'utf8' }).stdout).not.toContain(token);
});
