// DS-skill de Arc al estilo v0 (docs/notas/v0-reverse-engineering.md): lo que el agente compositor
// LEE antes de escribir una página. v0 "se ancla en la fuente real; si un componente, prop o token no
// se puede verificar, no lo usa", así que todo lo que sale de aquí se deriva del catálogo y del doc.md
// del vault, nunca se redacta a mano. Este módulo es puro: el IO vive en scripts/build-ds-skill.ts.

import type { CatalogEntry } from './catalog/schema';
import { ARC_SHOWCASE } from './catalog/ingest-arc';
import { importLine } from './catalog/import-line';

/** Lo que el verificador del agente contrasta: si no está aquí, el import no existe. */
export interface AllowEntry {
  export: string;
  exportDefault?: boolean;
  importPath: string;
  kind: CatalogEntry['kind'];
  role?: string;
  /** Ruta del schema de props relativa a la raíz del repo, o null si el componente no tiene uno. */
  schema: string | null;
  /** Hornea su demo y no acepta copy: solo sirve como showcase, nunca como sección de contenido. */
  propless: boolean;
  /** Props que reciben JSX (ReactNode): donde el agente puede anidar otros componentes. Vacío =
   * hoja, solo se le pasan datos. Es lo que permite componer primitivas y no solo elegir organismos. */
  accepts: ChildSlot[];
  /** Lo que el componente aporta como relleno de un slot de organismo (catalog/slot-semantics.json). */
  provides: string[];
  /** Solo organismos: slots declarados en su schema (`x-slot`), con la semántica que admiten. */
  slots?: { path: string; accepts: string[]; cardinality: string }[];
  /** Textos y assets de la demo del componente: un prop que llega con uno de ellos copió la demo. */
  demoStrings?: string[];
  /** Átomos: categoría del registry del vault (actions, data, text...), que usa el shortlist porque no
   * tienen rol y `provides` está vacío en casi todos. Blocks: la del catálogo (cta-sections, app-ui). */
  category?: string;
  /** Una frase de para qué sirve (la misma del índice). */
  summary?: string;
  whenToUse?: string[];
  /** Blocks y cáscaras: forma visible (columnas, imagen, tarjetas, alineación) desde tags + geometry del
   * catálogo. Campo propio y no whenToUse: el shortlist tokeniza whenToUse contra el brief y esto ensuciaría
   * el ranking de átomos. Sin él el modelo elegía entre maduros solo por slug y repetía el mismo bloque. */
  form?: string;
  /** Resultados reales por item (los pone build-registry); 'none' = no se corrió, nunca se infiere. */
  gates?: ItemGates;
  /** Rol del block en el patrón 2-layer (ADR 0001): 'section' = sección de landing, 'showcase' =
   * interior de otra sección (ai-chat, market-terminal...). Solo en blocks y cáscaras con rol. */
  usage?: 'section' | 'showcase';
}

export type GateResult = 'ok' | 'fail' | 'none';

export interface ItemGates {
  /** gate estático del ingest de catálogo: deps declaradas, clausura de imports, export. */
  static: GateResult;
  /** el schema valida los ejemplos/demo del item (no es verify: no hay sección del modelo). */
  schemaDemo: GateResult;
  /** render-gate por item; solo vale si se corrió sobre los mismos archivos que se publican. */
  renderGate: GateResult;
}

export interface ChildSlot {
  prop: string;
  type: string;
  required: boolean;
}

/** El parser de doc.md deja la marca de obligatorio pegada al nombre ("items` (required)"). */
const cleanPropName = (name: string): { prop: string; required: boolean } => {
  const required = /\(required\)/.test(name);
  return { prop: name.replace(/`?\s*\(required\)/, '').replace(/`/g, '').trim(), required };
};

/** `children` heredado: la tabla del doc.md (y el schema que sale de ella) solo lista los props
 * propios, pero un `XProps extends ButtonHTMLAttributes<…>` recibe children aunque no lo diga. Sin
 * esto el verify rechaza `<Button>Empezar</Button>`. Un `Omit<…, "children">` lo excluye a propósito. */
