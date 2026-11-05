// H18: plegado del hilo con tope y ratio de contexto en GET /chats/:id. Sin modelo ni reloj: el infer es inyectado.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFollowUpContext, type ThreadTurn } from '../src/runtime/follow-up-context';
import { contextOf } from '../src/runtime/run-reads';
import { foldThread, THREAD_KEEP } from '../src/runtime/thread-fold';

const turns = (prefix: string, n: number): ThreadTurn[] => Array.from({ length: n }, (_, i) => ({ messageId: `${prefix}${i + 1}`, prompt: `pedido ${i + 1}\ndetalle`, summary: `hecho ${i + 1}` }));

describe('foldThread', () => {
  test('un hilo dentro del tope no se pliega ni llama al modelo', async () => {
    let calls = 0;
    const out = await foldThread(turns('a', THREAD_KEEP), async () => { calls++; return { summary: 'x' }; });
    expect(out.folded).toBeUndefined();
    expect(out.thread).toHaveLength(THREAD_KEEP);
    expect(calls).toBe(0);
  });

  test('pasado el tope quedan los N últimos íntegros y los viejos van al resumen', async () => {
    const seen: string[] = [];
    const out = await foldThread(turns('b', THREAD_KEEP + 3), async (_s, user) => { seen.push(user); return { summary: '- decidieron paleta cálida' }; });
    expect(out.thread.map((t) => t.messageId)).toEqual(turns('b', THREAD_KEEP + 3).slice(-THREAD_KEEP).map((t) => t.messageId));
    expect(out.folded).toEqual({ summary: '- decidieron paleta cálida', count: 3 });
    expect(seen[0]).toContain('pedido 1');
    expect(seen[0]).not.toContain(`pedido ${THREAD_KEEP + 3}`);
  });

  test('el mismo tramo viejo reutiliza el resumen en el siguiente follow-up', async () => {
    let calls = 0;
    const infer = async () => { calls++; return { summary: 'r' }; };
    await foldThread(turns('c', THREAD_KEEP + 2), infer);
    await foldThread(turns('c', THREAD_KEEP + 2), infer);
    expect(calls).toBe(1);
  });

  test('si el modelo falla, el resumen es la lista de pedidos y no se cachea', async () => {
    let calls = 0;
    const out = await foldThread(turns('d', THREAD_KEEP + 2), async () => { calls++; throw new Error('sin red'); });
    expect(out.folded?.summary).toBe('- pedido 1\n- pedido 2');
    await foldThread(turns('d', THREAD_KEEP + 2), async () => { calls++; return { summary: 'ya' }; });
    expect(calls).toBe(2);
  });
});

describe('writeFollowUpContext con hilo plegado', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fold-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('escribe summary.md y numera los turnos íntegros a continuación de los resumidos', () => {
    const thread = turns('e', 2);
    writeFollowUpContext(tmp, { thread, folded: { summary: '- uno\n- dos\n- tres', count: 3 }, tools: [], lastFiles: [] });
    const dir = join(tmp, '.wt/context/conversation_history');
    expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toContain('- tres');
    expect(existsSync(join(dir, '04-e1.md'))).toBe(true);
    expect(readFileSync(join(dir, '05-e2.md'), 'utf8')).toContain('# Pedido 5');
  });

  test('sin plegado no hay summary.md y la numeración arranca en 01', () => {
    writeFollowUpContext(tmp, { thread: turns('f', 1), tools: [], lastFiles: [] });
    expect(existsSync(join(tmp, '.wt/context/conversation_history/summary.md'))).toBe(false);
    expect(existsSync(join(tmp, '.wt/context/conversation_history/01-f1.md'))).toBe(true);
  });
});

describe('contextOf (GET /chats/:id)', () => {
  test('toma el último context.usage del log; sin él no añade campo', () => {
    const usage = (ratio: number) => ({ type: 'context.usage', ratio, lastTokens: 10, floorTokens: 5, window: 200_000 });
    expect(contextOf([usage(0.2), { type: 'message.end' }, usage(0.34)])).toEqual({ context: { ratio: 0.34, lastTokens: 10, floorTokens: 5, window: 200_000 } });
    expect(contextOf([{ type: 'message.end' }])).toEqual({});
  });
});
