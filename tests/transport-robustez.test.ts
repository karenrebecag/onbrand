import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killChildren, liveChildren } from '../src/runtime/children';
import type { EngineEvent } from '../src/runtime/events';
import type { Allowlist, PageModel } from '../src/runtime/runner';
import { Runtime, type Composer } from '../src/runtime/server';
import { writeAgentPage } from './helpers/agent-compose';

const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};
const PAGE: PageModel = { sections: [{ role: 'hero', children: [{ component: 'hero' }] }] };

let tmp: string;
let server: Server;
let base: string;
let compose: Composer;
let rejections: unknown[];
const onRejection = (e: unknown): void => { rejections.push(e); };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'transport-robustez-'));
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  rejections = [];
  process.on('unhandledRejection', onRejection);
  compose = async () => PAGE;
  const t = new Runtime({ root: join(tmp, 'state'), allow, compose: async (req, log) => { const p = await compose(req, log); return p.agent ? p : writeAgentPage(req, p); }, agent: true, build: false, heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
  server = t.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
// El PATH de antes de prepender el bun falso: un test que vence su timeout abandona su función y su finally no corre;
// afterEach sí, y sin esto el resto de la suite lanzaba el bun falso.
const ORIGINAL_PATH = process.env.PATH;
afterEach(async () => {
  process.off('unhandledRejection', onRejection);
  process.env.PATH = ORIGINAL_PATH;
  server.close();
  await killChildren(0);
  rmSync(tmp, { recursive: true, force: true });
});

const post = (body: unknown) => fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const events = async (id: string): Promise<EngineEvent[]> =>
  (await (await fetch(`${base}/runs/${id}/events?cursor=-1`)).text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EngineEvent);

describe('transport: robustez de las corridas en proceso', () => {
  test('un log que deja de poder escribirse no tumba el proceso: la corrida cierra, el workspace se suelta y el servidor sigue', async () => {
    let broken: () => void = () => {};
    const done = new Promise<void>((r) => { broken = r; });
    compose = async () => {
      // El ndjson pasa a ser un directorio: cada emit posterior (el error de run y el settled) lanza EISDIR.
      const log = join(tmp, 'state', 'logs', 'm1.ndjson');
      rmSync(log);
      mkdirSync(log);
      broken();
      return PAGE;
    };
    expect((await post({ prompt: 'landing', messageId: 'm1' })).status).toBe(202);
    await done;
    compose = async () => PAGE;
    // Otro chat corre entero: el proceso sigue vivo y la corrida rota no dejó tomado el cupo.
    expect((await post({ prompt: 'otra', messageId: 'm2' })).status).toBe(202);
    expect((await events('m2')).at(-1)?.type).toBe('settled');
    expect(rejections).toEqual([]);
  });
});

describe('R1.2: la señal de la corrida llega a las tools', () => {
  test('/mcp: cerrar el turno aborta la imagen en vuelo; el generador recibe la señal y la tool responde error', async () => {
    const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
    let started = false;
    let aborted = false;
    let pending: Promise<{ result?: { isError?: boolean; content?: { text: string }[] } }> | undefined;
    const agentCompose: Composer = async (req) => {
      const origin = new URL(req.approval?.url as string).origin;
      const token = req.approval?.token as string;
      const args = { prompt: 'equipo', target_path: '/images/tarde.jpg' };
      await fetch(req.approval?.url as string, { method: 'POST', headers: { 'x-wt-approval-token': token }, body: JSON.stringify({ tool_name: 'mcp__wt__generate_image', input: args, tool_use_id: 'toolu_s' }) });
      pending = fetch(`${origin}/mcp/${req.messageId}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: args } }) }).then((r) => r.json() as never);
      while (!started) await new Promise((r) => setTimeout(r, 5));
      // El turno termina con la imagen todavía en el proveedor: el CLI ya no la espera.
      return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const gen = () => async (_p: string, _s: unknown, signal?: AbortSignal) => {
      started = true;
      await new Promise<never>((_, reject) => signal?.addEventListener('abort', () => { aborted = true; reject(new Error('abortado')); }, { once: true }));
      return { bytes: JPG, mediaType: 'image/jpeg' };
    };
    const t = new Runtime({ root: join(tmp, 'stateS'), allow: {}, compose: agentCompose, agent: true, build: false, imageModels: [{ id: 'img-1', name: 'Img', provider: 'test' }], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), imageService: { gen } });
    const s = t.listen(0);
    await new Promise((r) => s.once('listening', r));
    const at = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    try {
      await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 's1', imageGeneration: { modelId: 'img-1' } }) });
      await (await fetch(`${at}/runs/s1/events?cursor=-1`)).text();
      const out = await pending;
      expect(aborted).toBe(true);
      expect(out?.result).toMatchObject({ isError: true });
    } finally {
      s.close();
    }
  }, 20_000);
});

describe('R1.3: install y build sin bloquear el event loop', () => {
  test('mientras `bun install` corre, el transport sigue atendiendo; al terminar, la corrida sigue', async () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const release = join(tmp, 'release');
    const started = join(tmp, 'started');
    // Un `bun` falso: avisa que arrancó y espera a que el test lo suelte. Con spawnSync el GET de abajo no respondía nunca.
    // Con tope (~30 s): si el test cae antes de soltarlo, afterEach borra tmp y el release ya no llegaría nunca.
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\ntouch "${started}"\ni=0; while [ ! -f "${release}" ] && [ $i -lt 1500 ]; do sleep 0.02; i=$((i+1)); done\nmkdir -p node_modules\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    writeFileSync(join(tmp, 'scaffold', 'package.json'), '{"name":"ws","private":true}\n');
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      expect((await post({ prompt: 'landing', messageId: 'i1' })).status).toBe(202);
      for (let i = 0; !existsSync(started); i++) {
        if (i >= 500) throw new Error('el install de i1 no arrancó');
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((await fetch(`${base}/models`)).status).toBe(200);
      writeFileSync(release, '');
      const evs = await events('i1');
      expect(evs.find((e) => e.type === 'step.end' && e.stepId === 'transport:install')).toMatchObject({ status: 'ok' });
      expect(evs.some((e) => e.type === 'snapshot')).toBe(true);
      expect(liveChildren()).toBe(0);
    } finally {
      process.env.PATH = path;
      await killChildren(0);
    }
  });

  test('un install que falla a mitad deja node_modules pero no lo da por hecho: el siguiente turno del mismo workspace reinstala', async () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    // Con el agente cada turno instala antes del compose (con reintento) y materialize reinstala después: el número de
    // invocaciones de bun por turno no es fijo. Un flag en disco decide el fallo por turno, robusto a ese conteo: mientras
    // exista, TODO install del turno deja node_modules a medias y sale con error; sin él, termina.
    const fail = join(tmp, 'FAIL');
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nmkdir -p node_modules\nif [ -f "${fail}" ]; then exit 1; fi\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    writeFileSync(join(tmp, 'scaffold', 'package.json'), '{"name":"ws","private":true}\n');
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    const install = async (id: string) => (await events(id)).find((e) => e.type === 'step.end' && e.stepId === 'transport:install');
    try {
      await post({ prompt: 'landing', messageId: 'n1' });
      expect(await install('n1')).toMatchObject({ status: 'ok' });
      // Se pierden las dependencias del workspace; el install siguiente se corta a mitad.
      rmSync(join(tmp, 'state', 'ws', 'n1', 'node_modules'), { recursive: true, force: true });
      writeFileSync(fail, '');
      await post({ prompt: 'b', messageId: 'n2', parentId: 'n1' });
      expect(await install('n2')).toMatchObject({ status: 'error' });
      // Antes, el node_modules a medias contaba como instalado y este turno se saltaba el install.
      rmSync(fail);
      await post({ prompt: 'c', messageId: 'n3', parentId: 'n1' });
      expect(await install('n3')).toMatchObject({ status: 'ok' });
      await post({ prompt: 'd', messageId: 'n4', parentId: 'n3' });
      expect(await install('n4')).toBeUndefined();
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('R1.6: plazo de las tools del /mcp por señal', () => {
  test('typecheck que pasa su plazo se corta: el CLI recibe un error de tool, la señal llega a tsc y la siguiente tool corre', async () => {
    let tscSignal: AbortSignal | undefined;
    const replies: { isError?: boolean; content?: { text: string }[] }[] = [];
    const agentCompose: Composer = async (req) => {
      const origin = new URL(req.approval?.url as string).origin;
      const call = async (n: number) => (await (await fetch(`${origin}/mcp/${req.messageId}`, { method: 'POST', headers: { authorization: `Bearer ${req.approval?.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'typecheck', arguments: {} } }) })).json() as { result: (typeof replies)[number] }).result;
      replies.push(await call(1));
      replies.push(await call(2));
      return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: 'Listo', missing: [], suggestions: [] } };
    };
    let calls = 0;
    // El primer tsc se cuelga hasta que lo aborten (como un tsc que no termina); el segundo responde.
    const tsc = (_dir: string, signal?: AbortSignal) => {
      calls += 1;
      if (calls > 1) return '';
      tscSignal = signal;
      return new Promise<string>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('abortado')), { once: true }));
    };
    const t = new Runtime({ root: join(tmp, 'stateW'), allow: {}, compose: agentCompose, agent: true, build: false, heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), tsc, toolDeadlines: { mcp__wt__typecheck: 100 } });
    const s = t.listen(0);
    await new Promise((r) => s.once('listening', r));
    const at = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    try {
      await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'w1' }) });
      await (await fetch(`${at}/runs/w1/events?cursor=-1`)).text();
      expect(replies[0]).toMatchObject({ isError: true });
      expect(replies[0]?.content?.[0]?.text).toContain('sin respuesta en 0 s; se cortó');
      expect(tscSignal?.aborted).toBe(true);
      expect(replies[1]?.isError).toBeFalsy();
    } finally {
      s.close();
    }
  });
});