export function inheritsChildren(source: string, exportName: string): boolean {
  const m = new RegExp(`interface\\s+${exportName}Props\\s+extends\\s+([^{]+)\\{`).exec(source);
  if (!m) return false;
  const base = m[1];
  if (!/HTMLAttributes|ComponentProps(WithoutRef|WithRef)?</.test(base)) return false;
  return !/Omit<[^>]*>?[^{]*["']children["']/.test(base);
}

/** `type XProps = Omit<..., "children"> & { children?: ReactNode }`: las cáscaras Relume quitan el children
 * de HTML y declaran el suyo, que es el slot de la sección. */
export function declaresChildren(source: string, exportName: string): boolean {
  return new RegExp(`type\\s+${exportName}Props\\s*=[^;]*\\{\\s*children\\??\\s*:\\s*ReactNode`).test(source);
}

export function childSlotsOf(e: CatalogEntry, source = ''): ChildSlot[] {
  const own = (e.manifest?.props ?? [])
    .filter((p) => /ReactNode|ReactElement|JSX\.Element/.test(p.type) || /^children\b/.test(p.name))
    .map((p) => ({ ...cleanPropName(p.name), type: p.type }));
  if (own.some((s) => s.prop === 'children') || !(inheritsChildren(source, e.export) || declaresChildren(source, e.export))) return own;
  return [...own, { prop: 'children', type: 'ReactNode', required: false }];
}

/** Slots `x-slot` de un schema de bloque, recorriendo properties e items (paths `a.b`, `a[].b`). */
export function schemaSlots(schema: unknown, path = ''): { path: string; accepts: string[]; cardinality: string }[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const here: { path: string; accepts: string[]; cardinality: string }[] = [];
  const slot = node['x-slot'] as { accepts?: string[]; cardinality?: string } | undefined;
  if (slot?.accepts) here.push({ path, accepts: slot.accepts, cardinality: slot.cardinality ?? 'one' });
  const props = node.properties as Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(props ?? {})) here.push(...schemaSlots(v, path ? `${path}.${k}` : k));
  if (node.items) here.push(...schemaSlots(node.items, `${path}[]`));
  return here;
}

/** Secciones del doc.md que no sirven al compositor: instalan, miden o repiten lo que el schema ya dice. */
const DROPPED_SECTIONS = new Set(['installation', 'performance', 'keyboard interactions', 'guidance for ai tools']);

// Los doc.md se escribieron para el registry shadcn de Arc (`@/components/uikit/...`); el scaffold
// generado vendoriza en `@/components/arc/...`.
export const rewriteImports = (text: string): string => text.replaceAll('@/components/uikit/', '@/components/arc/');

/** Las notas de Arc invitan a editar los archivos internos del bloque ("Replace the copy in
 * hero-lumen.tsx"). Aquí eso viola la regla dura de la meta (el agente nunca reescribe la maquetación
 * interna), así que esas líneas se quitan en vez de dejar dos instrucciones que se contradicen. */
const EDITS_INTERNALS = /\b[\w-]+\.(tsx|ts|module\.css|css)\b|replace the copy in|edit the (file|source)/i;

/** Parte el doc.md por encabezados `## ` y conserva el preámbulo (título y descripción). */
export function splitSections(doc: string): { preamble: string; sections: { title: string; body: string }[] } {
  const parts = doc.split(/^## /m);
  const preamble = parts[0] ?? '';
  const sections = parts.slice(1).map((p) => {
    const nl = p.indexOf('\n');
    return { title: (nl < 0 ? p : p.slice(0, nl)).trim(), body: nl < 0 ? '' : p.slice(nl + 1) };
  });
  return { preamble, sections };
}

/** El doc.md destilado para el compositor: sin instalación ni instrucciones de editar internos, con
 * los imports del scaffold. */
export function distillDoc(doc: string): string {
  const { preamble, sections } = splitSections(doc);
  const keep = sections
    .filter((s) => !DROPPED_SECTIONS.has(s.title.toLowerCase()) && !/^also in /i.test(s.title))
    .map((s) => {
      const body = /^notes for ai$/i.test(s.title)
        ? s.body.split('\n').filter((l) => !(l.trim().startsWith('-') && EDITS_INTERNALS.test(l))).join('\n')
        : s.body;
      return `## ${s.title}\n${body}`;
    });
  return rewriteImports([preamble.replace(/^- Access:.*$/m, '').replace(/^- (Registry id|Source file):.*$/gm, ''), ...keep].join('').replace(/\n{3,}/g, '\n\n'));
}

/** Imports `@/components/arc/...` que el texto nombra y no están en la allowlist: el agente los
 * vería en un ejemplo y los copiaría, así que se avisan en la cabecera de la referencia. */
export function unresolvedImports(text: string, allowed: ReadonlySet<string>): string[] {
  const found = [...text.matchAll(/from ["'](@\/components\/arc\/[^"']+)["']/g)].map((m) => m[1]);
  return [...new Set(found)].filter((p) => !allowed.has(p));
}

/** Carpeta del item en el vault (`ui-react/<blocks|components>/<slug>`) desde la ruta de origen. */
export const vaultItemDir = (originPath: string): string | null => {
  const m = /^(ui-react\/(?:blocks|components)\/[^/]+)\//.exec(originPath);
  return m ? m[1] : null;
};

export const schemaPathOf = (e: CatalogEntry): string =>
  e.kind === 'component' ? `catalog/schemas/components/${e.slug}.schema.json` : `catalog/schemas/${e.slug}.schema.json`;

export function allowEntry(e: CatalogEntry, schema: unknown | null, provides: string[], source = '', demoStrings: string[] = []): AllowEntry {
  const slots = schema ? schemaSlots(schema) : [];
  return {
    export: e.export,
    ...(e.exportDefault ? { exportDefault: true } : {}),
    importPath: e.importPath,
    kind: e.kind,
    ...(e.role ? { role: e.role } : {}),
    // ARC_SHOWCASE les da rol features solo para que entren al pool como interior (ADR 0001): no son secciones.
    ...((e.kind === 'block' || e.kind === 'layout') && e.role ? { usage: ARC_SHOWCASE.has(e.slug) ? 'showcase' as const : 'section' as const } : {}),
    schema: schema ? schemaPathOf(e) : null,
    propless: e.emittable === false,
    accepts: childSlotsOf(e, source),
    provides,
    ...(slots.length ? { slots } : {}),
    ...(demoStrings.length ? { demoStrings } : {}),
    ...(formOf(e) ? { form: formOf(e) } : {}),
  };
}

/** 'standard' es el valor por defecto del ingest: no distingue un bloque de otro. */
export function formOf(e: Pick<CatalogEntry, 'kind' | 'tags' | 'geometry'>): string | undefined {
  if (e.kind !== 'block' && e.kind !== 'layout') return undefined;
  const parts = [...(e.geometry && e.geometry !== 'standard' ? [e.geometry] : []), ...(e.tags ?? [])];
  return parts.length ? parts.join(', ') : undefined;
}

/** Cabecera de la referencia: lo que el verificador necesita sin leer el resto. */
export function referenceHeader(e: CatalogEntry, allow: AllowEntry, unresolved: string[]): string {
  const lines = [
    `<!-- generado por scripts/build-ds-skill.ts desde el catálogo y el doc.md del vault; no editar -->`,
    `- slug: \`${e.slug}\``,
    `- import: \`${importLine(e, '"')}\``,
    `- kind: ${e.kind}${e.role ? ` (rol ${e.role})` : ''}`,
    `- props verificables en: ${allow.schema ? `\`${allow.schema}\`` : 'sin schema: usa solo los props de la tabla de abajo'}`,
  ];
  lines.push(allow.accepts.length
    ? `- acepta componentes dentro de: ${allow.accepts.map((a) => `\`${a.prop}\`${a.required ? ' (obligatorio)' : ''}: \`${a.type}\``).join('; ')}`
    : '- hoja: no recibe JSX, solo datos por props');
  if (allow.provides.length) lines.push(`- rellena slots de organismo de tipo: ${allow.provides.join(', ')}`);
  for (const s of allow.slots ?? []) lines.push(`- slot \`${s.path}\` (${s.cardinality}) admite: ${s.accepts.join(', ')}`);
  if (allow.propless) lines.push('- PROPLESS: hornea su propia demo y no acepta tu contenido. No lo uses como sección de contenido.');
  if (unresolved.length) lines.push(`- AVISO: el ejemplo nombra imports que NO existen en este DS (${unresolved.map((u) => `\`${u}\``).join(', ')}); no los copies.`);
  return `${lines.join('\n')}\n\n`;
}

/** Sin doc.md en el vault: la referencia sale del manifiesto del catálogo, que es lo único verificable. */
export function manifestReference(e: CatalogEntry): string {
  const m = e.manifest;
  const out = [`# ${e.name}\n`];
  if (m?.whenToUse.length) out.push(`## When to use\n${m.whenToUse.map((w) => `- ${w}`).join('\n')}\n`);
  if (m?.whenNotToUse.length) out.push(`## When not to use\n${m.whenNotToUse.map((w) => `- ${typeof w === 'string' ? w : w.text}`).join('\n')}\n`);
  if (m?.props?.length) {
    out.push(`## API reference\n\n| Prop | Type | Default | Description |\n| --- | --- | --- | --- |\n${m.props.map((p) => `| ${p.name} | \`${p.type}\` | ${p.default ?? ''} | ${p.description} |`).join('\n')}\n`);
  }
  return out.join('\n');
}

/** Una línea del índice: lo justo para decidir si vale la pena leer la referencia completa. */
export function indexLine(e: CatalogEntry, allow: AllowEntry, summary: string): string {
  const flags = [allow.propless ? 'propless' : '', allow.accepts.length ? `anida: ${allow.accepts.map((a) => a.prop).join(',')}` : 'hoja'].filter(Boolean);
  return `- \`${e.slug}\` · ${e.export} · [${flags.join(' · ')}] · ${summary}`;
}

