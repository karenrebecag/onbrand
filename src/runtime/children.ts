// Registro de los procesos hijos vivos del transport. El shutdown abortaba las corridas y salía con process.exit a los 8 s
// (transport.ts SHUTDOWN_GRACE_MS) sin saber qué hijos quedaban: el SIGKILL del CLI del agente era un timer unref de 5 s
// (agent-loop.ts) que el exit podía ganar, y tsc, la visión, infer y el preview-check no tenían a nadie que los cortara
// (auditoría #12). Con el registro, el cierre manda SIGTERM a todos, espera una gracia y escala a SIGKILL antes de salir,
// como preview-check.ts:29-41 hace con su propio hijo.

import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

const live = new Set<ChildProcess>();
const groups = new WeakSet<ChildProcess>();

/** Manda la señal al hijo o, si se lanzó con `detached: true`, a su grupo de procesos entero: `bunx vite build` y `bun
 * install` tienen nietos que un kill al pid dejaba vivos (Arq, R1.3; kill(2) con pid negativo = el grupo). */
export function signalChild(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (groups.has(child) && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // ya murió
  }
}

/** Anota un hijo; sale solo del registro al terminar. Devuelve el mismo hijo para envolver el spawn en línea. `group`: se
 * lanzó con `detached: true` y es líder de su grupo. */
export function track<T extends ChildProcess>(child: T, o: { group?: boolean } = {}): T {
  if (child.exitCode !== null || child.signalCode !== null) return child;
  if (o.group) groups.add(child);
  live.add(child);
  child.once('exit', () => live.delete(child));
  child.once('error', () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Un spawn que falla (ENOENT) no emite 'exit'.
    if (!child.pid) { live.delete(child); return; }
    // Con pid el proceso sí arrancó: bun en Linux emite EBADF de epoll_ctl al registrar el pipe de stderr con el hijo ya
    // lanzado (CI ubuntu, debug/linux-install-orphan), y quien lo lanzó rechaza sin matarlo. Su 'exit' tampoco llega:
    // se mata (al grupo si es líder) y sale del registro cuando el pid ya no existe.
    reap(child, child.pid);
  });
  return child;
}

// Un zombi responde a kill(pid, 0): si bun no llega a recogerlo, en Linux /proc dice Z y ya cuenta como muerto.
const zombie = (pid: number): boolean => { try { return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); } catch { return false; } return !zombie(pid); };
const REAP_POLL_MS = 25;

// El error puede llegar antes de que el hijo haga setsid (detached): kill(-pid) da ESRCH y el pid sigue vivo. Por eso la
// señal se repite en cada vuelta, al grupo y al pid, hasta que no quede.
const killHard = (child: ChildProcess, pid: number): void => {
  signalChild(child, 'SIGKILL');
  try { process.kill(pid, 'SIGKILL'); } catch { /* ya murió */ }
};

function reap(child: ChildProcess, pid: number): void {
  killHard(child, pid);
  const poll = setInterval(() => {
    if (alive(pid) && child.exitCode === null && child.signalCode === null) { killHard(child, pid); return; }
    clearInterval(poll);
    live.delete(child);
  }, REAP_POLL_MS);
  poll.unref();
}

export const liveChildren = (): number => live.size;

const exited = (c: ChildProcess): boolean => c.exitCode !== null || c.signalCode !== null || !live.has(c);

/** SIGTERM a todos, hasta `graceMs` para que salgan, y SIGKILL a los que sigan. Nunca lanza: corre en el cierre. La gracia
 * es la de preview-check.ts (KILL_GRACE_MS, 5 s). */
export async function killChildren(graceMs = 5_000): Promise<void> {
  const all = [...live];
  for (const c of all) signalChild(c, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (all.some((c) => !exited(c)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  for (const c of all) if (!exited(c)) signalChild(c, 'SIGKILL');
}
