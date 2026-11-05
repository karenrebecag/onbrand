// Política de slots visibles sin dato (spec politica-slots-visibles, D1/D2). Un bloque hornea en su
// .tsx un default demo para cada prop que el binding no pone; sin política, ese demo llega a la página
// (avatares, socials, "1,283 finance teams", la imagen gris del shell). El overlay humano
// catalog/slot-policy.json dice, por slug y prop, qué hacer cuando el binding no trae dato:
//   null / [] / ""  → el vacío que el contrato del bloque admite y que oculta el slot
//   "media"         → es una imagen: se pasa el Default del bloque para que fillImages lo sustituya
//   "omit"          → el contrato no admite vacío y el default es visible: se reporta (demoVisible) y
//                     cuenta como "sin binding" en la elegibilidad
//   { fill, from?, else, keys? } → slot de componente (spec composicion-slots, RF4/RF5): el filler lo
//                     llena con un componente de semántica `fill` desde el rol `from`; sin componente ni
//                     dato cae a `else`. `keys` dice por qué ruta se indexa un slot map.
// `exceptions` lista, con motivo, todo prop que el binding no pone y que a propósito queda en su
// default (config, estado, opcionales invisibles). Un test de inventario exige que nada quede sin
// clasificar: el overlay es la única fuente; el schema solo lo documenta (x-empty).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoleCopy } from '../copy';
import { REPO_ROOT } from './load';
import { SEMANTICS, type SlotSemantic } from './schema';
import { hasSlotValue } from './slot-value';

/** Slot que llena un componente. `else` es lo que queda sin componente ni dato. */
export interface FillRule {
  fill: SlotSemantic[];
  from?: keyof RoleCopy;
  else: null | '' | 'omit';
  /** Solo slots map: ruta cuyo valor es la clave de cada celda (`features[].id`). */
  keys?: string;
}

/** Regla de un slot. El vacío se guarda tal cual (null, [], "") para que el JSON se lea como el prop. */
export type SlotRule = null | [] | '' | 'media' | 'omit' | FillRule;

const COPY_ROLES: readonly (keyof RoleCopy)[] = ['hero', 'logos', 'features', 'steps', 'stats', 'testimonials', 'pricing', 'faq', 'cta', 'navbar', 'footer'];

export interface SlotPolicy {
  version: number;
  rules: Record<string, Record<string, SlotRule>>;
  exceptions: Record<string, Record<string, string>>;
}

export const SLOT_POLICY_PATH = join(REPO_ROOT, 'catalog', 'slot-policy.json');

export const isFillRule = (v: unknown): v is FillRule => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const known = Object.keys(r).every((k) => ['fill', 'from', 'else', 'keys'].includes(k));
  const fill = Array.isArray(r.fill) && r.fill.length > 0 && r.fill.every((s) => (SEMANTICS as readonly unknown[]).includes(s));
  const from = r.from === undefined || (COPY_ROLES as readonly unknown[]).includes(r.from);
  const otherwise = r.else === null || r.else === '' || r.else === 'omit';
  const keys = r.keys === undefined || (typeof r.keys === 'string' && r.keys.length > 0);
  return known && fill && from && otherwise && keys;
};

const isRule = (v: unknown): v is SlotRule =>
  v === null || v === '' || v === 'media' || v === 'omit' || (Array.isArray(v) && v.length === 0) || isFillRule(v);

/** Valida el shape y el vocabulario cerrado. Un valor fuera del vocabulario es error, no extensión. */
export function parseSlotPolicy(raw: unknown, where = 'slot-policy'): SlotPolicy {
  const fail = (what: string): never => { throw new Error(`${where}: ${what}`); };
  if (typeof raw !== 'object' || raw === null) return fail('no es un objeto');
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) fail(`version desconocida: ${String(r.version)}`);
  const rules: SlotPolicy['rules'] = {};
  const exceptions: SlotPolicy['exceptions'] = {};
  for (const [slug, props] of Object.entries((r.rules ?? {}) as Record<string, unknown>)) {
    if (typeof props !== 'object' || props === null) fail(`rules.${slug} no es un objeto`);
    for (const [path, rule] of Object.entries(props as Record<string, unknown>)) {
      if (!isRule(rule)) fail(`rules.${slug}.${path}: regla fuera del vocabulario (null | [] | "" | media | omit | { fill, from?, else, keys? })`);
    }
    rules[slug] = { ...(props as Record<string, SlotRule>) };
  }
  for (const [slug, props] of Object.entries((r.exceptions ?? {}) as Record<string, unknown>)) {
    if (typeof props !== 'object' || props === null) fail(`exceptions.${slug} no es un objeto`);
    for (const [path, why] of Object.entries(props as Record<string, unknown>)) {
      if (typeof why !== 'string' || why.trim() === '') fail(`exceptions.${slug}.${path}: falta el motivo`);
      if (rules[slug]?.[path] !== undefined) fail(`${slug}.${path} está en rules y en exceptions a la vez`);
    }
    exceptions[slug] = { ...(props as Record<string, string>) };
  }
  return { version: 1, rules, exceptions };
}

