// Reporte del ingest (`catalog/ingest-report.{md,json}`): conteos por librería/rol/gate y la COLA DE
// REVISIÓN con el motivo de cada item que no pasó. Puro: recibe filas ya decididas y devuelve texto.
// Lo que aquí se lista es lo que una persona tiene que decidir (deps, mapeos @kit/ui, roles sin
// mapear, copy contracts que faltan); el ingest no lo resuelve solo.

import type { Role } from '../types';
import type { CatalogGate, Library } from './schema';

export type IngestStatus =
  /** Entró al índice (verified:false, con gate). */
  | 'indexed'
  /** Ya estaba curado a mano (mismo origin.path o slug): no se toca. */
  | 'curated'
  /** Sin rol del core: no se indexa (el schema no admite un rol fuera de la lista). */
  | 'unmapped'
  /** Component Arc (dep): inventariado, no indexado (el schema exige rol). */
  | 'component'
  /** Slug repetido dentro del vault: se indexa el primero por orden de categoría. */
  | 'duplicate';

export interface IngestRow {
  library: Library;
  slug: string;
  name: string;
  category: string;
  role: Role | null;
  status: IngestStatus;
  curatedAs?: string;
  gate?: CatalogGate;
  access?: 'free' | 'pro';
  npmMissing: string[];
  kit: string[];
  icons: string[];
  residue?: { arbitrary: number; colors: number; unresolved: number };
}

export interface IngestSummaryInput {
  rows: IngestRow[];
  durationMs: number;
  roles: readonly Role[];
  /** Roles con contrato en RoleCopy; los que falten salen en el reporte. */
  copyRoles: readonly string[];
  kitToArc: Readonly<Record<string, string | null>>;
  /** Sección ya renderizada del build de muestra, si existe. */
  sampleBuildMd?: string;
}

const count = <T>(xs: readonly T[], key: (x: T) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
};
const sortedEntries = (m: Map<string, number>): [string, number][] => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/** Clase del motivo: la parte antes de los dos puntos, para agrupar la cola. */
export const reasonKind = (reason: string): string => reason.split(':')[0].trim();

const table = (head: string[], rows: string[][]): string =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

function totals(rows: IngestRow[]): string {
  const libs: Library[] = ['arc', 'relume'];
  const statuses: IngestStatus[] = ['indexed', 'curated', 'unmapped', 'component', 'duplicate'];
  const body = libs.map((lib) => {
    const mine = rows.filter((r) => r.library === lib);
    return [lib, String(mine.length), ...statuses.map((s) => String(mine.filter((r) => r.status === s).length))];
  });
  return table(['library', 'escaneados', ...statuses], body);
}

function byRole(rows: IngestRow[], roles: readonly Role[]): string {
  const body = roles.map((role) => {
    const cell = (lib: Library): string => {
      const mine = rows.filter((r) => r.role === role && r.library === lib && r.status === 'indexed');
      const ok = mine.filter((r) => r.gate?.ok).length;
      return `${mine.length} (gate ok ${ok})`;
    };
    const curated = rows.filter((r) => r.role === role && r.status === 'curated').length;
    return [role, cell('arc'), cell('relume'), String(curated)];
  });
  return table(['rol', 'arc indexados', 'relume indexados', 'ya curados'], body);
}

function queue(rows: IngestRow[]): string {
  const pending = rows.filter((r) => r.status === 'indexed' && r.gate && !r.gate.ok);
  const kinds = count(pending.flatMap((r) => (r.gate?.reasons ?? []).map(reasonKind)), (k) => k);
  const lines = sortedEntries(kinds).map(([kind, n]) => {
    const slugs = pending.filter((r) => r.gate?.reasons.some((x) => reasonKind(x) === kind)).map((r) => r.slug);
    return `- **${kind}** (${n}): ${slugs.join(', ')}`;
  });
  return [`Items indexados con gate en rojo: ${pending.length}. Un item puede estar en varios motivos.`, '', ...lines].join('\n');
}

function deps(rows: IngestRow[]): string {
  const npm = sortedEntries(count(rows.flatMap((r) => r.npmMissing), (d) => d));
  const icons = sortedEntries(count(rows.flatMap((r) => r.icons), (d) => d));
  return [
    '### Deps npm ausentes en el scaffold (FLAG, no se instalan)',
    '',
    npm.length ? table(['paquete', 'items'], npm.map(([d, n]) => [d, String(n)])) : 'ninguna',
    '',
    '### react-icons portados (a lucide-react / módulo local de logos)',
    '',
    'El codemod mapea cada icono a su equivalente lucide o al módulo de logos; ya no bloquean el gate. Un icono fuera del mapa iría a la cola con su propio motivo.',
    '',
    icons.length ? table(['paquete', 'items'], icons.map(([d, n]) => [d, String(n)])) : 'ninguno',
  ].join('\n');
}

