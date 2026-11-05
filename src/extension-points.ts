// Ranuras que el DS publica para las variantes de marca (spec docs/spec/ranuras-de-marca.md). Salen del código, nunca
// a mano: el slot es cada `var(--<componente>-<slot>)` que lee el CSS del componente, y la base es la unión del prop.
// parseBrandPack valida un pack contra esto; build-registry lo publica direccionado por contenido junto al índice.

export interface ExtensionPoint {
  /** Prop del componente que elige la variante. */
  prop: string;
  /** Custom properties que una variante de marca puede fijar, sin el prefijo `--<componente>-`. */
  slots: string[];
  /** Variantes del DS: una marca no puede reutilizar estos nombres. */
  base: string[];
}
export type ExtensionPoints = Record<string, ExtensionPoint>;

/** Componentes que abren ranuras y el prop que elige la variante. Abrir uno es una decisión del DS, no del pack. */
export const EXTENSIBLE: Readonly<Record<string, string>> = { badge: 'tone', button: 'variant' };

export interface ComponentSource { tsx: string; css: string }

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ranura de un componente desde su código, o un error que nombra lo que falta: un DS sin slots no abre ranura. */
export function extensionPointOf(name: string, prop: string, src: ComponentSource): ExtensionPoint {
  const typeName = new RegExp(`\\b${escape(prop)}\\?:\\s*([A-Z]\\w*)`).exec(src.tsx)?.[1];
  if (!typeName) throw new Error(`extension points: ${name} no declara el prop "${prop}" con un tipo con nombre`);
  const union = new RegExp(`type\\s+${typeName}\\s*=\\s*([^;]+);`).exec(src.tsx)?.[1];
  if (!union) throw new Error(`extension points: ${name} no declara la unión ${typeName}`);
  const base = [...union.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);
  if (!base.length) throw new Error(`extension points: ${typeName} de ${name} no es una unión de literales`);
  const reads = new RegExp(`var\\(\\s*--${escape(name)}-([a-z][a-z0-9-]*)`, 'g');
  const slots = [...new Set([...src.css.matchAll(reads)].map((m) => m[1]))].sort();
  if (!slots.length) throw new Error(`extension points: ${name} no lee ninguna var(--${name}-*) en su CSS`);
  return { prop, slots, base: [...base].sort() };
}

/** Todas las ranuras, en orden estable: el mismo código da el mismo JSON y el mismo hash. */
export function extensionPoints(sources: Readonly<Record<string, ComponentSource>>, extensible: Readonly<Record<string, string>> = EXTENSIBLE): ExtensionPoints {
  const out: ExtensionPoints = {};
  for (const name of Object.keys(extensible).sort()) {
    const src = sources[name];
    if (!src) throw new Error(`extension points: falta el código de ${name}`);
    out[name] = extensionPointOf(name, extensible[name], src);
  }
  return out;
}
