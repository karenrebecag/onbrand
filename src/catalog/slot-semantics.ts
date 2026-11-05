// Qué aporta cada componente a un slot de organismo (spec composicion-slots, RF3). La verdad es el
// overlay humano catalog/slot-semantics.json: la categoría `Type:` del doc.md es demasiado gruesa
// (`data` mezcla avatar, card, empty-state y metric-card) para derivarla. Un componente sin entrada
// no es elegible como filler de ningún slot.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './load';
import { SEMANTICS, type SlotSemantic } from './schema';

export interface SlotSemantics {
  version: number;
  components: Record<string, SlotSemantic[]>;
}

export const SLOT_SEMANTICS_PATH = join(REPO_ROOT, 'catalog', 'slot-semantics.json');

/** Valida shape y vocabulario cerrado (§3): un valor fuera del vocabulario es error, no extensión. */
export function parseSlotSemantics(raw: unknown, where = 'slot-semantics'): SlotSemantics {
  const fail = (what: string): never => { throw new Error(`${where}: ${what}`); };
  if (typeof raw !== 'object' || raw === null) return fail('no es un objeto');
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) fail(`version desconocida: ${String(r.version)}`);
  if (typeof r.components !== 'object' || r.components === null) fail('components no es un objeto');
  const components: SlotSemantics['components'] = {};
  for (const [slug, list] of Object.entries(r.components as Record<string, unknown>)) {
    if (!Array.isArray(list) || list.length === 0) fail(`components.${slug}: se esperaba una lista no vacía`);
    const values = list as unknown[];
    const bad = values.find((v) => !(SEMANTICS as readonly unknown[]).includes(v));
    if (bad !== undefined) fail(`components.${slug}: "${String(bad)}" fuera del vocabulario (${SEMANTICS.join(' | ')})`);
    if (new Set(values).size !== values.length) fail(`components.${slug}: semántica repetida`);
    components[slug] = [...(values as SlotSemantic[])];
  }
  return { version: 1, components };
}

let cached: SlotSemantics | undefined;

/** Overlay del repo, leído una vez por proceso. Sin overlay no hay fillers: error, no lista vacía. */
export function loadSlotSemantics(path = SLOT_SEMANTICS_PATH): SlotSemantics {
  if (path === SLOT_SEMANTICS_PATH && cached) return cached;
  if (!existsSync(path)) throw new Error(`slot-semantics: falta ${path}`);
  const parsed = parseSlotSemantics(JSON.parse(readFileSync(path, 'utf8')), path);
  if (path === SLOT_SEMANTICS_PATH) cached = parsed;
  return parsed;
}

/** Semánticas de un componente; vacío = no elegible como filler. */
export const semanticsOf = (slug: string, overlay = loadSlotSemantics()): SlotSemantic[] => overlay.components[slug] ?? [];
