// Verify + AutoFix + lint del agente de composición, replicado de lo observado en v0 (chat j049syuEqqA,
// 2026-10-22, y v0.app/blog v0-composite-model-family). v0 verifica ANTES de escribir contra la fuente
// real ("Checked icon names": greps sobre node_modules del DS, quita lo que no existe), corrige secciones
// ya escritas ("Fixed testimonials layout") y cierra con type-check + navegador. Aquí la fuente real es
// la allowlist del DS-skill y el schema completo de cada componente: lo que no se puede verificar contra
// ellos es una violación, nunca se deja pasar "porque parece razonable".

import type { AllowEntry } from '../ds-skill';
import { isSlotValue } from '../catalog/slot-value';
import { ICON_PREFIX, resolveIcon, type IconLibrary } from '../ds-skill-icons';

export interface Part {
  component: string;
  props: Record<string, unknown>;
}
export interface ComposedSection {
  role: string;
  intent?: string;
  parts: Part[];
}

/** JSON Schema tal como lo escribe gen-schemas (draft-07, subconjunto: type, enum, required, properties,
 * additionalProperties, items, minItems, más las extensiones x-*). */
export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  format?: string;
  'x-slot'?: { accepts: string[]; cardinality?: string };
  'x-nullable'?: boolean;
}

/** Schema por slug, o null si el componente no tiene uno (entonces solo se validan nombres de prop
 * contra `accepts` y la existencia del componente). */
export type SchemaStore = (slug: string) => JsonSchema | null;

export type ViolationCode =
  | 'empty-section'
  | 'unknown-component'
  | 'unknown-icon'
  | 'propless-as-content'
  | 'demo-fallback'
  | 'unknown-prop'
  | 'missing-required'
  | 'wrong-type'
  | 'not-in-enum'
  | 'min-items'
  | 'nesting-not-accepted'
  | 'callback-prop'
  | 'placeholder-text'
  | 'demo-copy';

export interface Violation {
  /** Ruta dentro de la sección: `parts[0].props.items[2].title`. */
  path: string;
  component: string;
  code: ViolationCode;
  detail: string;
}

export interface SectionVerdict {
  ok: boolean;
  violations: Violation[];
  /** AutoFix determinista (como el de v0, sin modelo): quita lo que no existe y no es obligatorio.
   * Presente solo si tras aplicarlo la sección queda sin violaciones; si no, toca reintentar. */
  fix?: { section: ComposedSection; applied: string[] };
  /** Mensaje para el reintento del LLM cuando el fix determinista no alcanza. Vacío si ok. */
  feedback: string;
}

// Un callback no viaja en JSON: el agente no puede pasarlo, y si lo intenta es un string inventado.
const CALLBACK = /^on[A-Z]|^render[A-Z]|^format[A-Z]/;
// Texto de relleno de librería (Relume/Arc/shadcn): delata que el agente copió el ejemplo.
const PLACEHOLDER = /lorem ipsum|goes here|placeholder|your (company|brand|text) here|sample text/i;

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

function typeMatches(want: string | string[], v: unknown): boolean {
  const got = typeOf(v);
  const ok = (w: string): boolean => w === got || (w === 'number' && got === 'integer');
  return Array.isArray(want) ? want.some(ok) : ok(want);
}

interface Ctx {
  allow: Record<string, AllowEntry>;
  schemas: SchemaStore;
  icons?: IconLibrary;
  out: Violation[];
}

/** Valida un valor contra su nodo de schema. `slotOk` = la prop admite JSX (accepts del allowlist o
 * nodo sin type/x-slot del schema), único sitio donde puede ir un `$component` anidado. */
function checkValue(v: unknown, s: JsonSchema | undefined, path: string, component: string, slotOk: boolean, ctx: Ctx): void {
  if (isSlotValue(v)) {
    if (!slotOk) ctx.out.push({ path, component, code: 'nesting-not-accepted', detail: `${v.$component} dentro de una prop que no acepta componentes` });
    checkPart({ component: v.$component, props: { ...(v.props ?? {}), ...(v.children !== undefined ? { children: v.children } : {}) } }, path, ctx);
    return;
  }
  if (v === null && s?.['x-nullable']) return;
  if (typeof v === 'string' && PLACEHOLDER.test(v)) ctx.out.push({ path, component, code: 'placeholder-text', detail: v.slice(0, 80) });
  if (!s) return;
  if (s.type !== undefined && !typeMatches(s.type, v)) {
    ctx.out.push({ path, component, code: 'wrong-type', detail: `se esperaba ${JSON.stringify(s.type)}, llegó ${typeOf(v)}` });
    return;
  }
  if (s.enum && !s.enum.some((e) => e === v)) ctx.out.push({ path, component, code: 'not-in-enum', detail: `${JSON.stringify(v)} no está en ${JSON.stringify(s.enum)}` });
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) ctx.out.push({ path, component, code: 'min-items', detail: `${v.length} < ${s.minItems}` });
    v.forEach((item, i) => checkValue(item, s.items, `${path}[${i}]`, component, slotOk || isOpenSlot(s.items), ctx));
    return;
  }
  if (typeOf(v) === 'object') checkObject(v as Record<string, unknown>, s, path, component, slotOk, ctx);
}

