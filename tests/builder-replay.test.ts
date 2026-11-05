import { describe, expect, test } from 'bun:test';
import { replayDelays } from '../apps/builder/src/lib/replay-delays';
import { previewIssuesOf, previewOf, previewUrlOf, summaryText, toRunState } from '../apps/builder/src/lib/run-state';
import { stepLabelEs } from '../apps/builder/src/lib/step-labels';
import { splitNdjson } from '../apps/builder/src/lib/ndjson';
import { patchLines } from '../apps/builder/src/lib/patch';
import { cleanRules, isPageFile } from '../apps/builder/src/lib/plus-menu';
import { addRuntimeError, isPreviewUpdated, newRuntimeErrors, parseRuntimeError } from '../apps/builder/src/lib/runtime-errors';
import { foldMessage, parseEvent, type EngineEvent } from '../src/runtime/event-model';

const ev = (seq: number, at: number): EngineEvent => ({ v: 1, messageId: 'm', seq, at, type: 'text.delta', text: '' });

describe('replayDelays', () => {
  test('respeta el hueco entre eventos escalado por la velocidad, y nunca da una espera negativa', () => {
    expect(replayDelays([ev(0, 1000), ev(1, 1400), ev(2, 1400), ev(3, 1300)], 2)).toEqual([0, 200, 0, 0]);
  });
});

describe('toRunState', () => {
  test('mapea pasos del fold a AgentRun y arma el resultado solo al cerrar el mensaje', () => {
    const base = { v: 1 as const, messageId: 'm' };
    const events: EngineEvent[] = [
      { ...base, seq: 0, at: 0, type: 'step.start', stepId: 'w', kind: 'write', label: 'Writing hero' },
      { ...base, seq: 1, at: 900, type: 'step.end', stepId: 'w', label: 'Wrote hero', status: 'ok', detail: { kind: 'write', path: 'src/hero.tsx', op: 'create' } },
      { ...base, seq: 2, at: 950, type: 'step.start', stepId: 'b', kind: 'bash', label: 'Building' },
      { ...base, seq: 3, at: 1000, type: 'step.output', stepId: 'b', text: 'ok\n' },
    ];
    const live = toRunState(foldMessage(events), 1000, []);
    expect(live.status).toBe('working');
    expect(live.result).toBeUndefined();
    expect(live.steps.map((s) => [s.mark, s.doneVerb, s.target, s.status, s.ms])).toEqual([
      ['edit', 'Escribió hero', 'src/hero.tsx', 'done', 900],
      ['terminal', 'Compilando', undefined, 'running', undefined],
    ]);
    const end: EngineEvent[] = [
      ...events,
      { ...base, seq: 4, at: 1200, type: 'step.end', stepId: 'b', label: 'Built', status: 'ok', detail: { kind: 'bash', command: 'vite build' } },
      { ...base, seq: 5, at: 1300, type: 'text.delta', text: 'Armé **Nimbus**.' },
      { ...base, seq: 6, at: 1400, type: 'message.end', finishReason: 'stop' },
    ];
    const done = toRunState(foldMessage(end), 1400, [{ path: 'src/App.tsx', additions: 10 }]);
    expect(done.status).toBe('done');
    expect(done.steps[1].io).toEqual({ input: 'vite build', output: ['ok'] });
    expect(done.result).toEqual({ summary: 'Armé Nimbus.', files: [{ path: 'src/App.tsx', additions: 10, deletions: 0 }], checks: ['Compiló'] });
  });

  test('el resumen de una acción va al cuerpo plegable, no a la etiqueta', () => {
    const base = { v: 1 as const, messageId: 'm' };
    const run = toRunState(foldMessage([
      { ...base, seq: 0, at: 0, type: 'step.start', stepId: 'w', kind: 'action', label: 'Componiendo hero' },
      { ...base, seq: 1, at: 10, type: 'step.end', stepId: 'w', label: 'Compuso hero', status: 'ok', detail: { kind: 'action', name: 'compose', summary: 'Abre con la promesa, cierra con la lista de espera' } },
    ]), 10, []);
    expect(run.steps[0].doneTarget).toBeUndefined();
    expect(run.steps[0].text).toBe('Abre con la promesa, cierra con la lista de espera');
  });
});

