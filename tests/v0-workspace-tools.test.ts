import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAll, initRepo } from '../src/runtime/git-workspace';
import { toMcpContent, workspaceMcpConfig } from '../src/runtime/workspace-mcp';
import { segmentsOf, viewportClip } from '../src/runtime/browser';
import { describeInBatches, formatExtent, formatOverflow, formatTypecheck, withDeadline, parseBrowseInput, parseTscOutput, runTsc, runWorkspaceTool, type WorkspaceToolContext } from '../src/runtime/workspace-tools';

const TSC = [
  "src/sections/02-hero.tsx(4,10): error TS2305: Module '\"@/components/arc/button\"' has no exported member 'Buton'.",
  "src/components/arc/blocks/site-header/site-header.tsx(5,19): error TS2307: Cannot find module 'next/image' or its corresponding type declarations.",
].join('\n');

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-ws-tools-'));
  mkdirSync(join(dir, 'src', 'components'), { recursive: true });
  writeFileSync(join(dir, 'src', 'components', 'lib.ts'), 'export const x = 1;\n');
  initRepo(dir);
  commitAll(dir, 'base: scaffold');
  mkdirSync(join(dir, 'src', 'sections'));
  writeFileSync(join(dir, 'src', 'sections', '02-hero.tsx'), 'export default () => null;\n');
  return dir;
}

describe('typecheck', () => {
  test('separa los errores de los archivos de la página de los de la librería', () => {
    const errors = parseTscOutput(TSC);
    expect(errors.map((e) => e.code)).toEqual(['TS2305', 'TS2307']);
    const text = formatTypecheck(errors, new Set(['src/sections/02-hero.tsx']));
    expect(text).toContain('1 errores en tus archivos:');
    expect(text).toContain("src/sections/02-hero.tsx(4,10): TS2305");
    expect(text).toContain('1 errores en la librería del DS');
    expect(text).not.toContain('site-header');
  });

  // C4 (Lovable ZAP 1854: log del dev server + curl, sin build): un archivo de la página que vite no transforma es un
  // error del agente; lo que vite registró mientras escribía no.
  test('typecheck compila en el dev server cada archivo de la página y cuenta sus errores', async () => {
    const dir = workspace();
    const asked: string[] = [];
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const path = new URL(req.url).pathname;
      asked.push(path);
      return path === '/src/sections/02-hero.tsx' ? new Response('\n[plugin:vite:import-analysis] Failed to resolve import "./nope"', { status: 500 }) : new Response('ok');
    } });
    let drains = 0;
    const previews = { ensure: async () => ({ url: `http://127.0.0.1:${server.port}/` }), drainErrors: () => (drains++ === 0 ? ['Error al cargar 02-hero a medio escribir'] : []) };
    try {
      const r = await runWorkspaceTool('typecheck', {}, { dir, previews, tsc: () => '' });
      const text = r.ok && r.content[0].type === 'text' ? r.content[0].text : '';
      expect(asked).toEqual(['/src/sections/02-hero.tsx']);
      expect(text.startsWith('1 errores en tus archivos:')).toBe(true);
      expect(text).toContain('src/sections/02-hero.tsx: [plugin:vite:import-analysis] Failed to resolve import "./nope"');
      expect(text).not.toContain('a medio escribir');
    } finally {
      server.stop(true);
    }
  });

  test('el DS que el registry montó después del commit base no cuenta como de la página', async () => {
    const dir = workspace();
    mkdirSync(join(dir, 'src', 'components', 'arc', 'blocks', 'site-header'), { recursive: true });
    writeFileSync(join(dir, 'src', 'components', 'arc', 'blocks', 'site-header', 'site-header.tsx'), 'export {};\n');
    mkdirSync(join(dir, '.wt'));
    writeFileSync(join(dir, '.wt', 'ds@abc'), 'src/components/arc/blocks/site-header/site-header.tsx\n');
    const r = await runWorkspaceTool('typecheck', {}, { dir, previews: { ensure: async () => ({ url: '' }) }, tsc: () => TSC });
    const text = r.ok && r.content[0].type === 'text' ? r.content[0].text : '';
    expect(text).toContain('1 errores en tus archivos:');
    expect(text).toContain('1 errores en la librería del DS');
  });

  test('un archivo que el turno escribió y no commiteó cuenta como de la página', async () => {
    const dir = workspace();
    const r = await runWorkspaceTool('typecheck', {}, { dir, previews: { ensure: async () => ({ url: '' }) }, tsc: () => TSC });
    expect(r.ok && r.content[0].type === 'text' && r.content[0].text.startsWith('1 errores en tus archivos:')).toBe(true);
  });

  test('sin pack, la revisión de tipos también pide declarar la identidad; con pack sin tocar, no', async () => {
    const run = async (dir: string): Promise<string> => {
      const r = await runWorkspaceTool('typecheck', {}, { dir, previews: { ensure: async () => ({ url: '' }) }, tsc: () => '' });
      return r.ok && r.content[0].type === 'text' ? r.content[0].text : '';
    };
    const ws = workspace();
    writeFileSync(join(ws, 'src', 'sections', '02-hero.module.css'), '.hero { background: var(--surface-muted); }');
    const out = await run(ws);
    expect(out).toContain('sin marca: declara la identidad');
    // live6: un token inventado cae a transparente y la banda no se pinta; se avisa con los tipos.
    expect(out).toContain('--surface-muted (02-hero.module.css)');
    // applyBrand escribe la hoja antes del commit base: no es un cambio del turno.
    const packed = mkdtempSync(join(tmpdir(), 'wt-ws-tools-'));
    mkdirSync(join(packed, 'src'));
    writeFileSync(join(packed, 'src', 'identity.css'), '/* brand-pack: Acme */\n');
    initRepo(packed);
    commitAll(packed, 'base: scaffold + marca Acme');
    expect(await run(packed)).toContain('Identidad: marca del pack, sin cambios.');
  });

  test('la marca del registry, aplicada después del scaffold y commiteada con el DS, no cuenta como edición del agente', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'src', 'identity.css'), '/* brand-pack: Acme */\n');
    commitAll(dir, 'base: ds@ef22ae5146743402');
    writeFileSync(join(dir, 'src', 'sections', '03-faq.tsx'), 'export default () => null;\n');
    const r = await runWorkspaceTool('typecheck', {}, { dir, previews: { ensure: async () => ({ url: '' }) }, tsc: () => '' });
    const out = r.ok && r.content[0].type === 'text' ? r.content[0].text : '';
    expect(out).toContain('Identidad: marca del pack, sin cambios.');
    expect(out).not.toContain('no la edites');
  });
});

