// Manifiesto agéntico de un item Arc PARSEADO del `doc.md` de la versión limpia del vault (spec
// catalogo-blob-router RF3). Determinista por encabezados; lo que la doc no dice queda vacío,
// nunca inventado. El vault es de solo lectura: aquí solo se interpreta texto.

import type { Manifest, ManifestProp, ManifestRule } from './schema';

/** Lo mínimo del índice que el parser necesita para resolver nombres a slugs. */
export interface KnownItem {
  slug: string;
  name: string;
}

const section = (md: string, heading: string): string => {
  const re = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  return re.exec(md)?.[1] ?? '';
};

const bullets = (block: string): string[] =>
  block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());

const kebab = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/** Resuelve el item que una frase nombra: primero un slug literal, luego el nombre más largo que
 * aparezca (sin distinguir mayúsculas). Sin match devuelve undefined. */
export function resolveItem(text: string, known: readonly KnownItem[]): string | undefined {
  const lower = text.toLowerCase();
  const bySlug = [...known].sort((a, b) => b.slug.length - a.slug.length).find((k) => new RegExp(`(^|[^a-z0-9-])${k.slug}([^a-z0-9-]|$)`).test(lower));
  if (bySlug) return bySlug.slug;
  const byName = [...known].sort((a, b) => b.name.length - a.name.length).find((k) => lower.includes(k.name.toLowerCase()));
  return byName?.slug;
}

const keywordsOf = (md: string): string[] => {
  const line = /^- Keywords:\s*(.+)$/m.exec(md)?.[1] ?? '';
  return line.split(',').map((k) => k.trim()).filter(Boolean);
};

const rulesOf = (md: string, known: readonly KnownItem[], self: string): ManifestRule[] =>
  bullets(section(md, 'When not to use')).map((text) => {
    const alternative = resolveItem(text, known.filter((k) => k.slug !== self));
    return { text, ...(alternative ? { alternative } : {}) };
  });

/** `- [Name]: descripción` -> slug conocido, o el kebab del nombre (la convención de ids de Arc). */
const relatedOf = (md: string, known: readonly KnownItem[]): string[] =>
  bullets(section(md, 'Related')).flatMap((b) => {
    const name = /^\[([^\]]+)\]/.exec(b)?.[1];
    if (!name) return [];
    return [known.find((k) => k.name.toLowerCase() === name.toLowerCase())?.slug ?? kebab(name)];
  });

const cell = (s: string): string => s.trim().replace(/^`|`$/g, '').replace(/\\\|/g, '|');

/** Tabla de props del export principal (`### <export>` dentro de `## API reference`). */
export function propsOf(md: string, exportName: string): ManifestProp[] {
  const api = section(md, 'API reference');
  const re = new RegExp(`^### ${exportName}\\s*$([\\s\\S]*?)(?=^### |(?![\\s\\S]))`, 'm');
  const block = re.exec(api)?.[1] ?? '';
  return block
    .split('\n')
    .filter((l) => /^\|\s*`/.test(l))
    .map((l) => l.split(/(?<!\\)\|/).slice(1, -1).map(cell))
    .filter((cols) => cols.length >= 4)
    .map(([name, type, def, description]) => ({
      name,
      type,
      ...(def && def !== '–' && def !== '-' ? { default: def } : {}),
      description,
    }));
}

const CHROME_PROPS = new Set(['className', 'variant', 'animateIn', 'layout']);
const DATA_FILE = /\b[\w-]+-data\.ts\b/;

/** Vía de inyección: props de contenido si existen; si no, el data file que nombran las notas;
 * si no, constantes del archivo. Es el orden en que un agente debería intentar meter contenido. */
export function injectionOf(props: ManifestProp[], aiNotes: string[]): Manifest['injection'] {
  const content = props.filter((p) => !CHROME_PROPS.has(p.name) && !p.name.startsWith('on'));
  if (content.length) return { kind: 'props', detail: `props: ${content.map((p) => p.name).join(', ')}` };
  const file = aiNotes.map((n) => DATA_FILE.exec(n)?.[0]).find(Boolean);
  if (file) return { kind: 'data-file', detail: file };
  const note = aiNotes.find((n) => /constant/i.test(n)) ?? 'contenido en el archivo; ver aiNotes';
  return { kind: 'constants', detail: note };
}

export function parseArcDoc(md: string, exportName: string, self: string, known: readonly KnownItem[]): Manifest {
  const aiNotes = bullets(section(md, 'Notes for AI'));
  const props = propsOf(md, exportName);
  return {
    keywords: keywordsOf(md),
    whenToUse: bullets(section(md, 'When to use')),
    whenNotToUse: rulesOf(md, known, self),
    aiNotes,
    injection: injectionOf(props, aiNotes),
    related: relatedOf(md, known),
    props,
  };
}

/** Slugs de components que el `registry.json` del vault declara como registryDependencies
 * (`https://.../r/<slug>.json`). `uikit-motion-tokens` es lib del scaffold, no un component. */
export function registryDepsOf(registryJson: string): string[] {
  const data: unknown = JSON.parse(registryJson);
  const deps = (data as { registryDependencies?: unknown }).registryDependencies;
  if (!Array.isArray(deps)) return [];
  return deps
    .filter((d): d is string => typeof d === 'string')
    .map((d) => /\/r\/([\w-]+)\.json$/.exec(d)?.[1] ?? d)
    .filter((s) => s !== 'uikit-motion-tokens');
}