describe('transport del builder', () => {
  test('splitNdjson deja la línea incompleta para el próximo chunk', () => {
    expect(splitNdjson('{"a":1}\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' });
  });

  test('patchLines numera desde el hunk y separa altas, bajas y contexto', () => {
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,2 @@\n ctx\n-viejo\n+nuevo\n';
    expect(patchLines(patch)).toEqual([
      { kind: 'ctx', no: 3, text: 'ctx' },
      { kind: 'del', no: 4, text: 'viejo' },
      { kind: 'add', no: 4, text: 'nuevo' },
    ]);
  });

  test('el preview sale del último action preview ok del log, no de una url fija', () => {
    const base = { v: 1 as const, messageId: 'm' };
    const preview = (seq: number, url: string): EngineEvent[] => [
      { ...base, seq, at: seq, type: 'step.start', stepId: `p${seq}`, kind: 'action', label: 'Starting preview' },
      { ...base, seq: seq + 1, at: seq + 1, type: 'step.end', stepId: `p${seq}`, label: 'Preview ready', status: 'ok', detail: { kind: 'action', name: 'preview', summary: url } },
    ];
    expect(previewUrlOf([foldMessage([])])).toBeNull();
    expect(previewUrlOf([foldMessage(preview(0, 'http://localhost:5310')), foldMessage(preview(0, 'http://localhost:5311'))])).toBe('http://localhost:5311');
  });

  test('un follow-up que levanta el preview en la misma url cambia la versión, y uno sin preview no', () => {
    const base = { v: 1 as const, messageId: 'm' };
    const preview: EngineEvent[] = [
      { ...base, seq: 0, at: 0, type: 'step.start', stepId: 'p', kind: 'action', label: 'Starting preview' },
      { ...base, seq: 1, at: 1, type: 'step.end', stepId: 'p', label: 'Preview ready', status: 'ok', detail: { kind: 'action', name: 'preview', summary: 'http://127.0.0.1:5310/' } },
    ];
    const first = previewOf([foldMessage(preview)]);
    const followUp = previewOf([foldMessage(preview), foldMessage(preview)]);
    expect(followUp?.url).toBe(first?.url);
    expect(followUp?.version).not.toBe(first?.version);
    expect(previewOf([foldMessage(preview), foldMessage(preview), foldMessage([])])?.version).toBe(followUp?.version);
  });
});

describe('error estructurado en step.end', () => {
  const end = (extra: Record<string, unknown>) => ({ v: 1, messageId: 'm', seq: 1, at: 1, type: 'step.end', stepId: 's', label: 'Wrote x', ...extra });

  test('se pliega al StepState y la UI lo pinta como paso fallido con su mensaje', () => {
    const events = [
      parseEvent({ v: 1, messageId: 'm', seq: 0, at: 0, type: 'step.start', stepId: 's', kind: 'write', label: 'Writing x' }),
      parseEvent(end({ status: 'error', error: { type: 'execution-error', message: 'Failed to edit file' } })),
    ];
    expect(foldMessage(events).steps[0].error).toEqual({ type: 'execution-error', message: 'Failed to edit file' });
    const step = toRunState(foldMessage(events), 1, []).steps[0];
    expect([step.status, step.reason]).toEqual(['failed', 'Failed to edit file']);
  });

  test('parseEvent rechaza error sin message y error con status ok', () => {
    expect(() => parseEvent(end({ status: 'error', error: { type: 'tool-error' } }))).toThrow('sin error');
    expect(() => parseEvent(end({ status: 'ok', error: { type: 'tool-error', message: 'x' } }))).toThrow('status error para llevar error');
  });
});

describe('plus menu', () => {
  test('cleanRules drops blank rules and trims, so [] reaches the transport only when every rule was cleared', () => {
    expect(cleanRules(['  keep it short ', '', '   '])).toEqual(['keep it short']);
    expect(cleanRules(['', ' '])).toEqual([]);
  });

  test('isPageFile hides the engine bookkeeping from the Code tab', () => {
    expect(isPageFile('src/App.tsx')).toBe(true);
    expect(isPageFile('attachments/m1/0-ref.png')).toBe(false);
    expect(isPageFile('instructions.json')).toBe(false);
    expect(isPageFile('src/instructions.json')).toBe(true);
  });
});

describe('restore', () => {
  test("el fold acepta message.end 'restore' y la corrida cierra como hecha, sin pasos colgados", () => {
    const base = { v: 1 as const, messageId: 'r' };
    const state = foldMessage([
      parseEvent({ ...base, seq: 0, at: 0, type: 'message.start' }),
      parseEvent({ ...base, seq: 1, at: 1, type: 'step.start', stepId: 's', kind: 'action', label: 'Restaurando' }),
      parseEvent({ ...base, seq: 2, at: 5, type: 'message.end', finishReason: 'restore' }),
    ]);
    expect(state.status).toBe('restore');
    expect(toRunState(state, 5, []).status).toBe('done');
  });
});

