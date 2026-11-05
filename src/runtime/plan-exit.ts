// Salida del modo plan (M1, docs/spec/plan-mode.md): el agente escribe `.wt/plans/<messageId>.md` y llama a
// `exit_plan_mode`; la tool solo valida y el turno termina. La decisión de la persona llega por Approvals, no aquí.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePagePlanMd } from '../page-plan-md';

export const EXIT_PLAN_TOOL = 'exit_plan_mode';
// Literal `wt` y no MCP_SERVER: workspace-mcp importa workspace-tools, que importa este módulo (ciclo), como ask-user.ts.
export const EXIT_PLAN_TOOL_FULL = `mcp__wt__${EXIT_PLAN_TOOL}`;

export interface PlanExit {
  /** Lo genera el transport al entregar el plan a Approvals y viaja en el resultado de la tool (`callId: <id>`). */
  callId?: string;
  planPath: string;
  summary: string;
}

/** Fase del turno (M1): `plan` solo planea; `build` ejecuta el plan aprobado en el mismo mensaje, reanudando la sesión. */
export type PlanPhase = { mode: 'plan' } | { mode: 'build'; path: string; edited: boolean };

const MAX_SUMMARY = 200;

/** Ruta del plan de un mensaje, relativa a la raíz del workspace. `.wt/` queda fuera del commit de la versión. */
export const planPathFor = (messageId: string): string => `.wt/plans/${messageId}.md`;

// `## Cambios` termina en la primera sección que no es una entrada (`## Archivos`, `## Preguntas`): las entradas también
// son `## `, así que parsePagePlanMd no distingue por sí solo dónde acaba.
const changesOf = (text: string): string => {
  const lines = text.split(/\r?\n/);
  const from = lines.findIndex((l) => /^##\s+Cambios\s*$/i.test(l));
  if (from < 0) return '';
  const rest = lines.slice(from + 1);
  const end = rest.findIndex((l) => /^##\s+(Archivos|Preguntas)\b/i.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
};

/** La forma del input: ruta y resumen de una línea. Lo semántico (ruta del mensaje, archivo, entradas) es validatePlanFile. */
export function parsePlanExit(input: unknown): { ok: true; value: PlanExit } | { ok: false; error: string } {
  const o = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const planPath = typeof o.planPath === 'string' ? o.planPath.trim() : '';
  if (!planPath) return { ok: false, error: 'planPath: la ruta del plan que escribiste' };
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (!summary || summary.length > MAX_SUMMARY || summary.includes('\n')) return { ok: false, error: `summary: una línea de 1 a ${MAX_SUMMARY} caracteres` };
  return { ok: true, value: { planPath, summary } };
}

/** El plan contra el mensaje en curso y el workspace: ruta exacta, archivo escrito y al menos una entrada en Cambios. */
export function validatePlanFile(plan: PlanExit, ctx: { dir: string; messageId: string }): { ok: true } | { ok: false; error: string } {
  const expected = planPathFor(ctx.messageId);
  if (plan.planPath !== expected) return { ok: false, error: `planPath: debe ser exactamente ${expected}` };
  const file = join(ctx.dir, expected);
  if (!existsSync(file)) return { ok: false, error: `${expected} no existe: escríbelo antes de llamar a ${EXIT_PLAN_TOOL}` };
  if (!parsePagePlanMd(changesOf(readFileSync(file, 'utf8'))).sections.length) {
    return { ok: false, error: 'el plan necesita una sección `## Cambios` con al menos una entrada `## NN-<rol> · #<ancla>`' };
  }
  return { ok: true };
}

export const EXIT_PLAN_TOOL_DEF = {
  name: EXIT_PLAN_TOOL,
  description: 'Entrega el plan a la persona para que lo apruebe, lo edite o lo rechace. Llámala una sola vez, cuando `.wt/plans/<id>.md` esté escrito. Después de llamarla no escribas nada más: termina el turno.',
  input_schema: {
    type: 'object',
    properties: {
      planPath: { type: 'string', description: 'la ruta del plan que escribiste: .wt/plans/<id>.md' },
      summary: { type: 'string', maxLength: MAX_SUMMARY, description: `una línea con lo que cambia el plan, hasta ${MAX_SUMMARY} caracteres, en el idioma de la página` },
    },
    required: ['planPath', 'summary'],
    additionalProperties: false,
  },
};
