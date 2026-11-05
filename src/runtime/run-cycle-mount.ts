// El remonte de App.tsx: en el T1 el sistema reescribe App a medida que el agente escribe cada sección. Vivía en
// run-cycle.ts; se extrajo aquí para dejar ese archivo bajo el tope de líneas (docs/estandares.md A1). run-cycle sigue
// usando mountingLog y server reexporta ambas para los tests; los cuerpos no cambian.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from './events';
import { appFor, APP_PATH, PLAN_PATH } from './section-ops';

// P1 (arnes/48de1230-arq.md): en el T1 App.tsx lo monta el sistema. En dos T1 el agente no lo escribió una línea por
// sección y las secciones montaron juntas al final. Cada vez que el stream reporta una sección escrita (o el plan, que
// fija el orden), App se rehace con los archivos que ya existen; en los follow-ups App sigue siendo del agente.
const SECTION_FILE = /^src\/sections\/(\d{2}-[a-z0-9-]+)\.tsx$/;
/** `force` reescribe App aunque no cambie (c7c7ec26): un remount con una sección que no compilaba deja el update de App
 * fallido en vite, y cuando la sección se arregla el contenido de App ya es el mismo, así que sin escribirlo de nuevo vite
 * no manda otro update y el preview queda con el App viejo. Reescribir lo mismo cambia el mtime y vite vuelve a emitir. */
export function remountApp(dir: string, force = false): boolean {
  const sections = join(dir, 'src', 'sections');
  if (!existsSync(sections)) return false;
  const slugs = readdirSync(sections).flatMap((f) => SECTION_FILE.exec(`src/sections/${f}`)?.[1] ?? []);
  if (!slugs.length) return false;
  const planPath = join(dir, PLAN_PATH);
  const next = appFor(slugs, existsSync(planPath) ? readFileSync(planPath, 'utf8') : undefined);
  const app = join(dir, APP_PATH);
  if (!force && existsSync(app) && readFileSync(app, 'utf8') === next) return false;
  writeFileSync(app, next);
  return true;
}
/** Condición mínima, sin saber si el HMR falló: una sección escrita fuerza App (la que se arregla re-emite su update) y
 * el cierre del turno lo fuerza una vez más, por lo que cambió fuera de Write/Edit (un `mv`). El plan solo remonta si
 * cambia el orden. */
export function mountingLog(log: EventLog, dir: string): EventLog {
  const mount = (force: boolean) => {
    try { remountApp(dir, force); } catch (e) { process.stderr.write(`transport: no pude montar App: ${e instanceof Error ? e.message : String(e)}\n`); }
  };
  return {
    emit(body) {
      const event = log.emit(body);
      const end = (body as { type: string }).type === 'step.end' ? (body as { stepId?: string; detail?: { kind?: string; path?: string } }) : undefined;
      const path = end?.detail?.kind === 'write' ? end.detail.path : undefined;
      if (path && SECTION_FILE.test(path)) mount(true);
      else if (path === PLAN_PATH) mount(false);
      else if (end?.stepId === 'agent:write') mount(true);
      return event;
    },
  };
}
