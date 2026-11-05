import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AgentMcp, type AgentMcpDeps } from '../src/runtime/agent-mcp';
import { Approvals } from '../src/runtime/approvals';
import type { EventBody, EngineEvent, EventLog } from '../src/runtime/events';
import { EXIT_PLAN_TOOL, planPathFor } from '../src/runtime/plan-exit';
import type { MessageEntry } from '../src/runtime/shared';

const ID = 'm1';
const PLAN = '# Plan\nidioma: es\n\n## Cambios\n## 01-hero · #inicio\n- titular: Vende por WhatsApp\n';

function rpc(token: string, body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  return Object.assign(req, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
}

describe('AgentMcp planReady', () => {
  // ADR 0014 regla 3 + orden: si el proceso cae entre la escritura y el aviso, el log no puede anunciar un plan que el
  // índice no tiene (la decisión por POST daría 404/409 sobre una tarjeta ya mostrada).
  test('deja el plan pendiente en el índice antes de emitir approval.request y plan.ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mcp-plan-'));
    mkdirSync(join(dir, '.wt', 'plans'), { recursive: true });
    writeFileSync(join(dir, planPathFor(ID)), PLAN);
    const order: string[] = [];
    const writes: { id: string; patch: Partial<MessageEntry> }[] = [];
    const index: Record<string, MessageEntry> = { [ID]: { ws: ID } };
    const deps = {
      opts: { allow: {}, agentDescribe: async () => '' },
      logDir: join(dir, 'logs'),
      approvals: new Approvals(),
      port: () => 1,
      wsDir: () => dir,
      entry: (id: string) => index[id]!,
      index: () => index,
      cancels: new Map(),
      imageUse: new Map(),
      updateEntry: (id: string, patch: Partial<MessageEntry>) => { order.push('updateEntry'); writes.push({ id, patch }); },
      startPlanBuild: () => {},
    } as unknown as AgentMcpDeps;
    const mcp = new AgentMcp(deps);
    const emitted: EventBody[] = [];
    const log: EventLog = { emit: (e) => { order.push(e.type); emitted.push(e); return e as EngineEvent; } };
    const open = mcp.openApprovals(ID, ID, log, { readOnlyTools: [], apps: [] } as never, true, undefined, 'plan');
    if (!open) throw new Error('openApprovals sin puerto');

    await mcp.workspaceMcp(rpc(open.endpoint.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: EXIT_PLAN_TOOL, arguments: { planPath: planPathFor(ID), summary: 'Hero de WhatsApp' } } }), ID);

    expect(order.indexOf('updateEntry')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('updateEntry')).toBeLessThan(order.indexOf('approval.request'));
    expect(order.indexOf('updateEntry')).toBeLessThan(order.indexOf('plan.ready'));
    const ready = emitted.find((e) => e.type === 'plan.ready') as { callId: string } | undefined;
    expect(writes).toEqual([{ id: ID, patch: { plan: { callId: ready!.callId, path: planPathFor(ID), summary: 'Hero de WhatsApp', status: 'pending' } } }]);
    open.close();
  });
});