/** Un nodo sin `type` (ReactNode en gen-schemas) o con x-slot admite un componente anidado. */
const isOpenSlot = (s: JsonSchema | undefined): boolean => s !== undefined && (s.type === undefined || s['x-slot'] !== undefined);

function checkObject(obj: Record<string, unknown>, s: JsonSchema, path: string, component: string, slotOk: boolean, ctx: Ctx): void {
  for (const r of s.required ?? []) {
    if (obj[r] === undefined) ctx.out.push({ path: `${path}.${r}`, component, code: 'missing-required', detail: r });
  }
  for (const [k, v] of Object.entries(obj)) {
    const child = s.properties?.[k];
    if (!child && s.additionalProperties === false) {
      ctx.out.push({ path: `${path}.${k}`, component, code: 'unknown-prop', detail: k });
      continue;
    }
    const extra = typeof s.additionalProperties === 'object' ? s.additionalProperties : undefined;
    checkValue(v, child ?? extra, `${path}.${k}`, component, slotOk || isOpenSlot(child), ctx);
  }
}

/** Strings de un valor de props con su ruta, sin entrar en componentes anidados (cada uno se compara
 * con su propia demo cuando se verifica). */
function stringsIn(v: unknown, path: string): [string, string][] {
  if (typeof v === 'string') return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => stringsIn(x, `${path}[${i}]`));
  if (v && typeof v === 'object' && !isSlotValue(v)) return Object.entries(v).flatMap(([k, x]) => stringsIn(x, `${path}.${k}`));
  return [];
}

function checkPart(part: Part, path: string, ctx: Ctx): void {
  if (part.component.startsWith(ICON_PREFIX)) {
    const ref = part.component.slice(ICON_PREFIX.length);
    if (!ctx.icons || !resolveIcon(ctx.icons, ref)) ctx.out.push({ path, component: part.component, code: 'unknown-icon', detail: `${ref} no existe en la librería de iconos` });
    return;
  }
  const entry = ctx.allow[part.component];
  if (!entry) {
    ctx.out.push({ path, component: part.component, code: 'unknown-component', detail: `${part.component} no existe en el DS` });
    return;
  }
  const raw = part.props ?? {};
  const keys = Object.keys(raw);
  // Un propless hornea su demo: con o sin props, lo que se ve no es del brief (e2e de orq 2026-10-22:
  // usage-pricing y scroll-story con props [] dejaron "Q3 launch plan" en la página).
  if (entry.propless) {
    ctx.out.push({ path, component: part.component, code: 'propless-as-content', detail: `hornea su propia demo${keys.length ? `; ignoró ${keys.join(', ')}` : ''}; usa otro componente` });
    return;
  }
  if (entry.demoStrings?.length) {
    const demo = new Set(entry.demoStrings);
    for (const [where, v] of stringsIn(raw, `${path}.props`)) {
      if (demo.has(v)) ctx.out.push({ path: where, component: part.component, code: 'demo-copy', detail: `"${v.slice(0, 60)}" es de la demo del componente; usa contenido del negocio, real o plausible inventado para él` });
    }
  }
  for (const k of keys) {
    if (CALLBACK.test(k)) ctx.out.push({ path: `${path}.props.${k}`, component: part.component, code: 'callback-prop', detail: `${k} es un callback; no se compone desde JSON` });
  }
  // El callback ya quedó reportado; validarlo además contra su tipo duplicaría la violación y le
  // quitaría al autofix la posibilidad de resolverlo quitándolo.
  const props = Object.fromEntries(Object.entries(raw).filter(([k]) => !CALLBACK.test(k)));
  const accepts = new Set(entry.accepts.map((a) => a.prop));
  const schema = ctx.schemas(part.component);
  if (!schema) {
    for (const [k, v] of Object.entries(props)) checkValue(v, undefined, `${path}.props.${k}`, part.component, accepts.has(k), ctx);
    for (const a of entry.accepts) {
      if (a.required && props[a.prop] === undefined) ctx.out.push({ path: `${path}.props.${a.prop}`, component: part.component, code: 'missing-required', detail: a.prop });
    }
    return;
  }
  // Los props heredados que la allowlist declara (children de un HTMLAttributes) no están en el schema,
  // que solo trae los propios: se abren aquí en vez de rechazar `<Button>Empezar</Button>`.
  const inherited = Object.fromEntries(entry.accepts.filter((a) => !schema.properties?.[a.prop]).map((a) => [a.prop, {} as JsonSchema]));
  checkObject(props, { ...schema, properties: { ...schema.properties, ...inherited } }, `${path}.props`, part.component, false, ctx);
  // Sin título, un organismo Arc cae a su demo (hero-section pinta Lumen/Relay/Cadence): el título del
  // schema (format heading) es el interruptor entre contenido propio y demo. El resto lo mide el render-gate.
  if (entry.kind === 'block' && schema.properties?.title?.format === 'heading' && props.title === undefined) {
    ctx.out.push({ path: `${path}.props.title`, component: part.component, code: 'demo-fallback', detail: 'sin title el organismo muestra su demo' });
  }
}

