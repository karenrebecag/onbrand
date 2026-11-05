import { describe, expect, test } from 'bun:test';
import { Approvals, kindOf, PLAN_TOOLS, SPEND_TOOLS, type ApprovalSink, type PermissionAsk } from '../src/runtime/approvals';
import { EXIT_PLAN_TOOL_FULL } from '../src/runtime/plan-exit';

const sink: ApprovalSink = { request: () => {}, decision: () => {} };
const DIR = '/tmp/ws';
const PLAN = { dir: DIR, path: '.wt/plans/m1.md' };
const write = (filePath: string): PermissionAsk => ({ tool_name: 'Write', input: { file_path: filePath }, tool_use_id: 'u1' });

describe('Approvals en fase plan (H6)', () => {
  test('exit_plan_mode es kind plan', () => {
    expect(PLAN_TOOLS.has(EXIT_PLAN_TOOL_FULL)).toBe(true);
    expect(kindOf(EXIT_PLAN_TOOL_FULL, new Set())).toBe('plan');
  });

  test('Write al archivo del plan pasa; a cualquier otra ruta se deniega', async () => {
    const a = new Approvals();
    expect(await a.ask('c', 'ask', new Set(), write('/tmp/ws/.wt/plans/m1.md'), sink, undefined, false, PLAN)).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/ws/.wt/plans/m1.md' } });
    expect(await a.ask('c', 'ask', new Set(), write('.wt/plans/m1.md'), sink, undefined, false, PLAN)).toMatchObject({ behavior: 'allow' });
    expect(await a.ask('c', 'ask', new Set(), write('/tmp/ws/src/hero.tsx'), sink, undefined, false, PLAN)).toMatchObject({ behavior: 'deny' });
  });

  test('en fase plan no se genera imagen ni escribe un conector', async () => {
    const a = new Approvals();
    const spend: PermissionAsk = { tool_name: [...SPEND_TOOLS][0] as string, input: {}, tool_use_id: 'u2' };
    expect(await a.ask('c', 'ask', new Set(), spend, sink, undefined, false, PLAN)).toMatchObject({ behavior: 'deny' });
    const connWrite: PermissionAsk = { tool_name: 'mcp__slack__send_message', input: {}, tool_use_id: 'u3' };
    expect(await a.ask('c', 'ask', new Set(), connWrite, sink, undefined, false, PLAN)).toMatchObject({ behavior: 'deny' });
  });
});
