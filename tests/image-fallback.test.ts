import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentComposer } from '../src/runtime/agent-composer';
import type { RunAgentCli } from '../src/runtime/agent-loop';
import { bytesMatchType } from '../src/runtime/image-replace';
import { IMAGE_TOOL } from '../src/runtime/image-tool';
import { MAX_PENDING_IMAGES } from '../src/runtime/image-fallback';
import type { EngineEvent } from '../src/runtime/events';
import { runWorkspaceTool } from '../src/runtime/workspace-tools';

let tmp: string;
let skill: string;
let ws: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'image-fallback-'));
  skill = join(tmp, 'skill');
  mkdirSync(join(skill, 'references'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# skill\n');
  ws = join(tmp, 'ws');
  mkdirSync(join(ws, 'src', 'sections'), { recursive: true });
  mkdirSync(join(ws, 'public', 'images'), { recursive: true });
  writeFileSync(join(ws, 'index.html'), '<!doctype html><html lang="es"><head><title>x</title></head><body></body></html>');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const silent = { emit: () => {} } as never;

/** El agente escribe la sección con un src cuya imagen el generador no entregó (cupo agotado), y otra que sí existe. */
const runWriting = (jsx: string): RunAgentCli => async (_bin, _args, _input, cwd, onLine) => {
  const hero = join(cwd, 'src', 'sections', '01-hero.tsx');
  writeFileSync(hero, jsx);
  onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: hero } }] } }));
  onLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } }));
  onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'Resumen.', session_id: 's' }));
  return 0;
};

describe('§18 fallback sin imagen', () => {
  test('generate_image falla: la tool dice que no se escriba el src, y el turno deja placeholder válido y el slot pendiente', async () => {
    const tool = await runWorkspaceTool(IMAGE_TOOL, { prompt: 'a', target_path: '/images/hero.jpg' }, { dir: ws, previews: { ensure: async () => ({ url: 'http://x' }) }, imageGen: async () => { throw new Error('403 TOP_UP'); } });
    expect(tool.ok === false && tool.error).toContain('no escribas src="/images/hero.jpg"');

    writeFileSync(join(ws, 'public', 'images', 'logo.png'), 'real');
    const jsx = 'export default () => <section><img src="/images/hero.jpg" /><img src={"/images/logo.png"} /><div style={{ backgroundImage: "url(/images/bg.webp)" }} /></section>;\n';
    const page = await createAgentComposer(skill, { run: runWriting(jsx) })({ prompt: 'landing', messageId: 'm1', workspace: { dir: ws } }, silent);

    expect(page.agent?.images).toEqual({ pending: ['/images/bg.webp', '/images/hero.jpg'] });
    expect(bytesMatchType('image/jpeg', readFileSync(join(ws, 'public', 'images', 'hero.jpg')))).toBe(true);
    expect(bytesMatchType('image/webp', readFileSync(join(ws, 'public', 'images', 'bg.webp')))).toBe(true);
    expect(readFileSync(join(ws, 'public', 'images', 'logo.png'), 'utf8')).toBe('real');
    expect(readFileSync(join(ws, 'src', 'sections', '01-hero.tsx'), 'utf8')).toBe(jsx);

    // El turno siguiente: hero.jpg sigue siendo placeholder y sigue pendiente; bg.webp ya se generó y sale.
    writeFileSync(join(ws, 'public', 'images', 'bg.webp'), 'generada');
    const next = await createAgentComposer(skill, { run: runWriting(jsx) })({ prompt: 'otro título', messageId: 'm2', workspace: { dir: ws }, parentPage: page }, silent);
    expect(next.agent?.images).toEqual({ pending: ['/images/hero.jpg'] });
  });

  test('más referencias que el tope: solo MAX_PENDING_IMAGES placeholders y pendientes', async () => {
    const imgs = Array.from({ length: MAX_PENDING_IMAGES + 8 }, (_, i) => `<img src="/images/g-${String(i).padStart(2, '0')}.jpg" />`).join('');
    const page = await createAgentComposer(skill, { run: runWriting(`export default () => <section>${imgs}</section>;\n`) })({ prompt: 'galería', messageId: 'm1', workspace: { dir: ws } }, silent);
    expect(page.agent?.images?.pending).toHaveLength(MAX_PENDING_IMAGES);
    expect(readdirSync(join(ws, 'public', 'images'))).toHaveLength(MAX_PENDING_IMAGES);
  });

  test('public/images no escribible: el turno cierra igual, la ruta no queda pendiente y el error queda en el log', async () => {
    chmodSync(join(ws, 'public', 'images'), 0o555);
    const evs: EngineEvent[] = [];
    try {
      const page = await createAgentComposer(skill, { run: runWriting('export default () => <img src="/images/hero.jpg" />;\n') })({ prompt: 'landing', messageId: 'm1', workspace: { dir: ws } }, { emit: (e: EngineEvent) => evs.push(e) } as never);
      expect(page.agent?.images).toBeUndefined();
      expect(existsSync(join(ws, 'public', 'images', 'hero.jpg'))).toBe(false);
      const end = evs.find((e) => e.type === 'step.end' && e.stepId === 'agent:image-fallback');
      expect(end?.type === 'step.end' && [end.status, end.error?.type]).toEqual(['error', 'image-fallback']);
    } finally {
      chmodSync(join(ws, 'public', 'images'), 0o755);
    }
  });

  test('con heredados en el tope las nuevas solo llenan lo que falta: ningún placeholder queda fuera de pending', async () => {
    const refs = (from: number, n: number) => Array.from({ length: n }, (_, i) => `<img src="/images/g-${String(from + i).padStart(2, '0')}.jpg" />`).join('');
    const first = await createAgentComposer(skill, { run: runWriting(`export default () => <section>${refs(0, 30)}</section>;\n`) })({ prompt: 'galería', messageId: 'm1', workspace: { dir: ws } }, silent);
    expect(first.agent?.images?.pending).toHaveLength(30);
    const next = await createAgentComposer(skill, { run: runWriting(`export default () => <section>${refs(0, 40)}</section>;\n`) })({ prompt: 'más fotos', messageId: 'm2', workspace: { dir: ws }, parentPage: first }, silent);
    const pending = next.agent?.images?.pending ?? [];
    expect(pending).toHaveLength(MAX_PENDING_IMAGES);
    expect(readdirSync(join(ws, 'public', 'images')).map((f) => `/images/${f}`).sort()).toEqual([...pending].sort());
  });
});
