import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, Suggestion } from '../src/runtime/events';
import type { PreviewPool } from '../src/runtime/preview';
import { Runtime, type Composer, type ComposeRequest } from '../src/runtime/server';
import type { SuggestHook } from '../src/runtime/agent-composer';

// Ola 1 A (AUDIT-COSTO-SINTESIS.md): la versión cierra en el commit y preview-check y sugerencias llegan después, en
// paralelo, como el featureSuggestions de Lovable en asyncRunResult tras el run (dashboard-shared-CKfq1xYq.deob.js:4756).

let tmp: string;
let srv: Server | undefined;
afterEach(() => { srv?.close(); srv = undefined; rmSync(tmp, { recursive: true, force: true }); });

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const until = async (ok: () => boolean) => { while (!ok()) await new Promise((r) => setTimeout(r, 5)); };

async function setup(previewCheck: () => Promise<never[]>, suggest: SuggestHook, files: string[] | ((n: number) => string[]) = ['src/App.tsx'], seen: ComposeRequest[] = []) {
  tmp = mkdtempSync(join(tmpdir(), 'v0-late-'));
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  let n = 0;
  const compose = Object.assign((async (req) => {
    seen.push(req);
    const dir = req.workspace?.dir as string;
    mkdirSync(join(dir, 'src'), { recursive: true });
    const own = typeof files === 'function' ? files(n) : files;
    // Un turno que pregunta no toca el árbol: desde que la versión sale del árbol y no de la lista del agente, escribir App
    // aquí lo volvería una versión.
    if (own.length) writeFileSync(join(dir, 'src', 'App.tsx'), `export default function App() { return <main>v${n}</main>; }\n`);
    n++;
    return { sections: [], page: { lang: 'es' }, agent: { files: own, summary: own.length ? 'ok' : '¿Qué titular quieres en el hero?', missing: [], suggestions: [] } };
  }) satisfies Composer, { suggest });
  const previews = { ensure: async () => ({ url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 }), drainErrors: () => [] } as unknown as PreviewPool;
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), previews, previewCheck });
  srv = t.listen(0);
  await new Promise((r) => srv!.once('listening', r));
  const at = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const post = (body: unknown) => fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const stream = async (id: string) => (await (await fetch(`${at}/runs/${id}/events`)).text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EngineEvent);
  const versions = async (id: string) => ((await (await fetch(`${at}/runs/${id}/versions`)).json()) as { versions: { messageId: string }[] }).versions.map((v) => v.messageId);
  return { post, stream, versions };
}

test('message.end y snapshot salen antes que los tardíos, que corren a la vez, y settled cierra el stream', async () => {
  const check = deferred<never[]>();
  const ideas = deferred<Suggestion[]>();
  let checking = false;
  let suggesting = false;
  const { post, stream } = await setup(() => { checking = true; return check.promise; }, async (_input, log) => {
    suggesting = true;
    const page = await ideas.promise;
    log.emit({ type: 'step.start', stepId: 'agent:suggestions', kind: 'action', label: 'Proponiendo' });
    log.emit({ type: 'step.end', stepId: 'agent:suggestions', label: 'Siguientes pasos', status: 'ok', detail: { kind: 'action', name: 'suggestions', summary: '1', followUps: page } });
    return page;
  });
  await post({ prompt: 'landing', messageId: 'm1' });
  // Los dos tardíos quedan en vuelo a la vez: ninguno espera al otro.
  await until(() => checking && suggesting);
  // Con los tardíos pendientes el workspace ya está libre: un follow-up no da 409.
  expect((await post({ prompt: 'otro cambio', messageId: 'm2', parentId: 'm1' })).status).toBe(202);
  ideas.resolve([{ title: 'Logos', message: 'Añade logos' }]);
  check.resolve([]);
  const types = (await stream('m1')).map((e) => (e.type === 'step.end' || e.type === 'step.start' ? `${e.type}:${e.stepId}` : e.type));
  expect(types.indexOf('message.end')).toBeLessThan(types.indexOf('step.start:transport:preview-check'));
  expect(types.indexOf('snapshot')).toBeLessThan(types.indexOf('step.start:agent:suggestions'));
  expect(types.at(-1)).toBe('settled');
  expect(types.filter((t) => t === 'settled')).toHaveLength(1);
});

test('una corrida nueva en el workspace corta el preview-check tardío del anterior como superseded', async () => {
  const first = deferred<never[]>();
  let calls = 0;
  const { post, stream } = await setup(() => (calls++ === 0 ? first.promise : Promise.resolve([])), async () => null);
  await post({ prompt: 'landing', messageId: 'm1' });
  await until(() => calls === 1);
  await post({ prompt: 'otro cambio', messageId: 'm2', parentId: 'm1' });
  const old = await stream('m1');
  expect(old.find((e) => e.type === 'step.end' && e.stepId === 'transport:preview-check')).toMatchObject({ status: 'error', error: { type: 'superseded' } });
  expect(old.at(-1)?.type).toBe('settled');
  // El check de la versión vieja termina tarde y no escribe nada más en su log.
  first.resolve([]);
  expect((await stream('m2')).at(-1)?.type).toBe('settled');
  expect((await stream('m1')).filter((e) => e.type === 'step.end' && e.stepId === 'transport:preview-check')).toHaveLength(1);
});

// #402 medido en 78e0030b: el turno que solo preguntó corrió preview-check (5 s) y sus chips de respuesta los pisó una
// sugerencia con "[dato real]". v0 cierra ese turno con user-input-required, sin verificar.
test('un turno que preguntó sin escribir no corre preview-check ni sugerencias', async () => {
  let late = 0;
  const { post, stream } = await setup(async () => { late++; return []; }, async () => { late++; return null; }, []);
  await post({ prompt: 'cambia el titular del hero', messageId: 'm1' });
  const types = (await stream('m1')).map((e) => (e.type === 'step.start' ? `${e.type}:${e.stepId}` : e.type));
  expect(late).toBe(0);
  expect(types).not.toContain('step.start:transport:preview-check');
  expect(types.at(-1)).toBe('settled');
});

// Orq tras #405: v0 cierra la pregunta con user-input-required y sin versión; nosotros guardábamos un commit vacío.
test('un follow-up que preguntó no crea versión y la respuesta lo encuentra en el historial', async () => {
  const seen: ComposeRequest[] = [];
  const { post, stream, versions } = await setup(async () => [], async () => null, (n) => (n === 1 ? [] : ['src/App.tsx']), seen);
  await post({ prompt: 'landing', messageId: 'm1' });
  await stream('m1');
  await post({ prompt: 'cambia el titular del hero', messageId: 'm2', parentId: 'm1' });
  expect((await stream('m2')).find((e) => e.type === 'snapshot')).toMatchObject({ files: [] });
  expect(await versions('m1')).toEqual(['m1']);
  expect((await post({ prompt: 'Usa "Convierte cada conversación en una venta"', messageId: 'm3', parentId: 'm2' })).status).toBe(202);
  await stream('m3');
  expect(seen[2]?.history?.thread.find((t) => t.messageId === 'm2')?.summary).toBe('¿Qué titular quieres en el hero?');
  expect(await versions('m1')).toEqual(['m1', 'm3']);
});