describe('web search', () => {
  test('un paso search muestra la consulta como objetivo y la respuesta como salida', () => {
    const base = { v: 1 as const, messageId: 's' };
    const run = toRunState(foldMessage([
      parseEvent({ ...base, seq: 0, at: 0, type: 'step.start', stepId: 'q', kind: 'search', label: 'Buscando en la web' }),
      parseEvent({ ...base, seq: 1, at: 1, type: 'step.output', stepId: 'q', text: 'Nimbus compite con Linear\nfuente: linear.app\n' }),
      parseEvent({ ...base, seq: 2, at: 2, type: 'step.end', stepId: 'q', label: 'Buscó en la web', status: 'ok', detail: { kind: 'search', scope: 'web', query: 'competidores de Nimbus' } }),
    ]), 2, []);
    expect(run.steps[0].target).toBe('“competidores de Nimbus”');
    expect(run.steps[0].io).toEqual({ input: 'competidores de Nimbus', output: ['Nimbus compite con Linear', 'fuente: linear.app'] });
  });

  test('una búsqueda cuyo label ya trae la consulta no la repite como objetivo', () => {
    const base = { v: 1 as const, messageId: 's' };
    const run = toRunState(foldMessage([
      parseEvent({ ...base, seq: 0, at: 0, type: 'step.start', stepId: 'g', kind: 'search', label: 'Buscando "^export type"' }),
      parseEvent({ ...base, seq: 1, at: 1, type: 'step.end', stepId: 'g', label: 'Buscó "^export type"', status: 'ok', detail: { kind: 'search', scope: 'repo', query: '^export type' } }),
    ]), 1, []);
    expect(run.steps[0].target).toBeUndefined();
  });
});


describe('nestSteps', () => {
  const start = (seq: number, stepId: string, parentStepId?: string): EngineEvent => ({ v: 1, messageId: 'm', seq, at: seq, type: 'step.start', stepId, kind: 'read', label: stepId, ...(parentStepId ? { parentStepId } : {}) });

  test('los pasos del turno del agente cuelgan de su padre y un huérfano queda arriba', () => {
    const steps = toRunState(foldMessage([start(0, 'agent:write'), start(1, 'r1', 'agent:write'), start(2, 'r2', 'agent:write'), start(3, 'build'), start(4, 'x', 'perdido')]), 1, []).steps;
    expect(steps.map((s) => s.id)).toEqual(['agent:write', 'build', 'x']);
    expect(steps[0]!.children?.map((s) => s.id)).toEqual(['r1', 'r2']);
    expect(steps[1]!.children).toBeUndefined();
  });
});

describe('stepLabelEs', () => {
  test('pasa al español los labels del motor en inglés y deja tal cual los que ya vienen en español', () => {
    expect(stepLabelEs('Installed dependencies')).toBe('Instaló dependencias');
    expect(stepLabelEs('Wrote hero')).toBe('Escribió hero');
    expect(stepLabelEs('Wrote page')).toBe('Escribió la página');
    expect(stepLabelEs('ToolSearch')).toBe('Buscó herramientas');
    expect(stepLabelEs('Leyendo src/App.tsx')).toBe('Leyendo src/App.tsx');
  });
});

describe('summaryText', () => {
  test('quita la marca de markdown y la lista de siguientes pasos, que ya son chips, y conserva el resto', () => {
    const text = 'Lista.\n\n**4. Pendiente**\n- Sin menú móvil.\n\n**5. Siguientes pasos**\n- Pídeme el menú móvil.\n- Pídeme logos.';
    expect(summaryText(text)).toBe('Lista.\n\n4. Pendiente\n- Sin menú móvil.');
  });
});

describe('checks del resultado', () => {
  test('solo cuentan los bash del motor, no los que el agente corre dentro de su turno', () => {
    const at = (seq: number, body: Record<string, unknown>) => ({ v: 1, messageId: 'm', seq, at: seq, ...body }) as EngineEvent;
    const events = [
      at(0, { type: 'step.start', stepId: 'agent:write', kind: 'action', label: 'Escribiendo la página' }),
      at(1, { type: 'step.start', stepId: 'ls', kind: 'bash', label: 'Ejecutó ls', parentStepId: 'agent:write' }),
      at(2, { type: 'step.end', stepId: 'ls', label: 'Ejecutó ls', status: 'ok', detail: { kind: 'bash', command: 'ls' } }),
      at(3, { type: 'step.start', stepId: 'b', kind: 'bash', label: 'Building' }),
      at(4, { type: 'step.end', stepId: 'b', label: 'Built', status: 'ok', detail: { kind: 'bash', command: 'vite build' } }),
      at(5, { type: 'message.end', finishReason: 'stop' }),
    ];
    expect(toRunState(foldMessage(events), 5, []).result?.checks).toEqual(['Compiló']);
  });
});