/** Primera frase útil del item: la descripción del doc (`> ...`) o, si no hay, su primer whenToUse. */
export function summaryOf(e: CatalogEntry, doc: string | null): string {
  const quote = doc ? /^> (.+)$/m.exec(doc)?.[1] : undefined;
  const raw = quote ?? e.manifest?.whenToUse[0] ?? e.name;
  const first = raw.split(/(?<=\.)\s/)[0];
  return first.length > 180 ? `${first.slice(0, 177)}...` : first;
}

/** Color hex para el swatch de `appearance` (v0 pide hex). Resuelve `var(--x)` contra los tokens dados
 * y convierte oklch acromático (chroma 0, que es la paleta neutral de Arc). Otro formato se devuelve
 * tal cual: el swatch es solo identificación en la UI, no cambia tokens. */
export function swatchHex(value: string, vars: [string, string][], depth = 0): string {
  const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (ref && depth < 5) {
    const next = vars.find(([k]) => k === ref[1])?.[1];
    return next ? swatchHex(next, vars, depth + 1) : value;
  }
  const ok = /^oklch\(\s*([\d.]+)%\s+0\s+0\s*\)$/.exec(value.trim());
  if (!ok) return value;
  const linear = (Number(ok[1]) / 100) ** 3;
  const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  const byte = Math.round(Math.min(1, Math.max(0, srgb)) * 255).toString(16).padStart(2, '0');
  return `#${byte}${byte}${byte}`;
}

/** Tokens semánticos de un bloque CSS `selector { ... }`: nombre -> valor, en orden de aparición. */
export function cssVars(css: string, selector: string): [string, string][] {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return [];
  const body = css.slice(start, css.indexOf('}', start));
  return [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);
}
