import { expect, test } from 'bun:test';
import { installErrorBridge, WT_ERROR_MESSAGE, WT_LOG_MESSAGE, WT_NETWORK_MESSAGE, WT_PREVIEW_UPDATED } from '../templates/base-scaffold/src/wt-error-bridge';
import { CONTEXT_BYTES_MAX, reduceRuntimeContext, runtimeContextOf, type RuntimeContext } from '../apps/builder/src/lib/runtime-errors';

const BUILDER = 'http://localhost:5320';

function fakeWindow(framed = true) {
  const posted: { message: Record<string, unknown>; origin: string }[] = [];
  const listeners = new Map<string, (e: Event) => void>();
  const logged: unknown[][] = [];
  const win = {
    parent: { postMessage: (message: unknown, origin: string) => posted.push({ message: message as Record<string, unknown>, origin }) },
    location: { pathname: '/precios' },
    console: { error: (...args: unknown[]) => logged.push(args) },
    addEventListener: (t: string, l: (e: Event) => void) => listeners.set(t, l),
    removeEventListener: (t: string) => listeners.delete(t),
  };
  if (!framed) win.parent = win as never;
  const fire = (t: string, e: Record<string, unknown>) => listeners.get(t)?.(e as unknown as Event);
  const errors = () => posted.filter((p) => p.message.type === WT_ERROR_MESSAGE);
  return { win, posted, errors, logged, listeners, fire };
}

test('manda los tres tipos de error solo al origen del builder, con la ruta sin query', () => {
  const f = fakeWindow();
  installErrorBridge(f.win, BUILDER);
  f.win.console.error('falló', new Error('boom'));
  f.fire('error', { message: 'x is not defined', filename: 'http://localhost:5311/src/App.tsx', lineno: 3, colno: 9, error: new ReferenceError('x is not defined') });
  f.fire('unhandledrejection', { reason: new Error('fetch roto') });
  expect(f.logged).toHaveLength(1);
  expect(f.errors().map((p) => [p.origin, p.message.type, p.message.kind, p.message.path])).toEqual([
    [BUILDER, WT_ERROR_MESSAGE, 'console.error', '/precios'],
    [BUILDER, WT_ERROR_MESSAGE, 'error', '/precios'],
    [BUILDER, WT_ERROR_MESSAGE, 'unhandledrejection', '/precios'],
  ]);
  expect(f.errors()[0].message.message).toBe('falló Error: boom');
  expect(f.errors()[1].message).toMatchObject({ source: 'http://localhost:5311/src/App.tsx', line: 3, column: 9 });
  expect(f.errors()[2].message.message).toBe('Error: fetch roto');
});

// Sin origen (deploy) o fuera de un iframe no hay a quién mandar: un postMessage con '*' filtraría errores a cualquiera que embeba la página.
test('sin origen o sin iframe queda inerte', () => {
  for (const [f, origin] of [[fakeWindow(), undefined], [fakeWindow(false), BUILDER]] as const) {
    const before = f.win.console.error;
    installErrorBridge(f.win, origin);
    expect(f.win.console.error).toBe(before);
    expect(f.listeners.size).toBe(0);
  }
});

test('un error en bucle no satura el canal y el puente se puede quitar', () => {
  const f = fakeWindow();
  const off = installErrorBridge(f.win, BUILDER);
  for (let i = 0; i < 100; i += 1) f.win.console.error('render', i);
  expect(f.errors()).toHaveLength(30);
  expect(f.logged).toHaveLength(100);
  off();
  expect(f.listeners.size).toBe(0);
});

