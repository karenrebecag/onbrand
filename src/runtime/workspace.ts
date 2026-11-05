// Preparación del workspace de una página: scaffold + starter + marca y commit base. Compartida por el camino del
// agente (run-cycle) y el preview; vivía en runner.ts y salió a su módulo al retirar el render sin agente (C5).

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyBrand } from '../brand';
import type { EventLog } from './events';
import { commitAll, initRepo, isRepo } from './git-workspace';
import { step } from './step';

export interface PrepareOptions {
  scaffoldDir: string;
  /** assets/starter del DS-skill: se copia ENCIMA del scaffold (como el starter de v0). */
  starterDir?: string;
  /** Brand pack a aplicar una vez al crear el workspace (identity.css, fuentes, data-accent), como el
   * v0.json que v0 aplica en "Set up environment". Sin él el agente declara la identidad en identity.css (#212). */
  brandDir?: string;
  /** Log del mensaje en curso (events.ts); el ciclo de vida del mensaje es de quien llama. */
  log?: EventLog;
}

/** Primera vez: scaffold + starter, `git init` y commit base. Borra el directorio, así que quien escriba
 * en el workspace antes (las imágenes) tiene que llamarla primero. */
export function prepareWorkspace(outDir: string, opts: PrepareOptions): void {
  if (isRepo(outDir)) return;
  step(opts.log, 'runner:prepare', 'action', ['Preparing workspace', 'Prepared workspace'], () => {
    rmSync(outDir, { recursive: true, force: true });
    cpSync(opts.scaffoldDir, outDir, { recursive: true, filter: (src) => !/\/(node_modules|dist)(\/|$)/.test(src) });
    if (opts.starterDir) cpSync(opts.starterDir, outDir, { recursive: true });
    // Los puentes con el builder ya no dependen del main.tsx del ws (ni del starter): el preview los inyecta desde el
    // scaffold actual (wt-bridges-plugin.ts), así un starter viejo no apaga la edición del lienzo (QA 2026-10-29, :5341).
    // Después del starter: el starter trae su propio identity.css vacío y lo pisaría.
    const brand = opts.brandDir ? applyBrand(outDir, opts.brandDir) : undefined;
    // El agente lista src/sections antes de escribir la primera (QA c734443f: `ls` en rojo). Vacía hasta entonces.
    mkdirSync(join(outDir, 'src', 'sections'), { recursive: true });
    initRepo(outDir);
    const base = commitAll(outDir, brand ? `base: scaffold + marca ${brand.name}` : 'base: scaffold');
    // Sin marca la identidad la declara el agente después: se dice en el paso para que no pase por una marca aplicada.
    return { value: undefined, detail: { kind: 'action', name: 'scaffold', summary: brand ? base : `${base} (sin marca: el agente declara la identidad)` } };
  });
}