function kit(rows: IngestRow[], map: Readonly<Record<string, string | null>>): string {
  const uses = sortedEntries(count(rows.flatMap((r) => r.kit), (k) => k));
  if (!uses.length) return 'ningún import de @kit/ui';
  const label = (k: string): string => (map[k] === undefined ? 'sin mapa' : map[k] === null ? 'sin equivalente Arc' : `Arc \`${map[k]}\` (portar el uso)`);
  return table(['@kit/ui', 'items', 'equivalente'], uses.map(([k, n]) => [k, String(n), label(k)]));
}

function unmapped(rows: IngestRow[]): string {
  const relume = sortedEntries(count(rows.filter((r) => r.library === 'relume' && r.status === 'unmapped'), (r) => r.category));
  const arc = rows.filter((r) => r.library === 'arc' && r.status === 'unmapped').map((r) => r.slug);
  return [
    '### Relume: categorías sin rol en el core',
    '',
    relume.length ? table(['categoría', 'items'], relume.map(([c, n]) => [c, String(n)])) : 'ninguna',
    '',
    '### Arc: bloques de app-UI sin rol (candidatos a inner cuando exista un slot que los admita)',
    '',
    arc.length ? arc.join(', ') : 'ninguno',
  ].join('\n');
}

function components(rows: IngestRow[]): string {
  const comps = rows.filter((r) => r.status === 'component');
  const blocked = comps.filter((r) => r.gate && !r.gate.ok);
  return [
    `Components Arc escaneados: ${comps.length}; indexados (kind component, sin rol) ${comps.length - blocked.length}. Fuera los no instalables con el scaffold: deps npm o cierre de imports.`,
    '',
    blocked.length ? table(['component', 'motivo'], blocked.map((r) => [r.slug, (r.gate?.reasons ?? []).join('; ')])) : 'Todos son instalables con el scaffold.',
  ].join('\n');
}

function curated(rows: IngestRow[]): string {
  const c = rows.filter((r) => r.status === 'curated');
  return c.length ? c.map((r) => `${r.slug} (índice: ${r.curatedAs})`).join(', ') : 'ninguno';
}

export function renderReportMd(i: IngestSummaryInput): string {
  const missingCopy = i.roles.filter((r) => !i.copyRoles.includes(r));
  const dup = i.rows.filter((r) => r.status === 'duplicate');
  return [
    '# Ingest del catálogo React del vault',
    '',
    `Generado por \`bun scripts/catalog-ingest.ts\`. Duración: ${(i.durationMs / 1000).toFixed(1)} s. Fuente: vault READ-ONLY (ui-react/blocks, ui-react/components, sections-react; sections-webflow se salta).`,
    '',
    'Qué significa cada cosa: **indexed** = entrada nueva en `catalog/index.json` con `verified:false`, `source:null` y `gate`; el source se trae on-demand con `catalog fetch`. **gate ok** = pasa el gate automático (existe, exporta, deps resolubles, lint, sin residuos bloqueantes del transformer): listo para fetch + build. `verified:true` sigue exigiendo source vendorizado y render visto (schema RF5/CA3), por eso el ingest nunca lo escribe.',
    '',
    '## Totales',
    '',
    totals(i.rows),
    '',
    '## Por rol',
    '',
    byRole(i.rows, i.roles),
    '',
    '## Cola de revisión (por motivo)',
    '',
    queue(i.rows),
    '',
    '## Deps que salieron',
    '',
    deps(i.rows),
    '',
    '### @kit/ui (Relume) y su equivalente en el scaffold Arc',
    '',
    'Conteo sobre TODO lo escaneado (indexado o no). "Portar el uso" = reescribir el JSX contra el component Arc; el paquete @kit/ui nunca se instala.',
    '',
    kit(i.rows, i.kitToArc),
    '',
    '## Rol sin mapear (no indexado)',
    '',
    unmapped(i.rows),
    '',
    '## Components Arc (inventario)',
    '',
    components(i.rows),
    '',
    '## Ya curados a mano (no se tocan)',
    '',
    curated(i.rows),
    '',
    '## Roles sin RoleCopy',
    '',
    missingCopy.length ? `${missingCopy.join(', ')}: sin contrato en \`src/copy.ts\`; un item de ese rol no puede portar copy aunque pase el gate. No se escribe aquí (decisión de copy).` : 'Todos los roles del core tienen contrato en RoleCopy.',
    '',
    ...(dup.length ? ['## Slugs repetidos en el vault (se indexa el primero)', '', dup.map((r) => `${r.slug} (${r.category})`).join(', '), ''] : []),
    '## Build de muestra',
    '',
    i.sampleBuildMd ?? 'Sin build de muestra todavía: correr `bun scripts/ingest-sample-build.ts`.',
    '',
  ].join('\n');
}

export function renderReportJson(i: IngestSummaryInput): string {
  const missingCopy = i.roles.filter((r) => !i.copyRoles.includes(r));
  return `${JSON.stringify({ durationMs: Math.round(i.durationMs), rolesSinRoleCopy: missingCopy, rows: i.rows }, null, 2)}\n`;
}