/** Violaciones que el AutoFix determinista resuelve quitando algo sin inventar contenido. */
const REMOVABLE: ReadonlySet<ViolationCode> = new Set(['unknown-prop', 'callback-prop']);

function stripPath(section: ComposedSection, path: string): ComposedSection {
  const m = /^parts\[(\d+)\]\.props\.([^.[\]]+)$/.exec(path);
  if (!m) return section;
  const i = Number(m[1]);
  return {
    ...section,
    parts: section.parts.map((p, j) => (j === i ? { ...p, props: Object.fromEntries(Object.entries(p.props ?? {}).filter(([k]) => k !== m[2])) } : p)),
  };
}

function feedbackOf(role: string, violations: Violation[]): string {
  if (!violations.length) return '';
  const lines = violations.map((v) => `- ${v.path} (${v.component}): ${v.code}: ${v.detail}`);
  return `La sección "${role}" no pasó la verificación contra el DS. Corrige SOLO esto y devuelve la sección completa otra vez:\n${lines.join('\n')}\nUsa solo componentes de references/index.md y props de su schema; si no puedes verificar algo, no lo uses.`;
}

/** Verifica UNA sección compuesta contra la allowlist y el schema COMPLETO de cada componente. */
/** `icons` es opcional para no romper a quien ya llama con tres argumentos; sin él, todo `icon:` es
 * desconocido (nada sin verificar). */
export function verifySection(section: ComposedSection, allowlist: Record<string, AllowEntry>, schemas: SchemaStore, icons?: IconLibrary): SectionVerdict {
  const parts = Array.isArray(section?.parts) ? section.parts : [];
  if (!parts.length) {
    const violations: Violation[] = [{ path: 'parts', component: '-', code: 'empty-section', detail: `la sección ${section?.role ?? '?'} volvió sin partes` }];
    return { ok: false, violations, feedback: feedbackOf(section?.role ?? '?', violations) };
  }
  const run = (s: ComposedSection): Violation[] => {
    const ctx: Ctx = { allow: allowlist, schemas, icons, out: [] };
    s.parts.forEach((p, i) => checkPart(p, `parts[${i}]`, ctx));
    return ctx.out;
  };
  const violations = run({ ...section, parts });
  if (!violations.length) return { ok: true, violations, feedback: '' };
  const verdict: SectionVerdict = { ok: false, violations, feedback: feedbackOf(section.role, violations) };
  if (violations.every((v) => REMOVABLE.has(v.code) && /^parts\[\d+\]\.props\.[^.[\]]+$/.test(v.path))) {
    const fixed = violations.reduce((s, v) => stripPath(s, v.path), { ...section, parts });
    if (!run(fixed).length) verdict.fix = { section: fixed, applied: violations.map((v) => `quitado ${v.path}`) };
  }
  return verdict;
}

export interface PageLint {
  ok: boolean;
  violations: (Violation & { role: string })[];
}

/** Lint final de la página ensamblada (el linter de cierre de v0): cada sección re-verificada, sin
 * secciones vacías ni roles duplicados. */
export function lintPage(sections: ComposedSection[], allowlist: Record<string, AllowEntry>, schemas: SchemaStore, icons?: IconLibrary): PageLint {
  const out: (Violation & { role: string })[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.role)) out.push({ role: s.role, path: 'role', component: '-', code: 'empty-section', detail: `rol ${s.role} repetido` });
    seen.add(s.role);
    for (const v of verifySection(s, allowlist, schemas, icons).violations) out.push({ role: s.role, ...v });
  }
  return { ok: out.length === 0, violations: out };
}
