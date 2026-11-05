// Manifiesto agéntico de un item Relume DERIVADO (spec catalogo-blob-router RF4, DA2): Relume no
// trae keywords ni cuándo-no-usar, así que se derivan de categoría, tags del MCP, nombre y el
// source limpio del vault (`sections-react`). Nada se rellena con texto inventado: whenNotToUse
// sale SOLO de los `undesiredTags` de ROLE_SPEC (decisión de Karen, DA2) y nombra como
// alternativa un item del mismo rol que no lleve ese tag.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_SPEC } from '../plan';
import type { Role } from '../types';
import type { Manifest, ManifestProp, ManifestRule } from './schema';

export interface RelumeSibling {
  slug: string;
  role: Role;
  tags: string[];
}

export interface RelumeItemInput {
  slug: string;
  name: string;
  role: Role;
  category: string;
  tags: string[];
  preview?: string;
}

export interface RelumeVaultItem {
  /** Carpeta relativa a VAULT_ROOT (sections-react/<categoría>/<item>). */
  dir: string;
  /** Archivo principal relativo a VAULT_ROOT. */
  file: string;
  preview?: string;
}

const SECTIONS = 'sections-react';

// Localiza en el vault el item cuyo `registry.json` declara `source_slug: <cat>/<slug>`. Recorre
// cada sections-react/<cat>/<item>/registry.json; I/O de solo lectura y determinista (orden fijo).
export function findRelumeVaultItem(slug: string, vaultRoot: string): RelumeVaultItem | undefined {
  const root = join(vaultRoot, SECTIONS);
  for (const cat of readdirSync(root).sort()) {
    const catDir = join(root, cat);
    if (!statSync(catDir).isDirectory()) continue;
    for (const item of readdirSync(catDir).sort()) {
      const regPath = join(catDir, item, 'registry.json');
      let reg: { source_slug?: string; files?: unknown[]; preview?: string };
      try {
        reg = JSON.parse(readFileSync(regPath, 'utf8')) as typeof reg;
      } catch {
        continue;
      }
      if (reg.source_slug?.endsWith(`/${slug}`)) {
        const dir = `${SECTIONS}/${cat}/${item}`;
        return { dir, file: `${dir}/${item}.tsx`, ...(reg.preview ? { preview: reg.preview } : {}) };
      }
    }
  }
  return undefined;
}

/** Nombre del export principal: `export const Cta23 = (props`, la variante tipada
 * `export const Layout170: React.FC<...> = (props` y la propless `export const Topbar3 = () =>`. */
export const exportOf = (tsx: string): string | undefined =>
  /^export const (\w+)(?::\s*React\.FC<[^>]*>)? = \((?:props|\))/m.exec(tsx)?.[1];

/** Campos de `type Props = { ... }`: nombre y tipo tal como están escritos; sin resolver tipos. */
export function propsOf(tsx: string): ManifestProp[] {
  const block = /^type Props = \{([\s\S]*?)^\};/m.exec(tsx)?.[1] ?? '';
  return block
    .split('\n')
    .map((l) => /^\s*(\w+)(\?)?:\s*([^;]+);/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1], type: m[3].trim(), description: '' }));
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9+]+/).filter((w) => w.length > 1);

/** Reglas desde undesiredTags del rol (intención demo, la base de ROLE_SPEC): el item lleva un tag
 * que ese rol no quiere, y la alternativa es el primer hermano del rol (por slug) que no lo lleva. */
export function relumeRules(input: RelumeItemInput, siblings: readonly RelumeSibling[]): ManifestRule[] {
  const undesired = ROLE_SPEC[input.role].undesiredTags ?? [];
  const desired = ROLE_SPEC[input.role].desiredTags;
  const has = new Set(input.tags.map((t) => t.toLowerCase()));
  return undesired
    .filter((u) => has.has(u.toLowerCase()))
    .map((u) => {
      const alternative = [...siblings]
        .filter((s) => s.role === input.role && s.slug !== input.slug && !s.tags.some((t) => t.toLowerCase() === u.toLowerCase()))
        .sort((a, b) => a.slug.localeCompare(b.slug))[0];
      const text = `No para la intención demo del rol ${input.role}: lleva "${u}", que ese rol no desea (desea ${desired.join(', ')}).`;
      return { text, ...(alternative ? { alternative: alternative.slug } : {}) };
    });
}

export function deriveRelumeManifest(input: RelumeItemInput, tsx: string, siblings: readonly RelumeSibling[]): Manifest {
  const props = propsOf(tsx);
  const keywords = [...new Set([...words(input.category), ...input.tags.map((t) => t.toLowerCase()), input.name.toLowerCase()])];
  return {
    keywords,
    whenToUse: [`Sección de la categoría ${input.category} de Relume (rol ${input.role}).`],
    whenNotToUse: relumeRules(input, siblings),
    aiNotes: [
      ...(input.preview ? [`Preview renderizado: ${input.preview}`] : []),
      ...(props.length ? ['El componente mezcla sus Defaults con los props recibidos: inyectar copy por props.'] : []),
    ],
    injection: props.length
      ? { kind: 'props', detail: `props: ${props.map((p) => p.name).join(', ')}` }
      : { kind: 'constants', detail: 'sin type Props detectado en el source' },
    related: siblings.filter((s) => s.role === input.role && s.slug !== input.slug).map((s) => s.slug).sort(),
    props,
  };
}
