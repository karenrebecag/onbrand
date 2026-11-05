import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Suggestion } from '../src/runtime/events';
import { Runtime, type Composer } from '../src/runtime/server';
import type { SectionSuggestHook } from '../src/runtime/agent-composer';

// Ola 1 B: las ideas de una sección se piden al elegirla, como Stitch por pantalla
// (stitch-ui/deob/webcrack/DesignPage-DeNbrR8l/deobfuscated.js:8472-8486), no en cada turno.

let tmp: string;
let srv: Server | undefined;
afterEach(() => { srv?.close(); srv = undefined; rmSync(tmp, { recursive: true, force: true }); });

async function setup(suggestSection?: SectionSuggestHook) {
  tmp = mkdtempSync(join(tmpdir(), 'v0-sec-'));
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  mkdirSync(join(tmp, 'vault'));
  const base = (async (req) => {
    const dir = req.workspace?.dir as string;
    mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
    writeFileSync(join(dir, 'src', 'sections', '02-hero.tsx'), 'export function Hero() { return <section data-wt-slug="02-hero">Hola</section>; }\n');
    return { sections: [], page: { lang: 'en' }, agent: { files: ['src/sections/02-hero.tsx'], summary: 'ok', missing: [], suggestions: [] } };
  }) satisfies Composer;
  const compose = suggestSection ? Object.assign(base, { suggestSection }) : base;
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
  srv = t.listen(0);
  await new Promise((r) => srv!.once('listening', r));
  const at = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing de Nimbus', messageId: 'm1' }) });
  await (await fetch(`${at}/runs/m1/events`)).text();
  return (slug: string) => fetch(`${at}/runs/m1/sections/${slug}/suggestions`, { method: 'POST', headers: { 'content-type': 'application/json' } });
}

test('una llamada por sección y versión: lee la sección del commit, la segunda petición sale de cache y en vuelo es 409', async () => {
  const seen: Parameters<SectionSuggestHook>[0][] = [];
  let release!: (v: Suggestion[]) => void;
  const ask = await setup((input) => { seen.push(input); return new Promise((r) => { release = r; }); });
  const first = ask('02-hero');
  while (!seen.length) await new Promise((r) => setTimeout(r, 5));
  expect((await ask('02-hero')).status).toBe(409);
  release([{ title: 'Video', message: 'Pon un video de fondo' }]);
  expect(await (await first).json()).toEqual({ suggestions: [{ title: 'Video', message: 'Pon un video de fondo' }] });
  expect(await (await ask('02-hero')).json()).toEqual({ suggestions: [{ title: 'Video', message: 'Pon un video de fondo' }] });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ prompt: 'landing de Nimbus', lang: 'en', slug: '02-hero', role: 'hero' });
  expect(seen[0].source).toContain('data-wt-slug="02-hero"');
  expect((await ask('09-nada')).status).toBe(404);
  expect((await ask('..%2Fpage')).status).toBe(400);
});

test('si el modelo falla es 502 y se puede volver a pedir; sin modelo de sugerencias es 503', async () => {
  let calls = 0;
  const ask = await setup(async () => { calls += 1; if (calls === 1) throw new Error('429'); return []; });
  expect((await ask('02-hero')).status).toBe(502);
  expect((await ask('02-hero')).status).toBe(200);
  srv?.close();
  rmSync(tmp, { recursive: true, force: true });
  expect((await (await setup())('02-hero')).status).toBe(503);
});
