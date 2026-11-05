import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldMessage, openEventLog, readEvents, setEventSink, type EngineEvent } from '../src/runtime/events';

const dir = (): string => mkdtempSync(join(tmpdir(), 'wt-events-'));
const clock = (): (() => number) => { let t = 1000; return () => (t += 10); };

// Corrida real del runner (pasos y etiquetas de ArqWebTransformer, feat/v0-runner).
function emitRun(d: string, id: string): void {
  const log = openEventLog(d, id, clock());
  log.emit({ type: 'message.start' });
  log.emit({ type: 'step.start', stepId: 's1', kind: 'tool', label: 'Checking components' });
  log.emit({ type: 'step.end', stepId: 's1', label: 'Checked components', status: 'ok', detail: { kind: 'tool', name: 'allowlist', output: { unknown: [], layoutErrors: [] } } });
  log.emit({ type: 'step.start', stepId: 's2', kind: 'write', label: 'Writing hero' });
  log.emit({ type: 'step.end', stepId: 's2', label: 'Wrote hero', status: 'ok', detail: { kind: 'write', path: 'src/sections/01-hero.tsx', op: 'create' } });
  log.emit({ type: 'step.start', stepId: 's3', kind: 'bash', label: 'Building' });
  log.emit({ type: 'step.output', stepId: 's3', text: 'vite v6 building...\n' });
  log.emit({ type: 'step.output', stepId: 's3', text: '✓ built in 1.2s\n' });
  log.emit({ type: 'step.end', stepId: 's3', label: 'Built', status: 'ok', detail: { kind: 'bash', command: 'vite build', exitCode: 0 } });
  log.emit({ type: 'text.delta', text: 'Armé la página ' });
  log.emit({ type: 'text.delta', text: 'con hero.' });
  log.emit({ type: 'message.end', finishReason: 'stop' });
}

describe('log de eventos por messageId', () => {
  // Un mensaje de plan (H6) lleva dos fases en el mismo log: el message.end del plan no cierra la fase build.
  test('done = el último message.start tiene un message.end posterior', () => {
    const d = dir();
    const log = openEventLog(d, 'plan1', clock());
    log.emit({ type: 'message.start' });
    log.emit({ type: 'message.end', finishReason: 'stop', outcome: 'asked' });
    log.emit({ type: 'settled' });
    expect(readEvents(d, 'plan1').done).toBe(true);
    log.emit({ type: 'message.start' });
    expect(readEvents(d, 'plan1').done).toBe(false);
    log.emit({ type: 'message.end', finishReason: 'stop' });
    expect(readEvents(d, 'plan1').done).toBe(true);
  });

  test('el replay completo da los pasos con su etiqueta en pasado, la salida y el texto final', () => {
    const d = dir();
    emitRun(d, 'msg1');
    const r = readEvents(d, 'msg1');
    expect(r.done).toBe(true);
    const m = foldMessage(r.events);
    expect(m.status).toBe('stop');
    expect(m.steps.map((s) => [s.label, s.status])).toEqual([['Checked components', 'ok'], ['Wrote hero', 'ok'], ['Built', 'ok']]);
    expect(m.steps[2].output).toBe('vite v6 building...\n✓ built in 1.2s\n');
    expect(m.text).toBe('Armé la página con hero.');
  });

  test('leer por tramos con el cursor da el mismo estado que el replay completo (resume)', () => {
    const d = dir();
    emitRun(d, 'msg1');
    const first = readEvents(d, 'msg1', { after: -1 });
    const head = foldMessage(first.events.slice(0, 4));
    const rest = readEvents(d, 'msg1', { after: first.events[3].seq });
    expect(rest.events[0].seq).toBe(4);
    expect(foldMessage(rest.events, head)).toEqual(foldMessage(first.events));
  });

  test('mientras corre, el paso abierto lleva la etiqueta en curso; un append a medias se ignora', () => {
    const d = dir();
    const log = openEventLog(d, 'msg2', clock());
    log.emit({ type: 'message.start' });
    log.emit({ type: 'step.start', stepId: 's1', kind: 'write', label: 'Writing hero' });
    appendFileSync(join(d, 'msg2.ndjson'), '{"v":1,"messageId":"msg2","seq":2,');
    const r = readEvents(d, 'msg2');
    expect(r.done).toBe(false);
    expect(r.cursor).toBe(1);
    expect(foldMessage(r.events).steps[0]).toMatchObject({ label: 'Writing hero', status: 'running' });
  });

  test('un paso sin cerrar al terminar el mensaje queda interrumpido; el snapshot llega después del cierre', () => {
    const d = dir();
    const log = openEventLog(d, 'msg3', clock());
    log.emit({ type: 'message.start' });
    log.emit({ type: 'step.start', stepId: 's1', kind: 'bash', label: 'Installing dependencies' });
    log.emit({ type: 'error', message: 'bun install falló', code: 'install' });
    log.emit({ type: 'message.end', finishReason: 'error' });
    log.emit({ type: 'snapshot', dir: 'generated/nimbus/dist', files: ['index.html'] });
    const m = foldMessage(readEvents(d, 'msg3').events);
    expect(m.steps[0].status).toBe('interrupted');
    expect(m.error).toEqual({ message: 'bun install falló', code: 'install' });
    expect(m.snapshot?.files).toEqual(['index.html']);
  });

  test('reabrir el log de un mensaje sigue el seq donde quedó', () => {
    const d = dir();
    openEventLog(d, 'msg4', clock()).emit({ type: 'message.start' });
    const e = openEventLog(d, 'msg4', clock()).emit({ type: 'text.delta', text: 'x' });
    expect(e.seq).toBe(1);
    expect(readEvents(d, 'msg4').events.map((x) => x.seq)).toEqual([0, 1]);
  });

  test('un hueco en el seq, una línea inválida o un messageId con ruta lanzan en vez de leer a medias', () => {
    const d = dir();
    writeFileSync(join(d, 'gap.ndjson'), '{"v":1,"messageId":"gap","seq":0,"at":1,"type":"message.start"}\n{"v":1,"messageId":"gap","seq":2,"at":2,"type":"message.start"}\n');
    expect(() => readEvents(d, 'gap')).toThrow(/hueco/);
    writeFileSync(join(d, 'bad.ndjson'), '{"v":1,"messageId":"bad","seq":0,"at":1,"type":"step.start","stepId":"s","kind":"paint","label":"x"}\n');
    expect(() => readEvents(d, 'bad')).toThrow(/línea 1.*kind/);
    expect(() => openEventLog(d, '../fuera', clock())).toThrow(/messageId/);
  });
});

describe('sink de eventos (trazas de Spotlight)', () => {
  test('recibe cada evento emitido y un sink que falla no corta el log', () => {
    const d = dir();
    const seen: EngineEvent[] = [];
    setEventSink((e) => {
      seen.push(e);
      if (e.type === 'step.start') throw new Error('sidecar caído');
    });
    try {
      emitRun(d, 'sink');
    } finally {
      setEventSink(undefined);
    }
    const { events } = readEvents(d, 'sink');
    expect(seen.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
    expect(events.at(-1)?.type).toBe('message.end');
  });
});
