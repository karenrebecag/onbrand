import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '../src/runtime/events';
import { addTokens, contextTrace, createStreamTranslator, EDIT_PAIR_MAX, editsOf, isDenial, mvTarget, SHOTS_DIR, writeTarget } from '../src/runtime/agent-stream';

// Formas tomadas del stream real del piloto (scratchpad/pilot-stream.ndjson): init, tool_use/tool_result, result.
const DIR = '/ws/a1';
const init = { type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['Read'] };
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, content: unknown, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const text = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const result = { type: 'result', subtype: 'success', is_error: false, result: 'Listo. Datos de ejemplo: ...', session_id: 'sess-1', total_cost_usd: 0.84, duration_ms: 150_000, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } };

function run(lines: unknown[]) {
  const evs: EngineEvent[] = [];
  const t = createStreamTranslator({ emit: (e: EngineEvent) => evs.push(e) } as never, DIR);
  for (const l of lines) t.feed(typeof l === 'string' ? l : JSON.stringify(l));
  return { evs, turn: t.turn() };
}

describe('agent-stream', () => {
  // 78e0030b tras #406: el resumen decía "elige una de estas opciones" sin traer ninguna. v0 manda las opciones como
  // datos (task-ask-user-questions-v1); una pregunta inválida no cuenta y el agente recibe el error para corregirla.
  test('la tool ask_user deja la pregunta con sus opciones en el turno y en el paso, recomendada primero', () => {
    const options = [{ title: 'Venta por conversación', message: 'Cambia el titular del hero a: Convierte cada conversación en una venta' }, { title: 'Respuesta inmediata', message: 'Cambia el titular del hero a: Responde en segundos' }];
    const { evs, turn } = run([init, toolUse('q0', 'mcp__wt__ask_user', { question: '¿Qué titular?', options: options.slice(0, 1) }), toolResult('q0', 'options: de 2 a 3', true), toolUse('q1', 'mcp__wt__ask_user', { question: '¿Qué titular quieres en el hero?', options }), toolResult('q1', 'Pregunta enviada'), result]);
    expect(turn.question).toEqual({ question: '¿Qué titular quieres en el hero?', options });
    expect(turn.writes).toEqual([]);
    const end = evs.find((e) => e.type === 'step.end' && e.stepId === 'q1');
    expect(end?.type === 'step.end' && end.detail).toEqual({ kind: 'action', name: 'question', summary: '¿Qué titular quieres en el hero?', followUps: options });
  });

  test('traduce tool_use/tool_result a steps con rutas relativas y el texto a text.delta', () => {
    const { evs, turn } = run([
      init,
      toolUse('t1', 'Read', { file_path: `${DIR}/.wt/skill/SKILL.md` }),
      toolResult('t1', 'contenido'),
      toolUse('t2', 'Write', { file_path: `${DIR}/src/sections/01-hero.tsx`, content: 'x' }),
      toolResult('t2', 'File created'),
      text('Armé el hero.'),
      'no es json',
      result,
    ]);
    const steps = evs.filter((e) => e.type === 'step.start');
    // Etiquetas por rol, como las de v0 ("Writing hero"), y el resumen final como paso (la tool Done de v0).
    expect(steps.map((e) => e.type === 'step.start' && [e.kind, e.label])).toEqual([['read', 'Leyendo .wt/skill/SKILL.md'], ['write', 'Escribiendo hero'], ['action', 'Resumiendo']]);
    const ends = evs.filter((e) => e.type === 'step.end');
    expect(ends.map((e) => e.type === 'step.end' && [e.status, e.label])).toEqual([['ok', 'Leído .wt/skill/SKILL.md'], ['ok', 'Escrito hero'], ['ok', 'Resumen listo']]);
    expect(ends[1]?.type === 'step.end' && ends[1].detail).toEqual({ kind: 'write', path: 'src/sections/01-hero.tsx', op: 'create', edits: [{ after: 'x' }] });
    // S4 §6: cada paso dice su herramienta, para el mapa pendiente/hecho por tipo de la UI.
    expect(steps.map((e) => e.type === 'step.start' && e.tool)).toEqual(['Read', 'Write', undefined]);
    expect(evs.some((e) => e.type === 'text.delta' && e.text === 'Armé el hero.')).toBe(true);
    expect(turn.sessionId).toBe('sess-1');
    expect(turn.writes).toEqual(['src/sections/01-hero.tsx']);
    expect(turn.summary).toBe('Listo. Datos de ejemplo: ...');
    expect(turn.isError).toBe(false);
    expect(turn.usage).toEqual({ inputTokens: 100, outputTokens: 5, costUsd: 0.84, durationMs: 150_000, cacheReadTokens: 90, linesRead: 1 });
  });

  // fac2bce5: el mensaje empezaba con el progreso ("Escribo el plan…") pegado al resumen.
  test('el texto antes de una tool es un paso de progreso; el mensaje lleva solo el texto final', () => {
    const { evs } = run([init, text('Escribiendo las secciones.'), toolUse('t1', 'Read', { file_path: `${DIR}/x` }), toolResult('t1', 'c'), text('La landing está armada.'), result]);
    expect(evs.filter((e) => e.type === 'text.delta').map((e) => e.type === 'text.delta' && e.text)).toEqual(['La landing está armada.']);
    expect(evs.filter((e) => e.type === 'step.start').map((e) => e.type === 'step.start' && [e.kind, e.label])[0]).toEqual(['thinking', 'Escribiendo las secciones.']);
  });

  // 999ea0e0: dos bloques finales llegaban pegados al cliente, que concatena deltas.
  test('dos bloques de texto finales van separados por un párrafo', () => {
    const { evs } = run([init, text('La landing está armada.'), text('Pendiente: fotos reales.'), result]);
    expect(evs.filter((e) => e.type === 'text.delta').map((e) => e.type === 'text.delta' && e.text)).toEqual(['La landing está armada.', '\n\nPendiente: fotos reales.']);
  });

  // fac2bce5: el CLI anota cada imagen con la ruta de su cache local y llegaba al log y a la UI.
  test('el resultado de una tool no lleva la ruta local de la imagen que anota el CLI', () => {
    const shot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } };
    const note = { type: 'text', text: '[Image: source: /Users/x/.claude/projects/p/img.png]' };
    const { evs } = run([init, toolUse('b', 'mcp__wt__browser', { viewport: 375 }), toolResult('b', [shot, note, { type: 'text', text: 'Captura a 375 px.' }]), result]);
    expect(JSON.stringify(evs)).not.toContain('/Users/x/');
    expect(JSON.stringify(evs)).toContain('Captura a 375 px.');
  });

  test('las verificaciones salen del nombre de la tool o del comando, y el texto manda sobre el exit code', () => {
    const { evs, turn } = run([
      toolUse('w', 'Edit', { file_path: `${DIR}/src/App.tsx` }), toolResult('w', 'ok'),
      // `tsc | head` sale 0 aunque haya errores: el texto decide.
      toolUse('a', 'Bash', { command: 'bunx tsc --noEmit -p tsconfig.app.json 2>&1 | head -30' }), toolResult('a', 'src/x.tsx(1,1): error TS2322: ...'),
      toolUse('b', 'Bash', { command: 'bunx tsc --noEmit -p tsconfig.app.json 2>&1 | head -30' }), toolResult('b', ''),
      toolUse('c', 'Bash', { command: 'bunx vite build --logLevel error' }), toolResult('c', ''),
      toolUse('d', 'mcp__wt__typecheck', {}), toolResult('d', '0 errores'),
      toolUse('d2', 'mcp__wt__typecheck', {}), toolResult('d2', '30 errores en tus archivos:\nsrc/components/x.tsx(4,19): TS2307 Cannot find module'),
      toolUse('e', 'mcp__wt__browser', { viewport: 375, full: true }), toolResult('e', [{ type: 'text', text: 'overflow 0. Página completa (3200 px).' }, { type: 'image', source: {} }]),
      toolUse('f', 'mcp__wt__browser', { viewport: 1440 }), toolResult('f', 'timeout', true),
      toolUse('g', 'mcp__wt__browser', { viewport: 1440 }), toolResult('g', 'Captura a 1440 px (primer viewport). Cubren 900 px de 6285.'),
    ]);
    expect(turn.lastWriteAt).toBe(0);
    expect(turn.checks).toEqual([
      { name: 'typecheck', at: 1, ok: false },
      { name: 'typecheck', at: 2, ok: true },
      { name: 'build', at: 3, ok: true },
      { name: 'typecheck', at: 4, ok: true },
      { name: 'typecheck', at: 5, ok: false },
      { name: 'browser:375', at: 6, ok: true },
      { name: 'browser:1440', at: 7, ok: false },
      // Ya no gatea el turno: cuenta aunque no llegue al final.
      { name: 'browser:1440', at: 8, ok: true },
    ]);
    const browser = evs.find((e) => e.type === 'step.end' && e.stepId === 'e');
    // La captura no se copia al log: solo su marca.
    expect(browser?.type === 'step.end' && browser.detail?.kind === 'tool' && browser.detail.output).toBe('overflow 0. Página completa (3200 px).\n[captura adjunta]');
    const failed = evs.find((e) => e.type === 'step.end' && e.stepId === 'f');
    expect(failed?.type === 'step.end' && failed.status).toBe('error');
    expect(evs.filter((e) => e.type === 'step.start').map((e) => e.type === 'step.start' && e.label)).toContain('Mirando la página a 375 px');
  });

  // gen3: el agente pasó la ruta relativa al workspace y el label la resolvió contra el cwd del server ("../../../../wt-fix/...").
  test('una ruta relativa del agente se resuelve contra el workspace, no contra el cwd del server', () => {
    const { evs, turn } = run([init, toolUse('t1', 'Edit', { file_path: 'src/sections/01-navbar.tsx' }), toolResult('t1', 'ok'), result]);
    expect(evs.find((e) => e.type === 'step.start')?.type === 'step.start' && evs.find((e) => e.type === 'step.start')?.label).toBe('Editando navbar');
    expect(turn.writes).toEqual(['src/sections/01-navbar.tsx']);
    const end = evs.find((e) => e.type === 'step.end' && e.stepId === 't1');
    expect(end?.type === 'step.end' && end.detail).toEqual({ kind: 'write', path: 'src/sections/01-navbar.tsx', op: 'update' });
  });

  // S4 §3 (MAKE-CHAT:40042-40063): el old/new de cada edición viaja con el paso, recortado por lado.
  test('un Edit cierra con sus pares antes/después, recortados a EDIT_PAIR_MAX y marcados como truncados', () => {
    const long = 'a'.repeat(EDIT_PAIR_MAX + 1);
    const { evs } = run([init, toolUse('e1', 'Edit', { file_path: 'src/App.tsx', old_string: 'viejo', new_string: 'nuevo', replace_all: true }), toolResult('e1', 'ok'), toolUse('e2', 'Edit', { file_path: 'src/App.tsx', old_string: 'x', new_string: long }), toolResult('e2', 'ok'), result]);
    const ends = evs.filter((e): e is Extract<EngineEvent, { type: 'step.end' }> => e.type === 'step.end');
    expect(ends.find((e) => e.stepId === 'e1')?.detail).toEqual({ kind: 'write', path: 'src/App.tsx', op: 'update', edits: [{ before: 'viejo', after: 'nuevo', replaceAll: true }] });
    const cut = ends.find((e) => e.stepId === 'e2')?.detail;
    expect(cut?.kind === 'write' && cut.truncated).toBe(true);
    expect(cut?.kind === 'write' && cut.edits?.[0]?.after.length).toBe(EDIT_PAIR_MAX);
    expect(editsOf('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { new_string: 'c' }, 'x'] })).toEqual({ edits: [{ before: 'a', after: 'b' }, { after: 'c' }] });
    expect(editsOf('Edit', {})).toBeUndefined();
  });

  // S4 §4 (FIGMA-APP:444176-444230 treatBashAsEditing): el único Bash que edita es el mv del allowlist.
  test('un mv cuenta como escritura del destino y mueve lastWriteAt; otro Bash no', () => {
    const { turn } = run([init, toolUse('w', 'Write', { file_path: 'src/a.tsx', content: '' }), toolResult('w', 'ok'), toolUse('b1', 'Bash', { command: 'ls src' }), toolResult('b1', 'a.tsx'), toolUse('b2', 'Bash', { command: `mv -f ${DIR}/src/a.tsx "${DIR}/src/sections/03-cta.tsx"` }), toolResult('b2', ''), toolUse('b3', 'Bash', { command: 'mv src/x src/y' }), toolResult('b3', 'No such file', true), result]);
    expect(turn.writes).toEqual(['src/a.tsx', 'src/sections/03-cta.tsx']);
    expect(turn.lastWriteAt).toBe(2);
    expect(mvTarget('mkdir -p src/x')).toBeUndefined();
    expect(mvTarget('mv a')).toBeUndefined();
  });

  // S4 §7: las tools de imagen de S5 salen con su verbo y su nombre corto, sin pisar "Editando" de los archivos.
  test('generate_image y edit_image llevan su label y su tool', () => {
    const { evs } = run([init, toolUse('g', 'mcp__wt__generate_image', { prompt: 'hero' }), toolResult('g', 'public/hero.png'), toolUse('i', 'mcp__wt__edit_image', { target_path: 'public/hero.png' }), toolResult('i', 'ok'), result]);
    const starts = evs.filter((e): e is Extract<EngineEvent, { type: 'step.start' }> => e.type === 'step.start');
    expect(starts.slice(0, 2).map((e) => [e.kind, e.label, e.tool])).toEqual([['tool', 'Generando imagen', 'generate_image'], ['tool', 'Editando imagen', 'edit_image']]);
    const ends = evs.filter((e): e is Extract<EngineEvent, { type: 'step.end' }> => e.type === 'step.end');
    expect(ends.slice(0, 2).map((e) => e.label)).toEqual(['Imagen generada', 'Imagen editada']);
    expect(ends[0]?.detail).toMatchObject({ kind: 'tool', name: 'generate_image' });
  });

  test('writeTarget: rol para secciones y sus estilos, ruta para lo demás', () => {
    expect(writeTarget('src/sections/02-hero.tsx')).toBe('hero');
    expect(writeTarget('src/sections/06-precios.module.css')).toBe('estilos de precios');
    expect(writeTarget('src/App.tsx')).toBe('src/App.tsx');
    expect(writeTarget('src/sections/wa.ts')).toBe('src/sections/wa.ts');
  });

  // Textos reales del CLI en live6 y la demo cc7b8016. Un tsc rojo también es is_error, pero no es denegación.
  test('un Bash rechazado por el permisero del CLI cuenta como denegación y sale como tool-denied; un comando que falla, no', () => {
    const { evs, turn } = run([
      toolUse('b1', 'Bash', { command: 'cat a.md b.md' }), toolResult('b1', 'This Bash command contains multiple operations. The following part requires approval: head -60', true),
      toolUse('b2', 'Bash', { command: 'cat {a,b}.md' }), toolResult('b2', 'Brace expansion', true),
      toolUse('b3', 'Bash', { command: 'bunx tsc --noEmit' }), toolResult('b3', 'src/x.tsx(3,1): error TS2322', true),
      toolUse('w', 'Write', { file_path: `${DIR}/src/x.tsx` }), toolResult('w', 'cat in /x was blocked. For security', true),
      result,
    ]);
    expect(turn.denials).toBe(2);
    const ends = evs.filter((e): e is Extract<EngineEvent, { type: 'step.end' }> => e.type === 'step.end');
    expect(ends.find((e) => e.stepId === 'b1')?.error?.type).toBe('tool-denied');
    expect(ends.find((e) => e.stepId === 'b1')?.label).toMatch(/denegado por el CLI$/);
    expect(ends.find((e) => e.stepId === 'b3')?.error?.type).toBe('tool');
    expect(isDenial('Write', 'was blocked. For security', true)).toBe(false);
    expect(isDenial('Bash', 'Brace expansion', false)).toBe(false);
  });

  test('un result con error marca el turno y una escritura fallida no cuenta como escrita', () => {
    const { evs, turn } = run([
      toolUse('w', 'Write', { file_path: `${DIR}/src/x.tsx` }), toolResult('w', 'EACCES', true),
      { type: 'result', subtype: 'error', is_error: true, result: 'se agotó el tiempo' },
    ]);
    expect(turn.writes).toEqual([]);
    expect(turn.lastWriteAt).toBe(-1);
    expect(turn.isError).toBe(true);
    expect(turn.summary).toBe('se agotó el tiempo');
    // Sin resumen válido no hay paso "Resumen listo".
    expect(evs.some((e) => e.type === 'step.start' && e.stepId === 'agent:summary')).toBe(false);
  });
});

