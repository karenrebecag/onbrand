#!/usr/bin/env bun
// Arma el registry del DS base del core (B9 §3) desde templates/base-scaffold, sin vault: un clon lo puede regenerar.
//   bun scripts/build-base-registry.ts [--out <dir>]
// Escribe registry/ (o --out) con el mismo formato que build-registry: r/<slug>@<sha>.json, references/, el skill
// base-agent en skills/ e index@<sha>.json con latest.json. No usa catálogo, gates, motion ni extension points: son de Arc.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AllowEntry, ChildSlot } from '../src/ds-skill';
import { REPO_ROOT } from '../src/catalog/load';
import { buildIndex, categoryGuides, guidePath, hashItem, itemPath, npmDepsOf, secretHits, withPortedSiblings, BASE_STARTER, type BuiltItem, type RegistryItem } from '../src/ds-registry';
import { BASE_AGENT_SKILL_ID, readSkillPack, skillItemPath, skillItemSha } from '../src/skill-registry';

export const BASE = join(REPO_ROOT, 'templates', 'base-scaffold');
const SKILL_SRC = join(BASE, 'skill');

export interface CatalogItem {
  slug: string;
  export: string;
  /** Relativa a src/. */
  file: string;
  kind: 'component' | 'block';
  category: string;
  role?: string;
  summary: string;
  whenToUse: string[];
}

export const readCatalog = (): CatalogItem[] => (JSON.parse(readFileSync(join(SKILL_SRC, 'catalog.json'), 'utf8')) as { items: CatalogItem[] }).items;

/** El texto de las props de un export: su interfaz `<Export>Props` o el tipo en línea de `p: { ... }`. */
export function propsText(source: string, name: string): string | undefined {
  const iface = new RegExp(`export interface ${name}Props(?: extends [\\w, ]+)? \\{([\\s\\S]*?)\\n?\\}\\n`).exec(source);
  if (iface) return iface[1];
  const inline = new RegExp(`export function ${name}\\(\\w+: \\{([\\s\\S]*?)\\}\\)`).exec(source);
  return inline?.[1];
}

/** Props de primer nivel que reciben JSX: donde el agente puede anidar otros componentes. Un ReactNode dentro de un
 *  ítem de lista (`items: { content: ReactNode }[]`) no es una prop del componente. */
export function acceptsOf(props: string): ChildSlot[] {
  let depth = 0;
  const top = [...props].map((ch) => {
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    return depth === 0 || '{[('.includes(ch) ? ch : ' ';
  }).join('');
  return [...top.matchAll(/([\w']+)(\?)?:\s*ReactNode/g)].map((m) => ({ prop: m[1]!.replace(/'/g, ''), type: 'ReactNode', required: !m[2] }));
}

export const exportsOf = (source: string): string[] => [...source.matchAll(/^export function (\w+)/gm)].map((m) => m[1]!);

const importPathOf = (file: string): string => `@/${file.replace(/\.tsx?$/, '')}`;

export function allowOf(c: CatalogItem, source: string): AllowEntry {
  const props = propsText(source, c.export);
  if (props === undefined) throw new Error(`base-registry: ${c.slug} no expone ${c.export} con props legibles en ${c.file}`);
  return {
    export: c.export,
    importPath: importPathOf(c.file),
    kind: c.kind,
    ...(c.role ? { role: c.role, usage: 'section' as const } : {}),
    schema: null,
    propless: false,
    accepts: acceptsOf(props),
    provides: [],
    category: c.category,
    summary: c.summary,
    whenToUse: c.whenToUse,
  };
}

function itemOf(c: CatalogItem, versions: Record<string, string>): RegistryItem {
  const path = `src/${c.file}`;
  const source = readFileSync(join(BASE, path), 'utf8');
  if (!exportsOf(source).includes(c.export)) throw new Error(`base-registry: ${c.file} no exporta ${c.export}`);
  const files = withPortedSiblings([{ path, content: source }], BASE).sort((a, z) => a.path.localeCompare(z.path));
  return {
    name: c.slug,
    type: c.kind === 'block' ? 'registry:block' : 'registry:ui',
    dependencies: npmDepsOf(files, versions),
    registryDependencies: [],
    files,
    categories: [c.category],
    description: c.summary,
    meta: { origin: 'base', kind: c.kind, ...(c.role ? { role: c.role } : {}) },
    allow: allowOf(c, source),
    schema: null,
  };
}

const ICON_NAMES = (): string[] => {
  const src = readFileSync(join(BASE, 'src', 'components', 'ui', 'icon.tsx'), 'utf8');
  const body = /const PATHS = \{([\s\S]*?)\n\} as const;/.exec(src)?.[1] ?? '';
  return [...body.matchAll(/^\s+'?([a-z-]+)'?:/gm)].map((m) => m[1]!);
};

