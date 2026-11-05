// direction.refs: el agente lee el bloque de referencia de la dirección antes de escribir cada sección. Sin esa lectura
// la forma sale del prior del modelo (fac2bce5: 0 de 7 refs leídas y precios en 3 tarjetas con el plan en
// split-media). Decide sobre el stream del CLI (.wt/agent-stream.ndjson), no sobre la página.
// Con Bloque en la fila (ADR 0011 enmienda 1) el agente no lee el ref: importa el bloque que esa corrida eligió, y eso
// se exige. El elegido sale de agent.trace.blocks (page.json), porque depende de la semilla y los recientes; la columna
// Bloque del direction.md entregado queda de respaldo para corridas anteriores a la traza.

import { BLOCK_CANDIDATES, type BlockCandidate, type BlockRole, type Direction } from './directions';
import type { SectionRole } from './types';
import { roleOfKey } from './plan-sensors';
import { directionRole, usesBlock } from './page-sensors';
import { roleOfSlug } from './section-slug';

// Severidad A: es un desvío de la dirección y se reporta, pero no reprueba el turno del agente.
export interface RefDefect { section: string; ref: string; severity: 'A'; message: string }
export interface RefReport { checked: number; read: number; defects: RefDefect[] }

export type DirectionBlocks = Partial<Record<BlockRole, BlockCandidate>>;

/** Los bloques que direction.md asignó a cada rol: la celda Bloque trae el import y, si la tiene, la variante. */
export function directionBlocks(md: string, candidates: readonly BlockCandidate[] = BLOCK_CANDIDATES): DirectionBlocks {
  const out: DirectionBlocks = {};
  for (const line of md.split('\n')) {
    const cell = /^\|\s*([a-z]+)\s*\|\s*`import \{ \w+ \} from "([^"]+)"`(?: con `(\w+)="([^"]+)"`)?/.exec(line);
    if (!cell) continue;
    const [, role, importPath, prop, value] = cell;
    const c = candidates.find((x) => x.role === role && x.importPath === importPath && x.variant?.prop === prop && x.variant?.value === value);
    if (c) out[c.role] = c;
  }
  return out;
}

export interface TraceBlock { role: string; id: string; importPath: string; variant?: { prop: string; value: string } }

/** Los bloques de agent.trace.blocks. Uno que ya no está entre los candidatos (catálogo de otro commit) se exige igual por
 * su import y variante, sin formas: su forma en el DOM no se mide. */
export function traceBlocks(trace: readonly TraceBlock[], candidates: readonly BlockCandidate[] = BLOCK_CANDIDATES): DirectionBlocks {
  return Object.fromEntries(trace.map((t) => [t.role, candidates.find((c) => c.id === t.id) ?? { ...t, role: t.role as SectionRole, exportName: '', forms: [] }]));
}

// roleOfKey agrupa navbar y footer en 'frame'; aquí hace falta distinguir la barra, que puede tener bloque.
const NAVBAR_ROLES: ReadonlySet<string> = new Set(['navbar', 'nav', 'header', 'navegacion']);
const isNavbarSlug = (slug: string): boolean => /^\d{2}-[a-z0-9-]+$/.test(slug) && NAVBAR_ROLES.has(roleOfSlug(slug));
const SECTION_FILE = /(?:^|\/)src\/sections\/(\d{2}-[a-z0-9-]+)\.tsx$/;

interface ToolCall { name: string; input: Record<string, unknown> }

function toolCalls(stream: string): ToolCall[] {
  return stream.split('\n').flatMap((line) => {
    let e: { type?: string; message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] } };
    try {
      e = JSON.parse(line);
    } catch {
      return [];
    }
    if (e.type !== 'assistant') return [];
    return (e.message?.content ?? []).filter((c) => c.type === 'tool_use' && c.name).map((c) => ({ name: c.name as string, input: c.input ?? {} }));
  });
}

/** Lo que vale para una sección: el import del bloque en las filas con Bloque y el Read del ref en las demás. "casos"
 * puede seguir la fila stats o los testimonios de la dirección, y cualquiera de las dos cumple. */
function candidates(slug: string, d: Direction, blocks: DirectionBlocks): { refs: string[]; picked: BlockCandidate[] } {
  // La barra no tiene fila en la dirección: solo se exige cuando direction.md le dio bloque.
  const role = isNavbarSlug(slug) ? 'navbar' : directionRole(slug);
  const roles = [role, ...(roleOfKey(slug) === 'cases' ? ['stats'] : [])].filter((r) => Object.hasOwn(d.roles, r) || (r === 'navbar' && blocks.navbar)) as BlockRole[];
  return {
    refs: roles.filter((r): r is SectionRole => r !== 'navbar' && !blocks[r]).map((r) => d.roles[r].ref),
    picked: roles.flatMap((r) => blocks[r] ?? []),
  };
}

const written = (c: ToolCall): string => [c.input.content, c.input.new_string].filter((x) => typeof x === 'string').join('\n');
const blockName = (b: BlockCandidate) => `${b.importPath}${b.variant ? ` con ${b.variant.prop}="${b.variant.value}"` : ''}`;

/** Una sección por primer Write de src/sections/NN-<slug>.tsx. Con ref cuenta si alguna tool anterior lo citó (Read, Grep
 * o un `cat` por Bash); con bloque, si algún Write o Edit del archivo lo importa, porque el import puede llegar después. */
/** `planned`: los slugs de page-plan.md. Con plan, una sección que el agente escribió fuera de él no se exige. */
export function directionRefDefects(stream: string, d: Direction, blocks: DirectionBlocks = {}, planned?: ReadonlySet<string>): RefReport {
  const calls = toolCalls(stream);
  const pathOf = (c: ToolCall) => (typeof c.input.file_path === 'string' ? c.input.file_path : '');
  const seen: string[] = [];
  const done = new Set<string>();
  const defects: RefDefect[] = [];
  let checked = 0;
  for (const call of calls) {
    const path = pathOf(call);
    const slug = call.name === 'Write' ? SECTION_FILE.exec(path)?.[1] : undefined;
    if (slug && !done.has(slug) && (!planned || planned.has(slug))) {
      done.add(slug);
      const { refs, picked } = candidates(slug, d, blocks);
      if (refs.length || picked.length) {
        checked += 1;
        const code = calls.filter((c) => (c.name === 'Write' || c.name === 'Edit') && SECTION_FILE.exec(pathOf(c))?.[1] === slug).map(written).join('\n');
        const ok = refs.some((ref) => seen.some((s) => s.includes(`relume/${ref}`))) || picked.some((b) => usesBlock(code, b));
        const want = [...picked.map((b) => `el import de ${blockName(b)}`), ...refs.map((r) => `leer antes relume/${r}`)].join(' o ');
        if (!ok) defects.push({ section: slug, severity: 'A', ref: [...picked.map((b) => b.id), ...refs].join(' | '), message: `${slug}: se escribió sin ${want}` });
      }
    }
    seen.push(JSON.stringify(call.input));
  }
  return { checked, read: checked - defects.length, defects };
}