describe('agent-stream: contexto del turno (O2-B)', () => {
  // Como ctx-per-turn.py: el contexto de una llamada es input + caché creada + caché leída; el piso es la primera.
  const call = (content: unknown[], ctx: [number, number, number]) => ({ type: 'assistant', message: { content, usage: { input_tokens: ctx[0], cache_creation_input_tokens: ctx[1], cache_read_input_tokens: ctx[2], output_tokens: 10 } } });
  const resultWith = { ...result, usage: { input_tokens: 30, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 60_000, output_tokens: 900 }, modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1_000_000, costUSD: 0.1 } } };

  test('registra la primera y la última llamada, la ventana, la caché leída y las líneas leídas; el ratio sale de la última', () => {
    const { turn } = run([
      init,
      call([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: `${DIR}/page-plan.md` } }], [10, 17_990, 0]),
      toolResult('r1', 'l1\nl2\nl3'),
      call([{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: `${DIR}/src/sections/01-hero.tsx` } }], [12, 6_988, 18_000]),
      toolResult('r2', 'a\nb'),
      call([{ type: 'text', text: 'Listo.' }], [8, 4_992, 25_000]),
      resultWith,
    ]);
    expect(turn.usage).toMatchObject({ firstCallTokens: 18_000, lastCallTokens: 30_000, contextWindow: 1_000_000, cacheReadTokens: 60_000, linesRead: 5 });
    expect(contextTrace(turn.usage)).toEqual({ ratio: 0.03, floorTokens: 18_000, lastTokens: 30_000, window: 1_000_000, cacheReadTokens: 60_000, linesRead: 5 });
  });

  test('sin usage por llamada no hay medida; una reanudación conserva el piso del turno y toma la última llamada del tramo', () => {
    expect(contextTrace(run([init, text('Hola'), result]).turn.usage)).toBeUndefined();
    const merged = addTokens({ firstCallTokens: 18_000, lastCallTokens: 30_000, contextWindow: 1_000_000, linesRead: 5, cacheReadTokens: 60_000 }, { firstCallTokens: 31_000, lastCallTokens: 35_000, contextWindow: 1_000_000, linesRead: 2, cacheReadTokens: 100_000, costUsd: 0.2 });
    expect(merged).toEqual({ firstCallTokens: 18_000, lastCallTokens: 35_000, contextWindow: 1_000_000, linesRead: 7, cacheReadTokens: 160_000, costUsd: 0.2 });
  });
});