// 7571e1fd: el HMR pintó 02-hero con ChatThread antes de su import; el error quedó en el builder sobre la versión limpia.
test('avisa documento nuevo al instalarse y antes de cada update de HMR, sin contar contra el tope de errores', () => {
  const f = fakeWindow();
  let beforeUpdate: (() => void) | undefined;
  installErrorBridge(f.win, BUILDER, { on: (event, cb) => { if (event === 'vite:beforeUpdate') beforeUpdate = cb; } });
  f.fire('error', { message: 'ChatThread is not defined', error: new ReferenceError('ChatThread is not defined') });
  beforeUpdate?.();
  expect(f.posted.map((p) => p.message.type)).toEqual([WT_PREVIEW_UPDATED, WT_ERROR_MESSAGE, WT_PREVIEW_UPDATED]);
  expect(f.posted.every((p) => p.origin === BUILDER)).toBe(true);
});

// H10: el contexto de runtime viaja en cada turno con modelo, como client_logs/network_requests/runtime_errors de Lovable.
test('manda logs y requests sin query, y el builder guarda los últimos 50 y borra solo los errores en un update', async () => {
  const f = fakeWindow();
  const logs: unknown[][] = [];
  Object.assign(f.win.console, { log: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) });
  Object.assign(f.win, { fetch: async (input: unknown) => (String(input).includes('roto') ? Promise.reject(new TypeError('Failed to fetch')) : new Response('{}', { status: 404 })) });
  const win = f.win as typeof f.win & { fetch(input: string): Promise<Response> };
  Object.assign(f.win.location, { href: 'http://localhost:5311/precios' });
  const off = installErrorBridge(f.win, BUILDER);
  (f.win.console as unknown as { warn(...a: unknown[]): void }).warn('aviso', { a: 1 });
  await win.fetch('/api/planes?token=secreto#x');
  await win.fetch('https://otro.dev/roto').catch(() => {});
  f.fire('error', { message: 'boom', error: new Error('boom') });

  expect(logs).toEqual([['aviso', { a: 1 }]]);
  const log = f.posted.find((p) => p.message.type === WT_LOG_MESSAGE)?.message;
  expect(log).toMatchObject({ level: 'warn', message: 'aviso {"a":1}', path: '/precios' });
  const nets = f.posted.filter((p) => p.message.type === WT_NETWORK_MESSAGE).map((p) => p.message);
  expect(nets.map((n) => [n.method, n.url, n.status, n.ok])).toEqual([['GET', 'http://localhost:5311/api/planes', 404, false], ['GET', 'https://otro.dev/roto', 0, false]]);
  expect(nets[1].error).toBe('TypeError: Failed to fetch');

  let ctx: RuntimeContext = { clientLogs: [], networkRequests: [], runtimeErrors: [] };
  for (const p of f.posted) ctx = reduceRuntimeContext(ctx, p.message);
  expect([ctx.clientLogs.length, ctx.networkRequests.length, ctx.runtimeErrors.length]).toEqual([1, 2, 1]);
  for (let i = 0; i < 60; i += 1) ctx = reduceRuntimeContext(ctx, { ...log, message: `l${i}` });
  expect(ctx.clientLogs).toHaveLength(50);
  expect(ctx.clientLogs.at(-1)?.message).toBe('l59');
  ctx = reduceRuntimeContext(ctx, { type: WT_PREVIEW_UPDATED });
  expect([ctx.clientLogs.length, ctx.networkRequests.length, ctx.runtimeErrors.length]).toEqual([50, 2, 0]);
  expect(reduceRuntimeContext(ctx, { type: WT_NETWORK_MESSAGE, method: 'GET', url: 'x', status: 'ok' })).toBe(ctx);
  const big = runtimeContextOf({ ...ctx, clientLogs: ctx.clientLogs.map((l) => ({ ...l, message: 'x'.repeat(2000) })) });
  expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeLessThanOrEqual(CONTEXT_BYTES_MAX);
  expect(big?.networkRequests).toHaveLength(2);
  expect(runtimeContextOf({ clientLogs: [], networkRequests: [], runtimeErrors: [] })).toBeUndefined();

  off();
  expect(f.win.console.error).not.toBe(undefined);
});