/** Guía por categoría o rol para el agente: entrada, import y props tal como están en el código. */
function referencesOf(built: RegistryItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (key: string, title: string, intro: string, items: RegistryItem[]) => {
    out[key] = `# ${title}\n\n${intro}\n\n${items.map((i) => {
      const a = i.allow!;
      const file = i.files.find((f) => f.path === `src/${a.importPath.slice(2)}.tsx`)!;
      return `## ${a.export}\n\n${a.summary}\n\nImport: \`import { ${a.export} } from '${a.importPath}'\`\n\nCódigo: \`${file.path}\`\n\nProps:\n\n\`\`\`ts\n${propsText(file.content, a.export)!.trim()}\n\`\`\`\n\nCuándo: ${a.whenToUse!.join(' ')}\n`;
    }).join('\n')}`;
  };
  const atoms = built.filter((i) => i.meta.kind === 'component' && i.allow?.category !== 'layout');
  for (const cat of [...new Set(atoms.map((i) => i.allow!.category!))]) add(`references/components/${cat}.md`, cat, 'Átomos de esta categoría. El código es la fuente de verdad.', atoms.filter((i) => i.allow!.category === cat));
  for (const b of built.filter((i) => i.meta.kind === 'block')) add(`references/examples/${b.meta.role}.md`, `Bloque: ${b.meta.role}`, `Importa el bloque y pásale el contenido del brief por props, más \`id\` y \`slug\` de la sección. Una acción es \`{ label, href, variant? }\` (variant: primary, secondary o ghost); un enlace, \`{ label, href }\`.`, [b]);
  return out;
}

/** El skill base-agent: lo escrito a mano en templates/base-scaffold/skill más lo que sale del código. */
export function assembleSkill(dir: string, built: RegistryItem[]): void {
  rmSync(dir, { recursive: true, force: true });
  cpSync(SKILL_SRC, dir, { recursive: true, filter: (src) => !src.endsWith('catalog.json') });
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  write('allowlist.json', JSON.stringify(Object.fromEntries(built.map((i) => [i.name, i.allow])), null, 2));
  const icons = ICON_NAMES();
  write('icons.json', JSON.stringify({ sets: [{ id: 'base', title: 'Iconos del DS base', importPath: '@/components/ui/icon', names: icons }] }, null, 2));
  write('references/assets/icons.md', `# Iconos\n\nUn solo set, en SVG inline: \`<Icon name="check" />\` de \`@/components/ui/icon\`. Con \`label\` se anuncia a lectores de pantalla; sin él es decorativo.\n\nNombres: ${icons.map((n) => `\`${n}\``).join(', ')}.\n`);
  write('v0.json', JSON.stringify({ version: 1, starter: { source: 'skill-directory', path: 'assets/starter' }, layout: { sectionHeaderAlign: 'center', icons: icons.map((n) => `base/${n}`) } }, null, 2));
  for (const f of ['main.tsx', 'index.css', 'identity.css']) write(`assets/starter/src/${f}`, readFileSync(join(BASE, 'src', f), 'utf8'));
  write('assets/starter/src/App.tsx', 'export default function App() {\n  return <main />;\n}\n');
  write('assets/starter/README.md', 'Starter de cada página: estos archivos se copian sobre `templates/base-scaffold` (deps, alias `@/`, componentes del DS base). La página se escribe en `src/App.tsx`.\n');
  for (const [rel, md] of Object.entries(referencesOf(built))) write(rel, md);
}

if (import.meta.main) {
  // --help sin escribir: sin --out, este script borra y rehace registry/ del paquete.
  if (process.argv.includes('--help')) {
    console.log(`Uso: onbrand-build-registry [--out <dir>]
Arma el registry del DS base desde templates/base-scaffold: items, references, el skill base-agent y su índice.
  --out <dir>   dónde escribirlo (por defecto, registry/ del paquete, que se reemplaza)
  --help        muestra esta ayuda`);
    process.exit(0);
  }
  const outIdx = process.argv.indexOf('--out');
  const OUT = outIdx >= 0 ? resolve(process.argv[outIdx + 1]!) : join(REPO_ROOT, 'registry');
  const pkg = JSON.parse(readFileSync(join(BASE, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const versions = { ...pkg.devDependencies, ...pkg.dependencies };
  const items = readCatalog().map((c) => itemOf(c, versions));
  const outside = items.flatMap((i) => i.dependencies.filter((d) => !(d.split('@').slice(0, d.startsWith('@') ? 2 : 1).join('@') in (pkg.dependencies ?? {}))));
  if (outside.length) throw new Error(`base-registry: deps fuera del package.json del base: ${outside.join(', ')}`);
  const leaks = secretHits(items);
  if (leaks.length) throw new Error(`base-registry: posibles secretos, no se escribe:\n${leaks.map((h) => h.id).join('\n')}`);
  const built: BuiltItem[] = items.map((item) => { const sha = hashItem(item); return { item, sha, path: itemPath(item.name, sha) }; });
  const guides = categoryGuides(built);
  const skillDir = join(REPO_ROOT, 'generated', 'ds-skills', BASE_AGENT_SKILL_ID);
  assembleSkill(skillDir, items);
  const skill = readSkillPack(BASE_AGENT_SKILL_ID, skillDir);
  const skillPath = skillItemPath(skill.id, skillItemSha(skill));
  const { index, sha } = buildIndex(built, guides, {}, { [skill.id]: skillPath }, undefined, BASE_STARTER);
  const files = new Map<string, string>([[skillPath, JSON.stringify(skill)], ...built.map((b) => [b.path, JSON.stringify(b.item)] as [string, string]), ...Object.entries(guides).map(([k, md]) => [guidePath(k, md), md] as [string, string]), [`index@${sha}.json`, JSON.stringify(index)]]);
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  for (const [p, c] of files) {
    mkdirSync(dirname(join(OUT, p)), { recursive: true });
    writeFileSync(join(OUT, p), c);
  }
  writeFileSync(join(OUT, 'latest.json'), JSON.stringify({ index: `index@${sha}.json`, version: sha }));
  console.log(`base-registry: ${built.length} items, skill ${skill.id} (${skill.files.length} archivos), índice index@${sha}.json -> ${OUT}`);
}