describe('aprobaciones', () => {
  test('el pedido queda pendiente dentro del turno y la decisión lo cierra sin cortar el mensaje', () => {
    const base = { v: 1 as const, messageId: 'm' };
    const request = { ...base, seq: 0, at: 0, type: 'approval.request', callId: 'tu_1', toolName: 'slack_list_user_channels', app: 'slack', reason: 'Leer los nombres', input: { limit: 5 }, kind: 'read' };
    const pending = foldMessage([parseEvent(request)]);
    expect(pending.status).toBe('streaming');
    expect(pending.approvals).toEqual([{ callId: 'tu_1', toolName: 'slack_list_user_channels', app: 'slack', reason: 'Leer los nombres', input: { limit: 5 }, kind: 'read' }]);
    const decided = foldMessage([parseEvent({ ...base, seq: 1, at: 1, type: 'approval.decision', callId: 'tu_1', decision: 'timeout' })], pending);
    expect(decided.approvals?.[0]?.decision).toBe('timeout');
    expect(() => parseEvent({ ...request, kind: 'full' })).toThrow('kind read|write');
  });

  // R4.5: la tarjeta resuelta con "siempre" ofrece "Preguntar cada vez" (Lovable app-lazy-surfaces :1846-1855), así que
  // el fold tiene que conservar el scope y el cliente revoca por tool con DELETE.
  test('un allow con scope always queda marcado y se revoca por tool', async () => {
    const base = { v: 1 as const, messageId: 'm' };
    const pending = foldMessage([parseEvent({ ...base, seq: 0, at: 0, type: 'approval.request', callId: 'tu_2', toolName: 'mcp__wt__generate_image', app: 'wt', input: { prompt: 'x' }, kind: 'spend' })]);
    const decided = foldMessage([parseEvent({ ...base, seq: 1, at: 1, type: 'approval.decision', callId: 'tu_2', decision: 'allow', scope: 'always' })], pending);
    expect([decided.approvals?.[0]?.decision, decided.approvals?.[0]?.scope]).toEqual(['allow', 'always']);
    const { revokeAlways } = await import('../apps/builder/src/lib/run-client');
    const calls: [string, string | undefined][] = [];
    const realFetch = globalThis.fetch;
    const statuses = [204, 404];
    globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push([url, init?.method]); return new Response(null, { status: statuses.shift() }); }) as unknown as typeof fetch;
    try {
      await revokeAlways('http://t', 'mcp__wt__generate_image');
      expect(calls[0]).toEqual(['http://t/approvals/always/mcp__wt__generate_image', 'DELETE']);
      await expect(revokeAlways('http://t', 'mcp__wt__generate_image')).rejects.toThrow('todavía no puede');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('previewIssuesOf', () => {
  const check = (body: Record<string, unknown>) => foldMessage([
    { v: 1, messageId: 'm', seq: 0, at: 0, type: 'step.start', stepId: 'transport:preview-check', kind: 'tool', label: 'Checking preview' },
    { v: 1, messageId: 'm', seq: 1, at: 1, type: 'step.end', stepId: 'transport:preview-check', ...body } as EngineEvent,
  ]);
  test('cuenta defectos del navegador más errores de vite, y un check caído o limpio no cuenta', () => {
    const output = { url: 'x', defects: [{ kind: 'console', message: 'a' }, { kind: 'pageerror', message: 'b' }], server: ['vite: c'] };
    expect(previewIssuesOf(check({ label: 'Found 3 preview issues', status: 'error', detail: { kind: 'tool', name: 'preview-runtime', output }, error: { type: 'execution-error', message: 'a' } }))).toBe(3);
    expect(previewIssuesOf(check({ label: 'Preview check failed', status: 'error', error: { type: 'execution-error', message: 'timeout' } }))).toBe(0);
    expect(previewIssuesOf(check({ label: 'Checked preview', status: 'ok', detail: { kind: 'tool', name: 'preview-runtime', output: { url: 'x', defects: [], server: [] } } }))).toBe(0);
  });
});

describe('capturas del browser', () => {
  const base = { v: 1 as const, messageId: 'm' };
  const end = (detail: Record<string, unknown>) => ({ ...base, seq: 1, at: 900, type: 'step.end', stepId: 'tu_9', label: 'Vio la página a 375 px', status: 'ok', detail });
  test('el paso trae sus capturas con el nombre del paso y la línea de desborde medida', () => {
    const output = 'Captura a 375 px.\nDesborde horizontal: scrollWidth 412 > clientWidth 375 (.pricing-table).\n0 errores de la página.';
    const step = toRunState(foldMessage([
      parseEvent({ ...base, seq: 0, at: 0, type: 'step.start', stepId: 'tu_9', kind: 'tool', label: 'Mirando la página a 375 px' }),
      parseEvent(end({ kind: 'tool', name: 'browser', input: { viewport: 375 }, output, shots: ['tu_9-0.png'] })),
    ]), 900, [], (f) => `/api/runs/m/shots/${f}`).steps[0]!;
    expect(step.shots).toEqual([{ src: '/api/runs/m/shots/tu_9-0.png', alt: 'Vio la página a 375 px' }]);
    expect(step.note).toBe('Desborde horizontal: scrollWidth 412 > clientWidth 375 (.pricing-table).');
  });
  test('parseEvent rechaza un nombre de captura que podría salir de .wt/shots', () => {
    expect(() => parseEvent(end({ kind: 'tool', name: 'browser', shots: ['../../etc/passwd'] }))).toThrow('shots como nombres de captura');
  });
});

describe('errores del preview vivo', () => {
  const msg = { type: 'wt:runtime-error', kind: 'error', message: "TypeError: Cannot read properties of undefined (reading 'map')", path: '/' };
  test('isPreviewUpdated reconoce solo el aviso del puente', () => {
    expect(isPreviewUpdated({ type: 'wt:preview-updated' })).toBe(true);
    expect(isPreviewUpdated({ type: 'wt:runtime-error' })).toBe(false);
    expect(isPreviewUpdated(null)).toBe(false);
  });

  test('parseRuntimeError acepta el mensaje del puente y descarta otro tipo, otro kind o campos de más', () => {
    expect(parseRuntimeError({ ...msg, line: 12, extra: '<script>' })).toEqual({ kind: 'error', message: msg.message, path: '/', line: 12 });
    expect(parseRuntimeError({ ...msg, type: 'other' })).toBeNull();
    expect(parseRuntimeError({ ...msg, kind: 'warn' })).toBeNull();
    expect(parseRuntimeError({ ...msg, line: -1 })).toBeNull();
  });
  test('un error repetido en la misma ruta cuenta una vez, y el que ya vio el preview-check no se suma', () => {
    const e = parseRuntimeError(msg)!;
    const list = addRuntimeError(addRuntimeError([], e), e);
    expect(list).toHaveLength(1);
    expect(addRuntimeError(list, { ...e, path: '/precios' })).toHaveLength(2);
    expect(newRuntimeErrors(list, [`${msg.message}\n    at Pricing`])).toEqual([]);
  });
});

// Review de ec en #375: el validador revisa la forma de selectedSections en steer, como los opcionales de snapshot.
test('steer con selectedSections: string[] pasa; otra forma no', () => {
  expect(parseEvent({ v: 1, messageId: 'm', seq: 0, at: 0, type: 'steer', text: 'y el hero', selectedSections: ['02-hero'] })).toMatchObject({ selectedSections: ['02-hero'] });
  expect(() => parseEvent({ v: 1, messageId: 'm', seq: 0, at: 0, type: 'steer', text: 'y el hero', selectedSections: '02-hero' })).toThrow();
});

// A8 en ee252db7 y G2: generate_image/edit_image reescriben la foto en la misma ruta de public/, vite no hace HMR de
// public/ y el marco se quedaba con la imagen vieja; solo un turno cerrado que tocó public/ recarga el iframe.
test('touchesPublic decide la recarga del marco por las imágenes reescritas', async () => {
  const { touchesPublic } = await import('../apps/builder/src/lib/run-state');
  const msg = (status: 'streaming' | 'stop', files?: string[]) => ({ messageId: 'm', status, steps: [], text: '', ...(files ? { snapshot: { dir: '/ws', files } } : {}) });
  expect([
    touchesPublic(msg('stop', ['public/images/hero.png']), true),
    touchesPublic(msg('stop', ['src/sections/02-hero.tsx']), true),
    touchesPublic(msg('stop'), true),
    touchesPublic(msg('streaming', ['public/images/hero.png']), true),
    touchesPublic(undefined, true),
    // T1: las fotos son rutas nuevas y montan sin recarga (A7).
    touchesPublic(msg('stop', ['public/images/hero.png']), false),
  ]).toEqual([true, false, false, false, false, false]);
});
