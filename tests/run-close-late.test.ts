// Pasos tardíos del cierre (run-close startLate): lo dictado que el turno perdió sale con los defectos del preview-check
// (QA #615) y las sugerencias del modelo reciben lo inventado del turno para fijar el chip de datos reales (C4).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FactsDisclosure } from '../src/facts-disclosure';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { PreviewPool } from '../src/runtime/preview';
import type { PreviewChecker } from '../src/runtime/preview-check';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest } from '../src/runtime/server';

const HERO = 'src/sections/01-hero.tsx';
const LOST = [{ text: 'Venda por WhatsApp sin perder un cliente', file: HERO, messageId: 'ta' }];
const FACTS: FactsDisclosure = { invented: [{ slug: '04-casos', text: 'testimonios con nombres de clientes' }], declared: false, undisclosed: ['people'] };

let tmp: string;
let server: Server | undefined;
let factsSeen: (FactsDisclosure | undefined)[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'run-close-late-'));
  mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  factsSeen = [];
});
afterEach(() => { server?.close(); server = undefined; rmSync(tmp, { recursive: true, force: true }); });

const base: Composer = async (req: ComposeRequest) => {
  const dir = req.workspace?.dir as string;
  mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
  writeFileSync(join(dir, HERO), 'export {}\n');
  return { sections: [], agent: { files: [HERO], summary: 'Listo', missing: [], suggestions: [], sessionId: `sess-${req.messageId}`, pinnedLost: LOST, factsDisclosed: FACTS } } as unknown as PageModel;
};
const compose = Object.assign(base, { suggest: async (_input: unknown, _log: unknown, facts?: FactsDisclosure) => { factsSeen.push(facts); return []; } });

async function boot(check: PreviewChecker): Promise<string> {
  const previews = { ensure: async () => ({ url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 }), drainErrors: () => [] } as unknown as PreviewPool;
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, agent: true, compose, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), previews, previewCheck: check, autoRepair: false });
  server = t.listen(0);
  await new Promise((r) => server!.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const logOf = (id: string): (EngineEvent & Record<string, unknown>)[] => readEvents(join(tmp, 'state', 'logs'), id).events as (EngineEvent & Record<string, unknown>)[];
async function settled(id: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (logOf(id).some((e) => e.type === 'settled')) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${id} no cerró`);
}

test('lo dictado que el turno perdió sale como defecto del preview-check, y el suggest recibe factsDisclosed', async () => {
  const at = await boot(async () => []);
  expect((await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'm1' }) })).status).toBe(202);
  await settled('m1');
  const end = logOf('m1').find((e) => e.type === 'step.end' && e.stepId === 'transport:preview-check') as { status?: string; detail?: { output?: { defects?: unknown[] } } } | undefined;
  expect(end?.status).toBe('error');
  expect(end?.detail?.output?.defects).toEqual([{ field: 'preview.runtime', owner: 'A', kind: 'preserve-text', slug: '01-hero', viewport: 0, message: `el texto dictado en ta ya no está en ${HERO}: "${LOST[0]!.text}"`, text: LOST[0]!.text }]);
  expect(factsSeen).toEqual([FACTS]);
});
