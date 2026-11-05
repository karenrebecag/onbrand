import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnAgentCli } from '../src/runtime/agent-loop';
import { openEventLog } from '../src/runtime/events';
import { sh } from '../src/runtime/shared';

// El agente comparte uid con el transport: lo que está en el entorno del CLI y de los pasos bash (un vite.config que escribió
// el agente corre ahí) lo puede leer. Se mide con procesos reales, no con la función: si alguien cambia de dónde sale el env,
// esto lo ve.
const SECRETS = { WT_PREVIEW_SECRET: 'p'.repeat(40), WT_ORIGIN_SECRET: 'o'.repeat(40), AI_GATEWAY_API_KEY: 'gw-key', VERCEL_OIDC_TOKEN: 'oidc', BLOB_READ_WRITE_TOKEN: 'blob', PIPEDREAM_CLIENT_SECRET: 'pd' };
const saved = { ...process.env };
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'agent-env-')); Object.assign(process.env, SECRETS); });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(tmp, { recursive: true, force: true });
});

const leaked = (env: string): string[] => Object.entries(SECRETS).flatMap(([k, v]) => (env.includes(`${k}=`) || env.includes(v) ? [k] : []));

test('el entorno del CLI del agente no lleva los secretos del transport (incluido WT_PREVIEW_SECRET)', async () => {
  const lines: string[] = [];
  // `env` no emite el `result` del stream de Claude Code, así que spawnAgentCli rechaza al cerrar; las líneas ya llegaron.
  await spawnAgentCli('env', [], '', tmp, (l) => lines.push(l)).catch(() => 0);
  const env = lines.join('\n');
  expect(env).toContain('PATH=');
  expect(leaked(env)).toEqual([]);
});

test('el entorno de un paso bash (install, vite build) no lleva los secretos del transport', async () => {
  const log = openEventLog(join(tmp, 'logs'), 'm1');
  await sh(log, 's', ['a', 'b'], 'sh', ['-c', 'env > env.txt'], tmp);
  const env = readFileSync(join(tmp, 'env.txt'), 'utf8');
  expect(env).toContain('PATH=');
  expect(leaked(env)).toEqual([]);
});
