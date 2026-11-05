// Tools que el agente compositor llama ÉL MISMO antes y después de escribir, como el agente de v0 con
// bash en su sandbox ("Checked icon names", leer el .d.ts del componente): verificar con evidencia
// propia en vez de recibir un veredicto desde fuera al final. Definición en formato de tool de la API
// de Anthropic (name, description, input_schema) + un handler puro por tool. El transporte es de quien
// orquesta el loop.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AllowEntry } from '../ds-skill';
import { checkIconNames, searchIcons, type IconLibrary } from '../ds-skill-icons';
import { checkLayout } from './layout-check';
import { verifySection, type ComposedSection, type SchemaStore } from './verify';

export interface ToolContext {
  skillDir: string;
  allowlist: Record<string, AllowEntry>;
  schemas: SchemaStore;
  icons?: IconLibrary;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'read_component_doc',
    description: 'Lee la referencia completa de un componente del DS (import, props, cuándo usarlo, ejemplo). Úsala antes de usar un componente por primera vez.',
    input_schema: { type: 'object', properties: { slug: { type: 'string', description: 'slug exacto del índice' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'check_icon_names',
    description: 'Verifica iconos `<set>/<Nombre>` contra la librería instalada (sets propios + lucide). Devuelve ok/MISSING y el canónico si era un alias. No uses un icono MISSING.',
    input_schema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string', description: '<set>/<Nombre>, p. ej. interface/RocketIcon' }, minItems: 1 } }, required: ['names'], additionalProperties: false },
  },
  {
    name: 'list_icons',
    description: 'Busca iconos por texto en la librería (sets propios primero, luego lucide). Devuelve referencias `<set>/<Nombre>`.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
  },
  {
    name: 'check_props',
    description: 'Verifica una sección (o partes sueltas) contra el DS: componentes existentes, cada prop contra su schema completo, anidación, iconos, demo filtrada. Devuelve violaciones y, si existe, la sección corregida.',
    input_schema: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        parts: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', properties: { component: { type: 'string' }, props: { type: 'object' } }, required: ['component'], additionalProperties: false },
        },
      },
      required: ['parts'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_layout',
    description: 'Verifica una sección con layout (stack/grid/cluster/split, text, componentes y $slot) antes de escribirla: enums de espaciado/columnas, split de 2 hijos, block solo como único hijo de la sección, $slot solo en props que aceptan JSX, y los props de cada componente contra su schema.',
    input_schema: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        width: { type: 'string' },
        surface: { type: 'string' },
        padding: { type: 'string' },
        children: { type: 'array', minItems: 1, items: { type: 'object' } },
      },
      required: ['role', 'children'],
    },
  },
];

export type ToolResult = { ok: true; content: unknown } | { ok: false; error: string };

/** Ejecuta una tool. La entrada viene del modelo: se valida aquí, nunca se confía en ella (el slug va a
 * una ruta de disco, así que solo se acepta si está en la allowlist). */
export function runTool(name: string, input: unknown, ctx: ToolContext): ToolResult {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'read_component_doc': {
      const slug = args.slug;
      if (typeof slug !== 'string' || !SLUG_RE.test(slug) || !ctx.allowlist[slug]) return { ok: false, error: `componente desconocido: ${String(slug)}` };
      return { ok: true, content: readFileSync(join(ctx.skillDir, 'references', 'components', `${slug}.md`), 'utf8') };
    }
    case 'check_icon_names': {
      const names = args.names;
      if (!Array.isArray(names) || !names.length || !names.every((n) => typeof n === 'string')) return { ok: false, error: 'names debe ser una lista de strings' };
      if (!ctx.icons) return { ok: false, error: 'el skill no trae iconos verificables' };
      return { ok: true, content: checkIconNames(ctx.icons, names as string[]) };
    }
    case 'list_icons': {
      if (!ctx.icons) return { ok: false, error: 'el skill no trae iconos verificables' };
      const q = typeof args.query === 'string' ? args.query.toLowerCase() : '';
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 500) : 100;
      return { ok: true, content: searchIcons(ctx.icons, q, limit) };
    }
    case 'check_props': {
      const parts = args.parts;
      if (!Array.isArray(parts) || !parts.length) return { ok: false, error: 'parts debe ser una lista no vacía' };
      const section: ComposedSection = {
        role: typeof args.role === 'string' ? args.role : 'section',
        parts: parts.map((p) => ({ component: String((p as Record<string, unknown>)?.component ?? ''), props: ((p as Record<string, unknown>)?.props ?? {}) as Record<string, unknown> })),
      };
      const v = verifySection(section, ctx.allowlist, ctx.schemas, ctx.icons);
      return { ok: true, content: { ok: v.ok, violations: v.violations, ...(v.fix ? { fixed: v.fix.section, applied: v.fix.applied } : {}) } };
    }
    case 'check_layout': {
      const v = checkLayout(args, ctx.allowlist, ctx.schemas, ctx.icons);
      return { ok: true, content: { ok: v.ok, violations: v.violations } };
    }
    default:
      return { ok: false, error: `tool desconocida: ${name}` };
  }
}
