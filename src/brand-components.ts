// Ranuras de variantes de marca (docs/spec/ranuras-de-marca.md): una marca suma variantes a componentes del DS sin
// ampliar el contrato para todas. El DS publica qué acepta cada componente (extension-points.json, con el pin); aquí
// se valida lo que declara el pack contra eso y se baja a CSS, a tipos del workspace y al skill.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast, MIN_CONTRAST, parseColor, type Rgb } from './color-contrast';
import { EXTENSIBLE, extensionPointOf, type ExtensionPoints } from './extension-points';

export type { ExtensionPoint, ExtensionPoints } from './extension-points';

export interface BrandVariant { use: string; values: Record<string, string> }
/** componente → el prop que elige la variante y sus variantes de marca. */
export type BrandComponents = Record<string, { prop: string; variants: Record<string, BrandVariant> }>;

export const MAX_VARIANTS_PER_COMPONENT = 3;
export const MAX_VARIANTS_PER_PACK = 12;
const VARIANT_NAME = /^[a-z][a-z0-9-]{1,23}$/;
const IDENT = /^[a-z][a-z0-9-]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && IDENT.test(s));

/** extension-points.json viene del registry (Blob): se valida igual que un pack, porque sus nombres terminan en selectores. */
export function parseExtensionPoints(raw: unknown): ExtensionPoints {
  if (!isObject(raw)) throw new Error('extension-points: se esperaba un objeto {componente: {prop, slots, base}}');
  const out: ExtensionPoints = {};
  for (const [component, point] of Object.entries(raw)) {
    if (!IDENT.test(component) || !isObject(point) || typeof point.prop !== 'string' || !IDENT.test(point.prop) || !isStrList(point.slots) || !isStrList(point.base)) {
      throw new Error(`extension-points: "${component}" necesita prop, slots y base con nombres en minúscula`);
    }
    out[component] = { prop: point.prop, slots: point.slots, base: point.base };
  }
  return out;
}

/** Sin registry (emit local) no hay extension-points publicados: las ranuras salen del código de los componentes
 * extensibles que el workspace ya tiene, con el mismo generador que build-registry. */
export function workspaceExtensionPoints(dir: string): ExtensionPoints {
  const out: ExtensionPoints = {};
  for (const [name, prop] of Object.entries(EXTENSIBLE)) {
    const base = join(dir, 'src', 'components', 'arc', name, name);
    if (!existsSync(`${base}.tsx`) || !existsSync(`${base}.module.css`)) continue;
    out[name] = extensionPointOf(name, prop, { tsx: readFileSync(`${base}.tsx`, 'utf8'), css: readFileSync(`${base}.module.css`, 'utf8') });
  }
  return out;
}

export interface ComponentsContext {
  points: ExtensionPoints | undefined;
  /** El pin que publicó `points`, para que el error diga contra qué se validó. */
  pin?: string;
  isContractToken: (name: string) => boolean;
  /** El guard de valores CSS de brand.ts: lanza si el valor podría salir de su declaración. */
  cssValue: (field: string, value: string) => string;
}

const HEX = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i;
const VAR = /^var\((--[a-z0-9-]+)\)$/;
const MIX = /^color-mix\(in (?:srgb|oklch|oklab|hsl), *(.+?)(?: +\d{1,3}%)?, *(.+?)(?: +\d{1,3}%)?\)$/;

// Un valor de variante es un token del contrato, un hex, o un color-mix() entre esos dos: nada que no siga a la marca o
// que no se pueda leer. Un var() de otro componente ataría la variante a la implementación de ese componente.
function variantValue(field: string, value: string, ctx: ComponentsContext): string {
  const v = ctx.cssValue(field, value).trim();
  const plain = (a: string): boolean => {
    const ref = VAR.exec(a.trim());
    return HEX.test(a.trim()) || (!!ref && ctx.isContractToken(ref[1]));
  };
  const mix = MIX.exec(v);
  if (plain(v) || (mix && plain(mix[1]) && plain(mix[2]))) return v;
  throw new Error(`brand pack: ${field} tiene que ser var(--token del contrato), un hex o color-mix() entre esos`);
}

/** Valida `components` en la frontera de confianza. Sin `points` falla cerrado: no hay contra qué validar slots. */
export function parseComponents(raw: unknown, requiresDs: string | undefined, ctx: ComponentsContext): BrandComponents | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new Error('brand pack: "components" debe ser un objeto');
  if (!requiresDs) throw new Error('brand pack: "components" necesita requires.ds, el pin con el que se validó');
  if (!ctx.points) throw new Error('brand pack: "components" necesita los extension points del pin activo para validarse');
  const against = `en el pin ${ctx.pin ?? 'activo'} (el pack se validó con ${requiresDs})`;
  const out: BrandComponents = {};
  let total = 0;
  for (const [component, entry] of Object.entries(raw)) {
    const point = ctx.points[component];
    if (!point) throw new Error(`brand pack: components.${component} no publica ranuras ${against}`);
    if (!isObject(entry) || !isObject(entry.variants)) throw new Error(`brand pack: components.${component}.variants debe ser un objeto`);
    const names = Object.keys(entry.variants);
    if (names.length > MAX_VARIANTS_PER_COMPONENT) throw new Error(`brand pack: components.${component} declara ${names.length} variantes, máximo ${MAX_VARIANTS_PER_COMPONENT}`);
    total += names.length;
    if (total > MAX_VARIANTS_PER_PACK) throw new Error(`brand pack: el pack declara más de ${MAX_VARIANTS_PER_PACK} variantes`);
    const variants: Record<string, BrandVariant> = {};
    for (const [name, def] of Object.entries(entry.variants)) {
      const at = `components.${component}.variants.${name}`;
      if (!VARIANT_NAME.test(name)) throw new Error(`brand pack: ${at}: el nombre tiene que cumplir ${VARIANT_NAME.source}`);
      if (point.base.includes(name)) throw new Error(`brand pack: ${at}: "${name}" es una variante base de ${component}; una marca no la pisa`);
      if (!isObject(def)) throw new Error(`brand pack: ${at} debe ser un objeto`);
      const { use, ...slots } = def;
      // use es lo que lee el agente para elegir la variante: sin él la variante existe pero nadie sabe cuándo va.
      if (typeof use !== 'string' || !use.trim()) throw new Error(`brand pack: ${at}.use es obligatorio`);
      const values: Record<string, string> = {};
      for (const [slot, value] of Object.entries(slots)) {
        if (!point.slots.includes(slot)) throw new Error(`brand pack: ${at}.${slot} no es un slot de ${component} ${against}`);
        if (typeof value !== 'string' || !value) throw new Error(`brand pack: ${at}.${slot} debe ser un string no vacío`);
        values[slot] = variantValue(`${at}.${slot}`, value, ctx);
      }
      if (!Object.keys(values).length) throw new Error(`brand pack: ${at} no fija ningún slot`);
      variants[name] = { use: ctx.cssValue(`${at}.use`, use.trim()), values };
    }
    out[component] = { prop: point.prop, variants };
  }
  return Object.keys(out).length ? out : undefined;
}

