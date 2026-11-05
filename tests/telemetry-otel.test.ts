import { afterEach, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { EngineEvent } from '../src/runtime/events';

let server: Server | undefined;
const prevUrl = process.env.WT_SPOTLIGHT_URL;
const prevFlag = process.env.WT_SPOTLIGHT;
afterEach(() => {
  server?.close();
  if (prevUrl === undefined) delete process.env.WT_SPOTLIGHT_URL; else process.env.WT_SPOTLIGHT_URL = prevUrl;
  if (prevFlag === undefined) delete process.env.WT_SPOTLIGHT; else process.env.WT_SPOTLIGHT = prevFlag;
});

// El sidecar de Spotlight solo ingiere envelopes Sentry: el exporter OTel arma la transacción del mensaje con sus steps
// como spans hijos y la postea. Un mensaje = una transacción; cada step.start/end = un span con el tiempo del log.
test('las trazas OTel del mensaje salen como una transacción Sentry al sidecar, con los steps como spans', async () => {
  const bodies: string[] = [];
  let resolve: () => void = () => undefined;
  const got = new Promise<void>((r) => { resolve = r; });
  server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { bodies.push(b); res.writeHead(200); res.end(); resolve(); });
  });
  await new Promise<void>((r) => server!.listen(0, r));
  const port = (server!.address() as { port: number }).port;
  process.env.WT_SPOTLIGHT = '1';
  process.env.WT_SPOTLIGHT_URL = `http://127.0.0.1:${port}`;
  delete process.env.WT_OTLP_URL;

  const { startTelemetry, traceEvent } = await import('../src/runtime/telemetry');
  startTelemetry();
  const id = 'mX';
  const ev = (o: Partial<EngineEvent> & { type: string; at: number }) => traceEvent({ v: 1, messageId: id, seq: 0, ...o } as unknown as EngineEvent);
  ev({ type: 'step.start', stepId: 's1', kind: 'tool', label: 'typecheck', at: 1000 } as never);
  ev({ type: 'step.end', stepId: 's1', status: 'ok', label: 'ok', at: 1200 } as never);
  ev({ type: 'message.end', at: 1300 } as never);
  ev({ type: 'settled', at: 1300 } as never);

  await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('sin POST')), 3000))]);
  const [header, itemHeader, payload] = bodies[0]!.trim().split('\n');
  expect(JSON.parse(itemHeader!).type).toBe('transaction');
  const txn = JSON.parse(payload!);
  expect(txn.type).toBe('transaction');
  expect(txn.transaction).toBe(`message ${id}`);
  expect(txn.contexts.trace.op).toBe('wt.message');
  expect(txn.spans).toHaveLength(1);
  expect(txn.spans[0].description).toBe('typecheck');
  expect(txn.spans[0].parent_span_id).toBe(txn.contexts.trace.span_id);
  expect(JSON.parse(header!)).toHaveProperty('sent_at');
});
