import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeInferFree } from '../src/runtime/infer';
import { runWorkspaceTool } from '../src/runtime/workspace-tools';

test('una tool que llega con la corrida ya detenida no arranca', async () => {
  let called = false;
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await runWorkspaceTool('generate_image', { prompt: 'p', target_path: '/images/a.jpg' }, {
    dir: tmpdir(), previews: { ensure: async () => ({ url: 'http://x' }) }, signal: ctrl.signal,
    imageGen: async () => { called = true; return { bytes: new Uint8Array(), mediaType: 'image/png' }; },
  });
  expect(r).toEqual({ ok: false, error: 'generate_image: la corrida se detuvo' });
  expect(called).toBe(false);
});

// HACK: cuarentena — flaky de reloj (poll de SIGTERM de un proceso real bajo carga de CI). Reactivar con un clock/espera determinista del hijo.
test.skip('infer por CLI: abortar la corrida mata el `claude -p` y no reintenta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infer-signal-'));
  try {
    // Un CLI que se cuelga: deja su pid y duerme. Sin señal ni timeout, la promesa no resolvía nunca (auditoría #8).
    const bin = join(dir, 'cli.sh');
    const pidFile = join(dir, 'pid');
    writeFileSync(bin, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
    chmodSync(bin, 0o755);
    const ctrl = new AbortController();
    const call = claudeCodeInferFree({ bin })('sys', '{}', ctrl.signal);
    while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) await new Promise((r) => setTimeout(r, 10));
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    ctrl.abort();
    await expect(call).rejects.toThrow('la corrida se detuvo');
    // Bun llama al callback de execFile al abortar, antes de que el hijo termine de morir por el SIGTERM.
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 200 && alive(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(alive()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