describe('browser', () => {
  test('valida viewport y acciones; full por defecto en los dos viewports', () => {
    expect(parseBrowseInput({ viewport: 1024 }).ok).toBe(false);
    expect(parseBrowseInput({ viewport: 375, actions: [{ click: { role: 'div', name: 'x' } }] }).ok).toBe(false);
    expect(parseBrowseInput({ viewport: 375, actions: [{ text: 'a"; } body { x' }] }).ok).toBe(false);
    expect(parseBrowseInput({ viewport: 1440 })).toEqual({ ok: true, value: { viewport: 1440, full: true, actions: [] } });
    // La primera llamada del agente, antes de cargar el esquema diferido (corrida live1 de orq).
    expect(parseBrowseInput({ width: '1440', fullPage: 'true' })).toEqual({ ok: true, value: { viewport: 1440, full: true, actions: [] } });
    expect(parseBrowseInput({ viewport: '375', full: 'yes' }).ok).toBe(false);
    expect(parseBrowseInput({ viewport: 375, actions: [{ click: { role: 'tab', name: 'Monthly' } }, { text: '.pricing-grid' }] })).toEqual({ ok: true, value: { viewport: 375, full: true, actions: [{ click: { role: 'tab', name: 'Monthly' } }, { text: '.pricing-grid' }] } });
  });

  const shotCtx = (describe?: WorkspaceToolContext['describe'], extra: Partial<WorkspaceToolContext> = {}): WorkspaceToolContext => ({
    dir: workspace(),
    previews: { ensure: async () => ({ url: 'http://127.0.0.1:5310/' }), drainErrors: () => ['[vite] Internal server error: Transform failed'] },
    browse: async () => ({ pngs: [Buffer.from('png'), Buffer.from('png2')], pageHeight: 1700, shownHeight: 1700, from: 0, issues: [{ kind: 'pageerror', message: 'stats.some is not a function', source: 'at http://127.0.0.1:5310/src/sections/02-hero.tsx:3:1', viewport: 1440 }], mounted: [], texts: [], actionErrors: [], overflow: { scrollWidth: 1440, clientWidth: 1440, offenders: [] } }),
    ...(describe ? { describe } : {}),
    ...extra,
  });

  // Audit-2: las capturas releídas en cada llamada eran ~448 k tokens en V4; el agente recibe solo texto.
  test('devuelve en texto los errores atribuidos a la sección y los del dev server, sin imágenes', async () => {
    const r = await runWorkspaceTool('browser', { viewport: 1440 }, shotCtx());
    if (!r.ok) throw new Error(r.error);
    expect(r.content.every((b) => b.type === 'text')).toBe(true);
    const text = r.content[0].type === 'text' ? r.content[0].text : '';
    expect(text).toContain('pageerror 02-hero: stats.some is not a function');
    expect(text).toContain('unmounted 02-hero');
    expect(text).toContain('[vite] Internal server error');
    expect(text).toContain('Sin desborde horizontal (scrollWidth 1440 = clientWidth 1440).');
    expect(text).toContain('Captura a 1440 px: 2 tramos de arriba abajo, en orden. Página completa (1700 px).');
  });

  // Lovable vision--describe_image (lov1358 offset 74667): capturas + pregunta concreta, respuesta en texto.
  test('con question, el modelo de visión recibe todos los tramos y su respuesta vuelve como texto', async () => {
    const seen: { n: number; q: string }[] = [];
    const r = await runWorkspaceTool('browser', { viewport: 1440, question: '¿Se superpone algo en el hero?' }, shotCtx(async (pngs, q) => { seen.push({ n: pngs.length, q }); return 'El titular del hero tapa el botón principal.'; }));
    if (!r.ok) throw new Error(r.error);
    expect(seen).toEqual([{ n: 2, q: '¿Se superpone algo en el hero?' }]);
    expect(r.content).toHaveLength(1);
    const text = r.content[0].type === 'text' ? r.content[0].text : '';
    expect(text).toContain('pageerror 02-hero');
    expect(text).toMatch(/Respuesta visual \(\d+\.\d s\): El titular del hero tapa el botón principal\./);
  });

  test('si el modelo de visión falla, la medición vuelve igual y dice que no hubo respuesta', async () => {
    const r = await runWorkspaceTool('browser', { viewport: 375, question: '¿Cabe el precio?' }, shotCtx(async () => { throw new Error('429 rate limit'); }));
    if (!r.ok) throw new Error(r.error);
    const text = r.content[0].type === 'text' ? r.content[0].text : '';
    expect(text).toContain('Sin desborde horizontal');
    expect(text).toMatch(/Sin respuesta visual \(\d+\.\d s\): 429 rate limit/);
  });

  test('toMcpContent traduce una imagen al formato de MCP', () => {
    expect(toMcpContent([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } }])).toEqual([{ type: 'image', data: 'cG5n', mimeType: 'image/png' }]);
  });

  // #403 medido: la visión a 1440 pasó los 120 s y el CLI cortó la tool MCP; el agente perdió también la medición.
  test('una visión que no responde a tiempo no tumba la tool: vuelven errores y desborde', async () => {
    const r = await runWorkspaceTool('browser', { viewport: 1440, question: '¿Se superpone algo?' }, shotCtx(() => new Promise(() => {}), { visionMaxMs: 50 }));
    if (!r.ok) throw new Error(r.error);
    const text = r.content[0].type === 'text' ? r.content[0].text : '';
    expect(text).toContain('pageerror 02-hero');
    expect(text).toMatch(/Sin respuesta visual \(\d+\.\d s\): sin respuesta en 0 s/);
  });

  test('la visión pide la captura a escala reducida (0,5 a 1440, 0,75 a 375); sin pregunta, a escala 1', async () => {
    const scales: (number | undefined)[] = [];
    const ctx = (): WorkspaceToolContext => {
      const c = shotCtx(async () => 'ok');
      const browse = c.browse!;
      return { ...c, browse: async (req) => { scales.push(req.scale); return browse(req); } };
    };
    await runWorkspaceTool('browser', { viewport: 1440, question: '¿Cabe?' }, ctx());
    await runWorkspaceTool('browser', { viewport: 375, question: '¿Cabe?' }, ctx());
    await runWorkspaceTool('browser', { viewport: 1440 }, ctx());
    expect(scales).toEqual([0.5, 0.75, undefined]);
  });

  // 024b517c: 13 tramos a 375 tardaron 25,2 s contra 13,5 s de 8 a 1440.
  test('más de 7 tramos van en lotes paralelos con su rango; un lote caído no borra los otros', async () => {
    const calls: { n: number; q: string }[] = [];
    let open = 0;
    let peak = 0;
    const describe: NonNullable<WorkspaceToolContext['describe']> = async (pngs, q) => {
      calls.push({ n: pngs.length, q }); open++; peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 20));
      open--;
      if (q.includes('tramos 8-13')) throw new Error('529 overloaded');
      return 'el FAQ se ve bien';
    };
    const pngs = Array.from({ length: 13 }, (_, i) => Buffer.from(String(i)));
    const out = await describeInBatches(describe, pngs, '¿Se ve el FAQ?', 1000);
    expect(calls.map((c) => c.n)).toEqual([7, 6]);
    expect(calls[0].q).toContain('Responde sobre lo que se ve en ellos');
    expect(peak).toBe(2);
    expect(calls[0].q).toContain('tramos 1-7 de 13');
    expect(out).toBe('[tramos 1-7] el FAQ se ve bien\n[tramos 8-13] sin respuesta: 529 overloaded');
    expect(await describeInBatches(async (p) => `${p.length}`, pngs.slice(0, 7), 'q', 1000)).toBe('7');
    await expect(describeInBatches(async () => { throw new Error('caído'); }, pngs, 'q', 1000)).rejects.toThrow('caído');
  });

  test('los lotes son parejos: 15 tramos van 5+5+5 y 8 van 4+4, nunca un lote de 1', async () => {
    const sizes = async (n: number): Promise<number[]> => {
      const seen: number[] = [];
      await describeInBatches(async (p) => { seen.push(p.length); return 'ok'; }, Array.from({ length: n }, () => Buffer.from('x')), 'q', 1000);
      return seen;
    };
    expect(await sizes(15)).toEqual([5, 5, 5]);
    expect(await sizes(8)).toEqual([4, 4]);
    expect(await sizes(13)).toEqual([7, 6]);
  });

  test('una captura de sección no se presenta como página incompleta ni pide `from`', () => {
    const t = formatExtent(1440, { segments: 1, pageHeight: 6662, shownHeight: 3561, from: 2870, section: '06-casos' });
    expect(t).toBe('Captura a 1440 px de la sección 06-casos: 1 tramo, 2870–3561 px de 6662.');
  });

  test('question vacía o demasiado larga es un error de entrada', () => {
    expect(parseBrowseInput({ viewport: 1440, question: '  ' }).ok).toBe(false);
    expect(parseBrowseInput({ viewport: 1440, question: 'x'.repeat(1001) }).ok).toBe(false);
    expect(parseBrowseInput({ viewport: 375, section: '03-precios' })).toEqual({ ok: true, value: { viewport: 375, full: true, actions: [], section: '03-precios' } });
    expect(parseBrowseInput({ viewport: 375, section: 'a b;' }).ok).toBe(false);
    expect(parseBrowseInput({ viewport: 1440, question: '¿Qué columna queda vacía?' })).toEqual({ ok: true, value: { viewport: 1440, full: true, actions: [], question: '¿Qué columna queda vacía?' } });
  });

  // gen fac2bce5: la captura completa de 375×7652 le llegaba al modelo reducida a 98×2000; no podía leer nada.
  test('la página completa va en tramos de un viewport de ancho real, con tope', () => {
    const at375 = segmentsOf(7652, 375, true);
    expect(at375).toHaveLength(10);
    expect(at375.every((s) => s.width === 375 && s.height <= 800)).toBe(true);
    expect(at375[9]).toEqual({ x: 0, y: 7200, width: 375, height: 452 });
    expect(segmentsOf(20_000, 1440, true)).toHaveLength(10);
    expect(segmentsOf(11_000, 375, true)).toHaveLength(14);
    expect(segmentsOf(4865, 1440, false)).toEqual([{ x: 0, y: 0, width: 1440, height: 900 }]);
    expect(formatExtent(1440, { segments: 6, pageHeight: 20_000, shownHeight: 5400 })).toContain('Cubren 5400 px de 20000: lo de más abajo no está capturado. Para verlo, llama otra vez con {"viewport": 1440, "full": true, "from": 5400}.');
  });

  // QA c734443f: 6420 px a 1440 pasan del tope (5400) y el agente no vio cierre ni footer; el tope no sube, se pide el resto.
  test('`from` captura desde ese píxel; el texto dice cómo seguir y cuándo llegó al final', () => {
    const rest = segmentsOf(6420, 1440, true, 5400);
    expect(rest).toEqual([{ x: 0, y: 5400, width: 1440, height: 900 }, { x: 0, y: 6300, width: 1440, height: 120 }]);
    expect(segmentsOf(6420, 1440, true, 9999)).toEqual([{ x: 0, y: 6419, width: 1440, height: 1 }]);
    expect(parseBrowseInput({ viewport: 1440, from: '5400' })).toEqual({ ok: true, value: { viewport: 1440, full: true, from: 5400, actions: [] } });
    expect(parseBrowseInput({ viewport: 1440, from: -1 }).ok).toBe(false);
    expect(formatExtent(1440, { segments: 2, pageHeight: 6420, shownHeight: 6420, from: 5400 })).toBe('Captura a 1440 px desde 5400 px: 2 tramos de arriba abajo, en orden. Cubren 5400–6420 px: hasta el final de la página (6420 px).');
  });

  // gen 3fc160a7: fullPage + clip se desplazaba con el scroll y el tramo 1 a 1440 arrancaba en la sección 2.
  test('cada tramo se recorta del viewport según dónde quedó el scroll; el último, pegado al fondo', () => {
    expect(viewportClip({ x: 0, y: 0, width: 375, height: 800 }, 0)).toEqual({ x: 0, y: 0, width: 375, height: 800 });
    expect(viewportClip({ x: 0, y: 1600, width: 375, height: 800 }, 1600)).toEqual({ x: 0, y: 0, width: 375, height: 800 });
    // La ventana no baja más de pageHeight - 800 = 6852: el tramo de 452 px empieza a 348 px dentro del viewport.
    expect(viewportClip({ x: 0, y: 7200, width: 375, height: 452 }, 6852)).toEqual({ x: 0, y: 348, width: 375, height: 452 });
  });

  test('la tool browser devuelve error si preview o chromium no responden dentro del tope, sin colgar el servidor', async () => {
    await expect(withDeadline(20, 'browser: sin respuesta en 100 s; vuelve a llamar', () => new Promise(() => {}))).rejects.toThrow('sin respuesta');
    expect(await withDeadline(1000, 'x', async () => 7)).toBe(7);
  });

  // gen 999ea0e0: a 375 solo vio el primer viewport y "sin desbordes" fue una lectura de la captura, no una medida.
  test('el desborde horizontal sale medido, con los elementos que lo causan', () => {
    expect(formatOverflow({ scrollWidth: 412, clientWidth: 375, offenders: ['05-casos div.cases__track (412 px)'] })).toBe('Desborde horizontal: scrollWidth 412 > clientWidth 375.\n- 05-casos div.cases__track (412 px)');
    expect(parseBrowseInput({ viewport: 375 })).toEqual({ ok: true, value: { viewport: 375, full: true, actions: [] } });
  });
});

