import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createToolWatchdog, killWorkspaceMcp, MCP_PID_FILE } from '../src/runtime/tool-watchdog';

const use = (id: string, name: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const result = (id: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

function harness() {
  let t = 0;
  const calls: string[] = [];
  const events: { type: string; status?: string; label?: string }[] = [];
  const log = { emit: (e: { type: string; status?: string; label?: string }) => events.push(e) } as never;
  const w = createToolWatchdog({ killMcp: () => { calls.push('killMcp'); return true; }, abortTurn: () => calls.push('abort'), log }, { mcp__wt__browser: 120_000 }, 30_000, () => t);
  return { w, calls, events, at: (ms: number) => { t = ms; w.check(); } };
}

describe('tool-watchdog', () => {
  // gen3: browser sin tool_result más de 810 s, solo heartbeats.
  test('una tool wt sin resultado pasado su tope corta el servidor wt y deja el paso en rojo', () => {
    const h = harness();
    h.w.feed(use('t1', 'mcp__wt__browser'));
    h.at(119_000);
    expect(h.calls).toEqual([]);
    h.at(121_000);
    expect(h.calls).toEqual(['killMcp']);
    expect(h.events.find((e) => e.type === 'step.end')).toMatchObject({ status: 'error', label: 'browser sin respuesta en 120 s' });
  });

  test('si tras cortar el servidor sigue sin resultado, corta el turno', () => {
    const h = harness();
    h.w.feed(use('t1', 'mcp__wt__browser'));
    h.at(121_000);
    h.at(152_000);
    expect(h.calls).toEqual(['killMcp', 'abort']);
  });

  test('un resultado a tiempo, o una tool que no es wt, no dispara nada', () => {
    const h = harness();
    h.w.feed(use('t1', 'mcp__wt__browser'));
    h.w.feed(result('t1'));
    h.w.feed(use('t2', 'Read'));
    h.at(500_000);
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual([]);
  });

  test('killWorkspaceMcp corta el proceso del pidfile del workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-watchdog-'));
    expect(killWorkspaceMcp(dir)).toBe(false);
    // Mismo argv que el servidor real: el script y el workspace.
    const child = spawn('sh', ['-c', 'sleep 30; :', 'scripts/workspace-mcp.ts', dir]);
    mkdirSync(dirname(join(dir, MCP_PID_FILE)), { recursive: true });
    writeFileSync(join(dir, MCP_PID_FILE), String(child.pid));
    const exited = new Promise((r) => child.on('exit', (_c, sig) => r(sig)));
    expect(killWorkspaceMcp(dir)).toBe(true);
    expect(await exited).toBe('SIGKILL');
  });

  // Revisión de orq a #267: un pid reciclado no puede llevarse un proceso ajeno.
  test('killWorkspaceMcp no toca un pid que ya no es el workspace-mcp de ese workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-watchdog-'));
    const other = spawn('sleep', ['30']);
    try {
      mkdirSync(dirname(join(dir, MCP_PID_FILE)), { recursive: true });
      writeFileSync(join(dir, MCP_PID_FILE), String(other.pid));
      expect(killWorkspaceMcp(dir)).toBe(false);
      expect(other.exitCode).toBeNull();
    } finally {
      other.kill();
    }
  });
});