describe('agent-stream: jerarquía de pasos', () => {
  // Secondary rA2/rB: el agente miró el primer viewport y dio la página por verificada.
  test('con parentStepId, cada paso del turno y el resumen cuelgan del paso del composer', () => {
    const evs: EngineEvent[] = [];
    const t = createStreamTranslator({ emit: (e: EngineEvent) => evs.push(e) } as never, DIR, 'agent:write');
    for (const l of [init, toolUse('t1', 'Read', { file_path: `${DIR}/.wt/skill/SKILL.md` }), toolResult('t1', 'x'), result]) t.feed(JSON.stringify(l));
    const starts = evs.filter((e) => e.type === 'step.start');
    expect(starts.map((e) => e.type === 'step.start' && e.parentStepId)).toEqual(['agent:write', 'agent:write']);
  });

  test('la captura de browser va a .wt/shots con el tool_use_id y el paso la nombra; al log no llega base64', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-stream-shots-'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const evs: EngineEvent[] = [];
    const t = createStreamTranslator({ emit: (e: EngineEvent) => evs.push(e) } as never, dir);
    t.feed(JSON.stringify(toolUse('toolu_9', 'mcp__wt__browser', { viewport: 375 })));
    t.feed(JSON.stringify(toolResult('toolu_9', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: 'Desborde horizontal: 0' }])));
    const end = evs.find((e) => e.type === 'step.end');
    expect(end?.type === 'step.end' && end.detail).toMatchObject({ kind: 'tool', name: 'browser', shots: ['toolu_9-0.png'] });
    expect(readFileSync(join(dir, SHOTS_DIR, 'toolu_9-0.png')).toString('base64')).toBe(png);
    expect(JSON.stringify(evs)).not.toContain(png);
    // Otra tool con imagen no escribe nada.
    t.feed(JSON.stringify(toolUse('toolu_10', 'Read', { file_path: join(dir, 'a.png') })));
    t.feed(JSON.stringify(toolResult('toolu_10', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }])));
    expect(existsSync(join(dir, SHOTS_DIR, 'toolu_10-0.png'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('una captura no se escribe a través de un symlink que dejó el agente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-stream-link-'));
    const victim = join(dir, '..', `${dir.split('/').pop()}-victim.txt`);
    writeFileSync(victim, 'original');
    mkdirSync(join(dir, SHOTS_DIR), { recursive: true });
    symlinkSync(victim, join(dir, SHOTS_DIR, 'toolu_1-0.png'));
    const t = createStreamTranslator({ emit: () => {} } as never, dir);
    t.feed(JSON.stringify(toolUse('toolu_1', 'mcp__wt__browser', { viewport: 375 })));
    t.feed(JSON.stringify(toolResult('toolu_1', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png').toString('base64') } }])));
    expect(readFileSync(victim, 'utf8')).toBe('original');
    expect(readFileSync(join(dir, SHOTS_DIR, 'toolu_1-0.png'), 'utf8')).toBe('png');
    rmSync(victim, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
