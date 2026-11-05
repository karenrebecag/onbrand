// CI ubuntu (debug/linux-install-orphan): bun emite EBADF de epoll_ctl en spawn con el hijo ya lanzado. runCommand
// rechazaba sin matarlo y su 'exit' no llegaba: `sleep 30` y su grupo quedaban vivos y en el registro, y los tests que
// cuentan liveChildren() después fallaban en Linux (plan-mode-autorepair, cuarentena skipIf). El fallo de bun no se
// reproduce a voluntad: se emite el mismo 'error' sobre un hijo real.
import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { liveChildren, track } from '../src/runtime/children';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('un spawn que emite error con pid (EBADF de bun en Linux) se mata con su grupo y sale del registro', async () => {
  const real = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore', detached: true });
  const pid = real.pid!;
  // El ChildProcess que ve el transport: con pid, sin exit, y el 'error' que emite bun.
  const seen = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, kill: () => true }) as unknown as ChildProcess;
  const before = liveChildren();
  track(seen, { group: true });
  expect(liveChildren()).toBe(before + 1);
  seen.emit('error', Object.assign(new Error('Bad file descriptor, epoll_ctl'), { code: 'EBADF', errno: -9 }));
  while (liveChildren() > before) await new Promise((r) => setTimeout(r, 10));
  // El kill fue al grupo: tampoco queda el nieto (el sleep), que tiene el mismo pgid.
  let group = true;
  while (group) { try { process.kill(-pid, 0); await new Promise((r) => setTimeout(r, 10)); } catch { group = false; } }
  expect(alive(pid) && real.exitCode === null && real.signalCode === null).toBe(false);
}, 10_000);
