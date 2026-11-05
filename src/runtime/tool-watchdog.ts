// Tope por tool_use de las tools del servidor `wt` (typecheck, browser), visto desde el stream del CLI. Cubre lo que el
// tope interno del MCP no ve: gen3 quedó más de 810 s solo con heartbeats y el MCP estaba ocioso, sin chromium ni
// sockets, o sea que la respuesta se perdió entre el MCP y el CLI. Primero se corta el servidor `wt` para que el CLI
// devuelva un error de tool y el agente siga; si aun así no llega el resultado, se corta el turno.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from './events';
import { AGENT_DIR } from '../skill-registry';

/** Por encima del tope interno de browser (90 s, browser.ts): si el MCP responde, su error llega antes. */
export const TOOL_DEADLINES: Readonly<Record<string, number>> = { mcp__wt__browser: 120_000, mcp__wt__typecheck: 120_000 };
export const KILL_GRACE_MS = 30_000;
export const CHECK_EVERY_MS = 5_000;
export const MCP_PID_FILE = `${AGENT_DIR}/wt-mcp.pid`;

export interface WatchdogHooks {
  /** Corta el servidor `wt`; true si había uno que cortar. */
  killMcp: () => boolean;
  abortTurn: () => void;
  log?: EventLog;
  parentStepId?: string;
}

interface Open { name: string; at: number; killedAt?: number }

const short = (name: string) => name.replace(/^mcp__wt__/, '');

export function createToolWatchdog(hooks: WatchdogHooks, deadlines: Readonly<Record<string, number>> = TOOL_DEADLINES, graceMs = KILL_GRACE_MS, now: () => number = Date.now) {
  const open = new Map<string, Open>();
  const parent = hooks.parentStepId ? { parentStepId: hooks.parentStepId } : {};
  const fail = (id: string, label: string, message: string) => {
    hooks.log?.emit({ type: 'step.start', stepId: id, kind: 'action', label, ...parent });
    hooks.log?.emit({ type: 'step.end', stepId: id, label, status: 'error', error: { type: 'tool-timeout', message } });
  };
  return {
    feed(line: string): void {
      let e: { type?: string; message?: { content?: unknown } };
      try { e = JSON.parse(line); } catch { return; }
      const content = Array.isArray(e.message?.content) ? (e.message?.content as Record<string, unknown>[]) : [];
      for (const b of content) {
        if (e.type === 'assistant' && b.type === 'tool_use' && typeof b.name === 'string' && b.name in deadlines) open.set(String(b.id), { name: b.name, at: now() });
        if (e.type === 'user' && b.type === 'tool_result') open.delete(String(b.tool_use_id));
      }
    },
    check(): void {
      const t = now();
      for (const [id, o] of open) {
        const limit = deadlines[o.name] as number;
        if (o.killedAt === undefined && t - o.at > limit) {
          o.killedAt = t;
          const killed = hooks.killMcp();
          fail(`watchdog:${id}`, `${short(o.name)} sin respuesta en ${Math.round(limit / 1000)} s`, killed ? 'se cortó el servidor wt para que la tool devuelva error' : 'no había servidor wt que cortar');
        } else if (o.killedAt !== undefined && t - o.killedAt > graceMs) {
          open.delete(id);
          hooks.abortTurn();
          fail(`watchdog:${id}:turn`, `${short(o.name)} sigue sin respuesta: turno cortado`, `${Math.round((t - o.at) / 1000)} s desde la llamada`);
        }
      }
    },
  };
}

/** El servidor `wt` deja su pid en el workspace al arrancar (scripts/workspace-mcp.ts). */
export function killWorkspaceMcp(dir: string): boolean {
  const file = join(dir, MCP_PID_FILE);
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // macOS recicla pids: si el servidor ya murió, ese pid puede ser cualquier proceso de Karen. Solo se mata si su
  // comando sigue siendo el workspace-mcp de este workspace.
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '';
  if (!command.includes('workspace-mcp') || !command.includes(dir)) return false;
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