// Un var() se sigue por la tabla del tema hasta un color; color-mix, un translúcido sin fondo o un ciclo dan null y el par no se mide.
function resolveColor(value: string, theme: Record<string, string>, depth = 0, backdrop?: Rgb): Rgb | null {
  const ref = VAR.exec(value.trim());
  if (!ref) return parseColor(value, backdrop);
  const next = theme[ref[1]];
  return next === undefined || depth > 8 ? null : resolveColor(next, theme, depth + 1, backdrop);
}

/** Texto sobre fondo de cada variante, en claro y en oscuro: un hex fijo que se lee en claro puede no leerse en oscuro. */
export function variantContrastErrors(components: BrandComponents, themes: { light: Record<string, string>; dark: Record<string, string> }): string[] {
  const out: string[] = [];
  for (const [component, { variants }] of Object.entries(components)) {
    for (const [name, { values }] of Object.entries(variants)) {
      if (!values.foreground || !values.background) continue;
      for (const [theme, table] of Object.entries(themes)) {
        // Un fondo translúcido se ve sobre el --background de la zona; el texto, sobre ese fondo ya compuesto.
        const page = table['--background'] ? resolveColor(table['--background'], table) : null;
        const bg = resolveColor(values.background, table, 0, page ?? undefined);
        const fg = bg ? resolveColor(values.foreground, table, 0, bg) : null;
        if (!fg || !bg) continue;
        const ratio = contrast(fg, bg);
        if (ratio < MIN_CONTRAST) out.push(`brand pack: components.${component}.variants.${name}: foreground sobre background tiene ${ratio.toFixed(2)}:1 en tema ${theme === 'light' ? 'claro' : 'oscuro'}, mínimo ${MIN_CONTRAST}:1`);
      }
    }
  }
  return out;
}

/** Reglas de identity.css: el componente pinta data-component y data-brand-variant, y lee --<componente>-<slot>. El
 * selector de dos atributos le gana a la clase del módulo, cuyo nombre lleva hash y no se puede nombrar desde aquí. */
export function variantsCss(components: BrandComponents | undefined): string {
  if (!components) return '';
  const rules = Object.entries(components).flatMap(([component, { variants }]) =>
    Object.entries(variants).map(([name, { values }]) => {
      const decls = Object.entries(values).map(([slot, v]) => `--${component}-${slot}: ${v};`);
      return `[data-component="${component}"][data-brand-variant="${name}"] {\n  ${decls.join('\n  ')}\n}`;
    }),
  );
  return rules.length ? `${rules.join('\n')}\n` : '';
}

const pascal = (s: string): string => s.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

/** Un <componente>.brand.ts por componente con ranuras, en la carpeta del componente para que el item del registry
 * sea autosuficiente. Sin variantes el tipo es never, así que typecheck rechaza una variante que el pack no declaró. */
export function brandVariantFiles(points: ExtensionPoints, components: BrandComponents | undefined): { path: string; content: string }[] {
  return Object.entries(points).map(([component, { prop }]) => {
    const names = Object.keys(components?.[component]?.variants ?? {});
    return {
      path: `src/components/arc/${component}/${component}.brand.ts`,
      content: [
        `// Generado desde el brand pack: variantes de ${component} que declara la marca. No editar a mano.`,
        `export type Brand${pascal(component)}${pascal(prop)} = ${names.length ? names.map((n) => `'${n}'`).join(' | ') : 'never'};`,
        '',
      ].join('\n'),
    };
  });
}

/** references/components/brand-variants.md del skill: qué variante existe, en qué componente y cuándo va. */
export function variantsMd(brandName: string, components: BrandComponents | undefined): string | undefined {
  if (!components) return undefined;
  const rows = Object.entries(components).flatMap(([component, { prop, variants }]) =>
    Object.entries(variants).map(([name, { use }]) => `| ${component} | \`${prop}="${name}"\` | ${use.replace(/\|/g, '\\|')} |`),
  );
  return [
    `# Variantes de ${brandName}`,
    '',
    `${brandName} suma estas variantes a componentes del DS. Se usan como cualquier otra del componente, solo para lo que dice`,
    'su uso. Una variante que no está en esta tabla no existe: typecheck la rechaza.',
    '',
    '| Componente | Prop | Uso |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
