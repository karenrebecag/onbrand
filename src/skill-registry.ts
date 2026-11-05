// El skill del agente (ADR 0011) en el registry: como el DS que monta, va fijado por pin y no sale del checkout del
// server (R6). Un pack inmutable skills/<id>@<sha>.json con todos sus archivos; el transport lo baja al workspace.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const AGENT_SKILL_ID = 'arc-agent';
/** El skill del DS base del core (B9 §2.5); pasa a ser el default en el paso 4. */
export const BASE_AGENT_SKILL_ID = 'base-agent';
/** Carpeta del workspace que no entra a la versión: skill de solo lectura y sesión del CLI para el follow-up. */
export const AGENT_DIR = '.wt';
export const AGENT_SKILL_DIR = `${AGENT_DIR}/skill`;

export interface SkillPackItem {
  id: string;
  files: { path: string; base64: string }[];
}

function filesOf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    // readFileSync seguiría el symlink y publicaría un archivo de fuera del skill.
    if (lstatSync(path).isSymbolicLink()) throw new Error(`skill registry: ${path} es un symlink`);
    return e.isDirectory() ? filesOf(path) : [path];
  });
}

export function readSkillPack(id: string, dir: string): SkillPackItem {
  const paths = filesOf(dir).map((f) => relative(dir, f).split(sep).join('/')).sort();
  if (!paths.includes('SKILL.md')) throw new Error(`skill registry: ${dir} no es un skill (falta SKILL.md)`);
  return { id, files: paths.map((path) => ({ path, base64: readFileSync(join(dir, path)).toString('base64') })) };
}

export const skillItemSha = (item: SkillPackItem): string => createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 16);
export const skillItemPath = (id: string, sha: string): string => `skills/${id}@${sha}.json`;

/** La terna scaffold, skill y registry va por config separada. Como en v0, donde el skill trae su starter (v0.json
 * `starter.source: skill-directory`), el starter del skill es la marca de su DS: su `src/index.css` es el del scaffold que
 * lo armó (build-ds-skill y build-base-registry lo copian). Un scaffold de otro DS da un mensaje; si coinciden, undefined. */
export function scaffoldMismatch(skillDir: string, skillId: string, scaffoldDir: string): string | undefined {
  const read = (f: string): string | undefined => { try { return readFileSync(f, 'utf8'); } catch { return undefined; } };
  const starter = read(join(skillDir, 'assets', 'starter', 'src', 'index.css'));
  if (starter === undefined) return `el skill ${skillId} no trae assets/starter/src/index.css: no se puede comprobar que su DS sea el del scaffold ${scaffoldDir}`;
  if (starter !== read(join(scaffoldDir, 'src', 'index.css'))) return `el skill ${skillId} es de otro DS que el scaffold ${scaffoldDir}: su starter no trae el src/index.css del scaffold (WT_SCAFFOLD_DIR y WT_AGENT_SKILL tienen que ser del mismo DS)`;
  return undefined;
}