let cached: SlotPolicy | undefined;

/** Overlay del repo, leído una vez por proceso. Sin overlay no se emite en silencio con demo: error. */
export function loadSlotPolicy(path = SLOT_POLICY_PATH): SlotPolicy {
  if (path === SLOT_POLICY_PATH && cached) return cached;
  if (!existsSync(path)) throw new Error(`slot-policy: falta ${path}`);
  const policy = parseSlotPolicy(JSON.parse(readFileSync(path, 'utf8')), path);
  if (path === SLOT_POLICY_PATH) cached = policy;
  return policy;
}

export const rulesFor = (slug: string, policy = loadSlotPolicy()): Record<string, SlotRule> => policy.rules[slug] ?? {};

/** Segmentos de una ruta de regla: `brands[].icon` → ['brands[]', 'icon']. */
const segments = (path: string): string[] => path.split('.');

const isUnset = (v: unknown): boolean => v === undefined;

/** Escribe `value` en `path` SOLO donde esté sin poner; en un segmento `x[]` recorre cada elemento
 * existente. Inmutable: devuelve copias por el camino tocado y el mismo objeto si no cambió nada. */
function fillUnset(obj: unknown, segs: string[], value: () => unknown): unknown {
  if (segs.length === 0) return obj;
  const [head, ...rest] = segs;
  const isList = head.endsWith('[]');
  const key = isList ? head.slice(0, -2) : head;
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
  const rec = obj as Record<string, unknown>;
  const current = rec[key];
  if (isList) {
    if (!Array.isArray(current)) return obj;
    const items = current.map((it) => (rest.length ? fillUnset(it, rest, value) : it));
    return items.some((it, i) => it !== current[i]) ? { ...rec, [key]: items } : obj;
  }
  if (rest.length === 0) return isUnset(current) ? { ...rec, [key]: value() } : obj;
  if (isUnset(current)) return obj;
  const next = fillUnset(current, rest, value);
  return next === current ? obj : { ...rec, [key]: next };
}

/** Devuelve el valor de una ruta (`a.b`; un `x[]` toma el primer elemento), o undefined. */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of segments(path)) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    const isList = seg.endsWith('[]');
    cur = (cur as Record<string, unknown>)[isList ? seg.slice(0, -2) : seg];
    if (isList) cur = Array.isArray(cur) ? cur[0] : undefined;
  }
  return cur;
}

/** Resuelve el `src` por defecto de un slot `media` del bloque (su propio placeholder), o undefined. */
export type MediaDefault = (slug: string, path: string) => string | undefined;

/** Aplica la política del slug sobre los props que el binding devolvió. Pura. Nunca pisa un valor que
 * el binding puso; `omit` no escribe nada (lo consumen el reporte y la elegibilidad). */
export function applySlotPolicy(slug: string, props: Record<string, unknown>, mediaDefault?: MediaDefault, policy = loadSlotPolicy()): Record<string, unknown> {
  let out: unknown = props;
  for (const [path, rule] of Object.entries(rulesFor(slug, policy))) {
    // Un slot de componente lo decide el filler, no la política: escribir aquí la regla la pintaría como valor.
    if (rule === 'omit' || isFillRule(rule)) continue;
    if (rule === 'media') {
      const src = mediaDefault?.(slug, path);
      if (src === undefined) continue;
      // alt vacío a propósito: no hay copy que describa la foto y el alt del Default es inglés.
      out = fillUnset(out, segments(path), () => ({ src, alt: '' }));
      continue;
    }
    out = fillUnset(out, segments(path), () => (Array.isArray(rule) ? [] : rule));
  }
  return out as Record<string, unknown>;
}

/** Reglas `omit` del slug cuyo prop el binding dejó sin poner: lo que queda en demo a la vista. */
export function unsetOmits(slug: string, props: Record<string, unknown> | undefined, policy = loadSlotPolicy()): string[] {
  return Object.entries(rulesFor(slug, policy))
    .filter(([path, rule]) => (rule === 'omit' || (isFillRule(rule) && rule.else === 'omit')) && isUnset(readPath(props ?? {}, path)))
    .map(([path]) => path)
    .sort();
}

/** Roles cuyo dato ya entró a la página por un slot de este bloque (regla `fill` con `from` y un
 * componente puesto en esa ruta). Como Relume: un rol alimenta un bloque; el que lo consumió deja
 * sin sitio al bloque propio de ese rol (el mismo dato no se pinta dos veces). */
export function consumedRoles(slug: string, props: Record<string, unknown> | undefined, policy = loadSlotPolicy()): (keyof RoleCopy)[] {
  return Object.entries(rulesFor(slug, policy))
    .filter((pair): pair is [string, FillRule] => isFillRule(pair[1]) && pair[1].from !== undefined)
    .filter(([path]) => hasSlotValue(readPath(props ?? {}, path)))
    .map(([, rule]) => rule.from as keyof RoleCopy)
    .sort();
}
