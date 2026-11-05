import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '../src/runtime/events';
import type { Allowlist } from '../src/runtime/runner';
import { Runtime, type Composer } from '../src/runtime/server';

const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};
const tmp = mkdtempSync(join(tmpdir(), 'wt-ds-origin-'));
let server: Server | undefined;
let base: string;
afterEach(() => { server?.close(); rmSync(tmp, { recursive: true, force: true }); });

const post = (body: unknown) => fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const events = async (id: string): Promise<EngineEvent[]> => (await (await fetch(`${base}/runs/${id}/events?cursor=-1`)).text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EngineEvent);

// B9 paso 4: un chat construido con Arc no cruza al DS base con "Actualizar DS" cuando el core cambia de default: pisaría su
// layout y dejaría secciones importando componentes que el pin del base no trae.
test('updateDs no cruza de DS: un chat de arc-agent, con el default ya en base-agent, recibe 409 y el ds del chat lo dice', async () => {
  const compose: Composer = async (req) => {
    writeFileSync(join(req.workspace?.dir as string, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
    return { sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } };
  };
  const scaffold = join(tmp, 'scaffold-origin');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  let latest = 'arc00001';
  const registry = async (pin?: string) => {
    const at = pin ?? latest;
    return { pin: at, getItem: async () => ({ name: 'button', files: [{ path: 'src/components/arc/button/button.tsx', content: `export const Button = () => '${at}';\n` }] }), loadIndex: async () => ({ button: {} as never }) };
  };
  const root = join(tmp, 'state-origin');
  const t = new Runtime({ root, allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), registry });
  const s = t.listen(0);
  server = s;
  await new Promise((r) => s.once('listening', r));
  base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const prev = process.env.WT_AGENT_SKILL;
  process.env.WT_AGENT_SKILL = 'arc-agent';
  try {
    await post({ prompt: 'landing', messageId: 'o1' });
    await events('o1');
    expect(JSON.parse(readFileSync(join(root, 'ws', 'o1', 'request.json'), 'utf8'))).toMatchObject({ registryPin: 'arc00001', dsSkill: 'arc-agent' });
    // El core pasa al DS base: otro skill y otro latest.
    delete process.env.WT_AGENT_SKILL;
    latest = 'base0001';
    const res = await post({ updateDs: true, parentId: 'o1', messageId: 'o2' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('arc-agent');
    const { ds } = (await (await fetch(`${base}/chats/o1`)).json()) as { ds?: unknown };
    expect(ds).toEqual({ pin: 'arc00001', skill: 'arc-agent', latest: 'base0001', latestSkill: 'base-agent' });
  } finally {
    if (prev === undefined) delete process.env.WT_AGENT_SKILL;
    else process.env.WT_AGENT_SKILL = prev;
  }
});


// Un follow-up de ese chat abre el pin de Arc: con el skill del default (base-agent) el agente leería otro catálogo, y la
// versión quedaría registrada como del base, que es lo que dejaría a "Actualizar DS" cruzar de DS.
test('un follow-up de un chat de arc-agent sigue con arc-agent aunque el default sea base-agent', async () => {
  const compose: Composer = async (req) => {
    writeFileSync(join(req.workspace?.dir as string, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
    return { sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } };
  };
  const scaffold = join(tmp, 'scaffold-follow');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  const asked: string[] = [];
  const registry = async (pin?: string) => ({
    pin: pin ?? 'arc00001',
    getItem: async () => ({ name: 'button', files: [{ path: 'src/components/arc/button/button.tsx', content: 'export const Button = () => null;\n' }] }),
    loadIndex: async () => ({ button: {} as never }),
    skillPack: async (id: string) => { asked.push(id); return undefined; },
  });
  const root = join(tmp, 'state-follow');
  const t = new Runtime({ root, allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), registry });
  const s = t.listen(0);
  server = s;
  await new Promise((r) => s.once('listening', r));
  base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const prev = process.env.WT_AGENT_SKILL;
  process.env.WT_AGENT_SKILL = 'arc-agent';
  try {
    await post({ prompt: 'landing', messageId: 'f1' });
    await events('f1');
    delete process.env.WT_AGENT_SKILL;
    asked.length = 0;
    await post({ prompt: 'cambia el título', messageId: 'f2', parentId: 'f1' });
    await events('f2');
    expect(asked).toEqual(['arc-agent']);
    expect(JSON.parse(readFileSync(join(root, 'ws', 'f1', 'request.json'), 'utf8'))).toMatchObject({ registryPin: 'arc00001', dsSkill: 'arc-agent' });
  } finally {
    if (prev === undefined) delete process.env.WT_AGENT_SKILL;
    else process.env.WT_AGENT_SKILL = prev;
  }
});

// QA B9 paso 4 (serve.ts --fixture, en vivo): en core el registry/ del base no tiene los pins de Arc (ds-base-neutral.md:181,
// "el de Arc sale con la distro"). El follow-up de un chat de Arc respondía 202 y el turno fallaba después con "falta
// index@<pin>… regenéralo con build-registry --local", continuable:false. Como updateDs, tiene que negarse antes de abrir
// la corrida y decir por qué.
test('un follow-up de un chat de arc-agent sin su registry en este proceso da 409 antes de abrir la corrida', async () => {
  const compose: Composer = async (req) => {
    writeFileSync(join(req.workspace?.dir as string, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
    return { sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } };
  };
  const scaffold = join(tmp, 'scaffold-gone');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  let latest = 'arc00001';
  const registry = async (pin?: string) => {
    if (pin && pin !== latest) throw new Error(`registry: falta index@${pin}.json`);
    const at = pin ?? latest;
    return { pin: at, getItem: async () => ({ name: 'button', files: [{ path: 'src/components/arc/button/button.tsx', content: 'export const Button = () => null;\n' }] }), loadIndex: async () => ({ button: {} as never }) };
  };
  const root = join(tmp, 'state-gone');
  const t = new Runtime({ root, allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), registry });
  const s = t.listen(0);
  server = s;
  await new Promise((r) => s.once('listening', r));
  base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const prev = process.env.WT_AGENT_SKILL;
  process.env.WT_AGENT_SKILL = 'arc-agent';
  try {
    await post({ prompt: 'landing', messageId: 'g1' });
    await events('g1');
    delete process.env.WT_AGENT_SKILL;
    latest = 'base0001';
    const res = await post({ prompt: 'cambia el título', messageId: 'g2', parentId: 'g1' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('arc-agent');
    expect((await fetch(`${base}/runs/g2`)).status).toBe(404);
  } finally {
    if (prev === undefined) delete process.env.WT_AGENT_SKILL;
    else process.env.WT_AGENT_SKILL = prev;
  }
});
