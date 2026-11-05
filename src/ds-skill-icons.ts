// Vocabulario de iconos del DS-skill. v0 no usa un icono sin verificarlo contra lo instalado ("Checked
// icon names": grep sobre node_modules/@carbon/icons-react). Aquí las fuentes son las que el scaffold
// de verdad tiene: la librería propia del vault (icons/<cat>/*.svg, convertida a módulos por
// scripts/svg-to-icons.ts) primero, y lucide-react (lockfile) como respaldo genérico.

/** Un set importable: de dónde se importa y qué exports existen (nombres canónicos + alias). */
export interface IconSet {
  id: string;
  title: string;
  importPath: string;
  version?: string;
  names: string[];
  aliases: Record<string, string>;
}

/** Orden = preferencia: el agente busca primero en los sets propios. */
export interface IconLibrary {
  sets: IconSet[];
}

/** Un icono anidado en un prop ReactNode viaja como `{ "$component": "icon:<set>/<Nombre>" }`: misma
 * forma que cualquier slot (slot-value.ts), con un prefijo que lo separa de los slugs del catálogo. */
export const ICON_PREFIX = 'icon:';

/** Exports de un módulo generado por svg-to-icons (`export const XIcon = ...`). */
export function parseIconModule(source: string): string[] {
  return [...new Set([...source.matchAll(/^export const ([A-Z][A-Za-z0-9]*)\s*=/gm)].map((m) => m[1]))].sort();
}

/** Iconos de lucide-react desde su .d.ts. Canónico = `declare const X: LucideIcon`; alias = cada
 * `Y as Z` del export cuyo Y es canónico, salvo las variantes `ZIcon` / `LucideZ`, que repiten nombre. */
export function parseLucideTypes(dts: string): { names: string[]; aliases: Record<string, string> } {
  const names = [...dts.matchAll(/declare const ([A-Z][A-Za-z0-9]*): LucideIcon;/g)].map((m) => m[1]);
  const known = new Set(names);
  const aliases: Record<string, string> = {};
  for (const block of dts.matchAll(/^export \{([^}]*)\};?$/gm)) {
    for (const m of block[1].matchAll(/\b([A-Z][A-Za-z0-9]*) as ([A-Z][A-Za-z0-9]*)\b/g)) {
      const [, from, to] = m;
      if (!known.has(from) || known.has(to) || /Icon$/.test(to) || /^Lucide/.test(to)) continue;
      aliases[to] = from;
    }
  }
  return { names: [...new Set(names)].sort(), aliases: Object.fromEntries(Object.entries(aliases).sort(([a], [z]) => a.localeCompare(z))) };
}

export interface ResolvedIcon {
  set: string;
  name: string;
  importPath: string;
}

/** Resuelve `<set>/<Nombre>` al export canónico, o undefined si no existe (el MISSING de v0). */
export function resolveIcon(lib: IconLibrary, ref: string): ResolvedIcon | undefined {
  const slash = ref.indexOf('/');
  if (slash < 0) return undefined;
  const set = lib.sets.find((s) => s.id === ref.slice(0, slash));
  if (!set) return undefined;
  const raw = ref.slice(slash + 1);
  const name = set.names.includes(raw) ? raw : set.aliases[raw];
  return name ? { set: set.id, name, importPath: set.importPath } : undefined;
}

/** El "Checked icon names" como función: ok/MISSING por referencia, con el canónico si era un alias. */
export function checkIconNames(lib: IconLibrary, refs: string[]): { ref: string; ok: boolean; canonical?: string }[] {
  return refs.map((ref) => {
    const hit = resolveIcon(lib, ref);
    if (!hit) return { ref, ok: false };
    const canonical = `${hit.set}/${hit.name}`;
    return canonical === ref ? { ref, ok: true } : { ref, ok: true, canonical };
  });
}

/** Búsqueda por texto en todos los sets, en orden de preferencia. */
export function searchIcons(lib: IconLibrary, query: string, limit: number): { total: number; refs: string[] } {
  const q = query.toLowerCase();
  const hits = lib.sets.flatMap((s) => s.names.filter((n) => n.toLowerCase().includes(q)).map((n) => `${s.id}/${n}`));
  return { total: hits.length, refs: hits.slice(0, limit) };
}

/** Referencia legible: un bloque por set, en orden de preferencia. */
export function iconsReference(lib: IconLibrary): string {
  return [
    '# Iconos',
    '',
    `Un icono va en un prop que acepta JSX (\`anida\` en el índice) como \`{ "$component": "${ICON_PREFIX}<set>/<Nombre>" }\`.`,
    'Prefiere los sets propios (los primeros); `lucide` es el respaldo genérico. Verifica los nombres con',
    'check_icon_names antes de usarlos: lo que no está aquí no existe.',
    ...lib.sets.flatMap((s) => [
      '',
      `## ${s.id}: ${s.title} (${s.names.length}${s.version ? `, ${s.version}` : ''})`,
      '',
      `import desde \`${s.importPath}\``,
      '',
      s.names.join(' '),
    ]),
  ].join('\n');
}
