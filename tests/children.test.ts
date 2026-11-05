import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { killChildren, liveChildren, track } from '../src/runtime/children';

test('el cierre escala a SIGKILL un hijo que ignora SIGTERM y lo saca del registro', async () => {
  // Un CLI colgado que ignora SIGTERM: con el exit a los 8 s del shutdown quedaba huérfano (auditoría #12).
  const child = track(spawn('sh', ['-c', 'trap "" TERM; echo listo; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] }));
  const exited = new Promise<NodeJS.Signals | null>((r) => child.once('exit', (_c, sig) => r(sig)));
  // El SIGTERM tiene que llegar con el trap ya puesto, si no lo mata él y no hay nada que escalar.
  await new Promise((r) => child.stdout?.once('data', r));
  expect(liveChildren()).toBeGreaterThan(0);
  await killChildren(100);
  expect(await exited).toBe('SIGKILL');
  expect(liveChildren()).toBe(0);
});