describe('R2.1: arranque limpio', () => {
  test('lo que dejó un turno fallido no entra al siguiente turno ni al commit de un restore; .wt queda', async () => {
    const ws = join(tmp, 'state', 'ws', 'c1');
    let seenJunk: boolean | undefined;
    await post({ prompt: 'landing', messageId: 'c1' });
    await events('c1');
    // Turno fallido sobre c1: deja un archivo nuevo, toca uno versionado y muere sin versión (como un CLI sin result).
    compose = async () => {
      writeFileSync(join(ws, 'src', 'basura.tsx'), 'export {}\n');
      writeFileSync(join(ws, 'src', 'App.tsx'), '// a medias\n');
      mkdirSync(join(ws, '.wt'), { recursive: true });
      writeFileSync(join(ws, '.wt', 'canvas.json'), '{}');
      throw new Error('claude-code: salió sin resultado');
    };
    await post({ prompt: 'b', messageId: 'c2', parentId: 'c1' });
    expect((await events('c2')).some((e) => e.type === 'message.end')).toBe(true);
    compose = async () => {
      seenJunk = existsSync(join(ws, 'src', 'basura.tsx')) || readFileSync(join(ws, 'src', 'App.tsx'), 'utf8') === '// a medias\n';
      return PAGE;
    };
    await post({ prompt: 'c', messageId: 'c3', parentId: 'c1' });
    await events('c3');
    expect(seenJunk).toBe(false);
    // El estado de .wt (lienzo) no es de la versión: sobrevive a la limpieza.
    expect(existsSync(join(ws, '.wt', 'canvas.json'))).toBe(true);
    // Restore: un archivo suelto en el árbol no entra al commit de la versión restaurada.
    writeFileSync(join(ws, 'suelto.txt'), 'x');
    await post({ restoreFrom: 'c1', messageId: 'c4' });
    const snap = (await events('c4')).find((e) => e.type === 'snapshot') as Extract<EngineEvent, { type: 'snapshot' }> | undefined;
    expect(snap).toBeDefined();
    expect(existsSync(join(ws, 'suelto.txt'))).toBe(false);
  });
});

describe('QA: sin escrituras se mide contra el padre, no contra HEAD', () => {
  test('follow-up sobre una versión que no es HEAD que falla sin escribir no guarda una versión idéntica a la del padre', async () => {
    const ws = join(tmp, 'state', 'ws', 'q1');
    await post({ prompt: 'landing', messageId: 'q1' });
    await events('q1');
    // q2 falla CON escrituras: queda versionada y HEAD se mueve a ella.
    compose = async () => {
      writeFileSync(join(ws, 'src', 'extra.tsx'), 'export {}\n');
      throw new Error('claude-code: salió sin resultado');
    };
    await post({ prompt: 'b', messageId: 'q2', parentId: 'q1' });
    expect((await events('q2')).some((e) => e.type === 'snapshot')).toBe(true);
    // q3 cuelga de q1 (restoreTree al padre, HEAD queda en q2) y falla sin escribir: no hay nada que versionar.
    compose = async () => { throw new Error('claude-code: salió sin resultado'); };
    await post({ prompt: 'c', messageId: 'q3', parentId: 'q1' });
    const evs = await events('q3');
    expect(evs.some((e) => e.type === 'message.end')).toBe(true);
    expect(evs.some((e) => e.type === 'snapshot')).toBe(false);
  });
});
