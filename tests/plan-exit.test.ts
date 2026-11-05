import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSystemPrompt, planBuildPrompt } from '../src/runtime/agent-prompt';
import { createStreamTranslator } from '../src/runtime/agent-stream';
import { parsePlanExit, planPathFor, validatePlanFile } from '../src/runtime/plan-exit';
import { runWorkspaceTool } from '../src/runtime/workspace-tools';

const ID = 'msg-1';
const PLAN = `# Plan\nobjetivo: cambiar el hero\nidioma: es\n\n## Cambios\n\n## 01-hero · #inicio\n- titular: Vende más\n\n## Archivos\n- src/sections/01-hero.tsx: editar\n\n## Preguntas\n- supuesto: tono cercano\n`;

function workspace(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-exit-'));
  if (content !== undefined) {
    mkdirSync(join(dir, '.wt', 'plans'), { recursive: true });
    writeFileSync(join(dir, planPathFor(ID)), content);
  }
  return dir;
}

const call = (dir: string, planPath = planPathFor(ID), summary = 'Hero con titular nuevo') => {
  const shape = parsePlanExit({ planPath, summary });
  if (!shape.ok) return shape;
  const file = validatePlanFile(shape.value, { dir, messageId: ID });
  return file.ok ? shape : file;
};

describe('exit_plan_mode', () => {
  test('acepta el plan escrito en su ruta con al menos una entrada en Cambios', () => {
    expect(call(workspace(PLAN))).toEqual({ ok: true, value: { planPath: '.wt/plans/msg-1.md', summary: 'Hero con titular nuevo' } });
  });

  test('rechaza una ruta que no es la del mensaje, aunque el archivo exista', () => {
    expect(call(workspace(PLAN), '.wt/plans/otro.md').ok).toBe(false);
  });

  test('rechaza si el plan no existe o no tiene entradas en Cambios', () => {
    expect(call(workspace()).ok).toBe(false);
    expect(call(workspace('## Cambios\n\n## Archivos\n## 01-hero · #x\n- titular: a\n')).ok).toBe(false);
  });

  test('summary de una línea y hasta 200 caracteres', () => {
    const dir = workspace(PLAN);
    expect(call(dir, undefined, 'a'.repeat(201)).ok).toBe(false);
    expect(call(dir, undefined, 'a\nb').ok).toBe(false);
  });

  test('la tool solo corre en modo plan', async () => {
    const dir = workspace(PLAN);
    const previews = { ensure: async () => ({ url: '' }) };
    const input = { planPath: planPathFor(ID), summary: 'x' };
    expect((await runWorkspaceTool('exit_plan_mode', input, { dir, previews })).ok).toBe(false);
    expect((await runWorkspaceTool('exit_plan_mode', input, { dir, previews, planMessageId: ID })).ok).toBe(true);
  });
});

describe('modo plan: prompt y stream', () => {
  const base = { skillDir: '.wt/skill', hasBrowser: true, followUp: false };

  test('el prompt de plan escribe solo el plan, termina en exit_plan_mode y no trae SECCIONES ni RESUMEN FINAL', () => {
    const p = agentSystemPrompt({ ...base, planMessageId: ID });
    expect(p).toContain('.wt/plans/msg-1.md');
    expect(p).toContain('exit_plan_mode');
    expect(p).not.toContain('RESUMEN FINAL');
    expect(p).not.toContain('SECCIONES\n');
  });

  test('la fase build manda ejecutar el plan tal cual y respetar `usuario:` solo si la persona lo editó', () => {
    expect(planBuildPrompt('.wt/plans/msg-1.md', true)).toContain('`usuario:`');
    expect(planBuildPrompt('.wt/plans/msg-1.md', false)).not.toContain('usuario:');
    expect(planBuildPrompt('.wt/plans/msg-1.md', false)).toContain('tal cual');
  });

  test('turn.planExit sale de exit_plan_mode válido, con el callId del resultado, y no de uno con error', () => {
    const feed = (isError: boolean, out: string) => {
      const t = createStreamTranslator(undefined, '/ws/a1');
      const toolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p0', name: 'mcp__wt__exit_plan_mode', input: { planPath: '.wt/plans/msg-1.md', summary: 'Hero nuevo' } }] } };
      const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'p0', content: out, is_error: isError }] } };
      for (const l of [toolUse, toolResult]) t.feed(JSON.stringify(l));
      return t.turn();
    };
    expect(feed(false, 'Plan enviado. callId: c-42').planExit).toEqual({ callId: 'c-42', planPath: '.wt/plans/msg-1.md', summary: 'Hero nuevo' });
    expect(feed(true, 'planPath: debe ser').planExit).toBeUndefined();
  });
});
