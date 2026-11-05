// Carga el DS-skill de Arc (generado por scripts/build-ds-skill.ts, contrato de WebTransformerSecondary)
// y lo expone como contexto del agente: SKILL.md (reglas), references/index.md (vocabulario, 191 líneas)
// y allowlist.json (verify de máquina). Equivale a lo que v0 lee del referenceWorkspace/starter.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AllowEntry } from '../ds-skill';
import { TEXT_ALIGNS, type DsLayoutPolicy } from './layout-check';
import { resolveIcon, type IconLibrary } from '../ds-skill-icons';

export type { AllowEntry };

export interface DsSkill {
  dir: string;
  instructions: string; // SKILL.md
  index: string; // references/index.md
  allowlist: Record<string, AllowEntry>;
  /** Decisiones de maquetación del DS (v0.json `layout`); ausente = el DS no decide y manda el modelo. */
  layout?: DsLayoutPolicy;
}

export function loadSkill(dir: string): DsSkill {
  const instructions = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const index = readFileSync(join(dir, 'references', 'index.md'), 'utf8');
  const allowlist = JSON.parse(readFileSync(join(dir, 'allowlist.json'), 'utf8')) as Record<string, AllowEntry>;
  const iconsPath = join(dir, 'icons.json');
  const icons = existsSync(iconsPath) ? (JSON.parse(readFileSync(iconsPath, 'utf8')) as IconLibrary) : undefined;
  const layout = layoutPolicyOf(join(dir, 'v0.json'), icons);
  return { dir, instructions, index, allowlist, ...(layout ? { layout } : {}) };
}

/** Lee `layout` de v0.json. Un valor fuera del enum o un icono que icons.json no tiene se descarta aquí:
 * lo que llega como regla al modelo tiene que ser verificable. */
export function layoutPolicyOf(path: string, icons?: IconLibrary): DsLayoutPolicy | undefined {
  if (!existsSync(path)) return undefined;
  const raw = (JSON.parse(readFileSync(path, 'utf8')) as { layout?: { sectionHeaderAlign?: unknown; icons?: unknown } }).layout ?? {};
  const align = (TEXT_ALIGNS as readonly unknown[]).includes(raw.sectionHeaderAlign) ? (raw.sectionHeaderAlign as DsLayoutPolicy['sectionHeaderAlign']) : undefined;
  const palette = Array.isArray(raw.icons) && icons ? raw.icons.filter((r): r is string => typeof r === 'string' && Boolean(resolveIcon(icons, r))) : [];
  if (!align && !palette.length) return undefined;
  return { ...(align ? { sectionHeaderAlign: align } : {}), ...(palette.length ? { icons: palette } : {}) };
}
