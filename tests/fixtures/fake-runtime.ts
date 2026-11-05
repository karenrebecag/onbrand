// Runtime de mentira para probar local-sandbox: anota su entorno y pid en <root>/vm.json y dice que está listo como serve.ts.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name: string): string => process.argv[process.argv.indexOf(name) + 1]!;
const root = arg('--root');
mkdirSync(root, { recursive: true });
// die-once: la primera vez sale (como un puerto ocupado); la segunda arranca.
if (process.env.FAKE_RUNTIME_MODE === 'die-once' && !existsSync(join(root, '.tried'))) { writeFileSync(join(root, '.tried'), '1'); console.error('puerto ocupado'); process.exit(3); }
if (process.env.FAKE_RUNTIME_MODE === 'slow') await new Promise((r) => setTimeout(r, 400));
if (process.env.FAKE_RUNTIME_MODE === 'die') { console.error('no puedo arrancar'); process.exit(3); }
if (process.env.FAKE_RUNTIME_MODE === 'silent') setInterval(() => undefined, 1000);
else {
  writeFileSync(join(root, 'vm.json'), JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), env: process.env }));
  console.log(`transport en http://127.0.0.1:${arg('--port')}; preview en http://localhost:${arg('--preview-port')}`);
  setInterval(() => undefined, 1000);
}
