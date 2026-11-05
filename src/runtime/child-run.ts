// Un comando hijo del transport sin bloquear el event loop: con spawnSync, un `bun install` o un `vite build` congelaba los
// streams, los cancels y el /mcp de todos los chats mientras duraba, y sin tope un install colgado lo congelaba para siempre
// (auditoría #9). Mismo patrón que preview-check.ts:29-41: plazo → SIGTERM → gracia → SIGKILL, y se resuelve en 'exit'.

import { spawn } from 'node:child_process';
import { signalChild, track } from './children';

const KILL_GRACE_MS = 5_000;
const STDERR_TAIL = 4_000;

export interface CommandResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export function runCommand(cmd: string, args: readonly string[], o: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    // Grupo propio: el kill llega a los nietos de bun y bunx, no solo al pid que lanzamos.
    const child = track(spawn(cmd, [...args], { cwd: o.cwd, env: o.env, stdio: ['ignore', 'ignore', 'pipe'], detached: true }), { group: true });
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      signalChild(child, 'SIGTERM');
      killer = setTimeout(() => signalChild(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    child.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-STDERR_TAIL); });
    const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
    const onAbort = (): void => { aborted = true; stop(); };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (): void => {
      clearTimeout(timer);
      clearTimeout(killer);
      o.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => { done(); reject(e); });
    // 'exit' y no 'close': un nieto que herede el pipe de stderr no debe alargar la espera (preview-check.ts:39).
    child.on('exit', (code) => { done(); resolve({ code, stderr, timedOut, aborted }); });
  });
}