describe('servidor MCP', () => {
  test('el servidor no usa el nombre reservado `workspace`, que el CLI descarta sin error', () => {
    const { config, allowedTools } = workspaceMcpConfig('/ws', 'http://127.0.0.1:5310/');
    expect(Object.keys(JSON.parse(config).mcpServers)).toEqual(['wt']);
    expect(allowedTools).toEqual(['mcp__wt__ask_user', 'mcp__wt__typecheck', 'mcp__wt__browser']);
  });


  test('lista las tools y responde un error de input como isError', async () => {
    const child = spawn('bun', [join(import.meta.dir, '..', 'scripts', 'workspace-mcp.ts'), workspace(), 'http://127.0.0.1:1/'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines: unknown[] = [];
    let buf = '';
    const got = new Promise<void>((resolve) => child.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const p of parts) if (p) lines.push(JSON.parse(p));
      if (lines.length === 3) resolve();
    }));
    for (const m of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser', arguments: { viewport: 1 } } },
    ]) child.stdin.write(`${JSON.stringify(m)}\n`);
    await got;
    child.kill();
    const [init, list, call] = lines as { result: Record<string, unknown> }[];
    expect((init.result.capabilities as Record<string, unknown>).tools).toEqual({});
    expect((list.result.tools as { name: string }[]).map((t) => t.name)).toEqual(['ask_user', 'typecheck', 'browser']);
    expect(call.result).toEqual({ content: [{ type: 'text', text: 'viewport debe ser 1440 o 375' }], isError: true });
  });
});

// QA §7.1: el corte tras una suspensión no se puede diagnosticar sin los dos relojes en el error que llega al step.
test('un tsc cortado por el plazo dice cuánto pasó en reloj de pared y en monotónico', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-tsc-'));
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  const bin = join(dir, 'node_modules', '.bin', 'tsc');
  writeFileSync(bin, '#!/bin/sh\nexec sleep 5\n');
  chmodSync(bin, 0o755);
  await expect(runTsc(dir, 50)).rejects.toThrow(/^tsc cortado \(SIGTERM; pared \d+ ms, monotónico \d+ ms\)$/);
});
