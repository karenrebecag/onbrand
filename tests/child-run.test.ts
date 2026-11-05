import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/runtime/child-run';

test('un comando que pasa su plazo muere y se reporta como timedOut, no como éxito', async () => {
  const r = await runCommand('sleep', ['30'], { cwd: process.cwd(), env: process.env, timeoutMs: 50 });
  expect(r).toMatchObject({ timedOut: true, aborted: false });
  expect(r.code).not.toBe(0);
});

test('abortar la corrida mata el comando', async () => {
  const ctrl = new AbortController();
  const p = runCommand('sleep', ['30'], { cwd: process.cwd(), env: process.env, timeoutMs: 60_000, signal: ctrl.signal });
  ctrl.abort();
  expect(await p).toMatchObject({ aborted: true, timedOut: false });
});

test('el plazo mata también a los nietos del comando (bunx y bun lanzan los suyos)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'child-run-'));
  try {
    const pidFile = join(dir, 'nieto');
    // El hijo lanza un nieto y lo espera: un kill al pid del hijo dejaba vivo al nieto.
    await runCommand('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], { cwd: dir, env: process.env, timeoutMs: 200 });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 200 && alive(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(alive()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
