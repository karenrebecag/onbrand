// Hojas del ciclo de corrida (ADR 0014 Enmienda 1, PR 1): lo que comprueba o prepara un turno sin tocar el estado del
// transport más allá de leer el índice. `checkPreview`/`installDeps`/`emitContextUsage` no leen nada del
// transport; `baseOf`/`untouched` solo leen el índice (por getter). run-close las usa; run-cycle (PR 2) también. No importa
// a run-close ni a run-cycle: es la hoja.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, SKILL_ID } from '../config';
import { HttpError } from './http';
import { changedSince, isClean } from './git-workspace';
import type { EventLog } from './events';
import type { PreviewPool } from './preview';
import type { PreviewChecker } from './preview-check';
import type { PageModel } from './runner';
import type { Viewport } from './follow-up-context';
import { INSTALLED_MARK, sh, type ComposeRequest, type MessageEntry } from './shared';
import type { SchemaStore } from './verify';

/** Motivo con el que supersede corta el preview-check tardío; cualquier otro corte es el apagado del transport. */
export const SUPERSEDED = 'superseded';

/** El schema del item del registry manda; el local cubre lo que el registry no trajo. */
export const withFallback = (primary: SchemaStore, local?: SchemaStore): SchemaStore => (slug) => primary(slug) ?? local?.(slug) ?? null;

/** La página tras la reanudación: lo escrito se acumula, el resumen y la sesión son los del último turno. */
export function mergeResumed(raw: PageModel, next: PageModel): PageModel {
  const a = raw.agent as NonNullable<PageModel['agent']>;
  const b = next.agent as NonNullable<PageModel['agent']>;
  const sum = (x?: number, y?: number): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const inputTokens = sum(a.usage?.inputTokens, b.usage?.inputTokens);
  const outputTokens = sum(a.usage?.outputTokens, b.usage?.outputTokens);
  return {
    ...raw,
    ...(next.page ? { page: { ...(raw.page ?? {}), ...next.page } } : {}),
    agent: { ...a, ...b, files: [...new Set([...a.files, ...b.files])], summary: b.summary || a.summary, ...(b.sessionId ?? a.sessionId ? { sessionId: b.sessionId ?? a.sessionId } : {}), usage: { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) } },
  };
}

/** Lo que se re-corre: el pedido tal como llegó al composer, con el registry reducido a su pin. La página padre no se copia:
 * ya está en la versión padre. */
export function requestRecord(req: ComposeRequest, registryPin: string | undefined, dsSkill?: string): Record<string, unknown> {
  // runToken: es una credencial de gasto; request.json se commitea en el git del ws y el agente lo lee en su cwd.
  const { registry: _registry, parentPage: _parentPage, workspace, brandSkill: _brandSkill, runToken: _runToken, ...rest } = req;
  return { ...rest, ...(workspace ? { agent: true } : {}), ...(registryPin ? { registryPin, ...(dsSkill ? { dsSkill } : {}) } : {}) };
}

/** Campos de request.json que otras corridas heredan de la versión padre. */
export type RequestKey = 'registryPin' | 'factsVersion' | 'dsSkill';

/** Una versión con pin y sin dsSkill es de antes de B9 paso 4, cuando el único DS del core era Arc. */
export const LEGACY_DS_SKILL = 'arc-agent';

/** El DS (skill del agente) con que se construyó una versión: undefined si la versión no tiene pin de registry. */
// request.json vive en el ws y el agente lo puede tocar: un valor que no es un id de skill no llega al mensaje del 409 ni
// a ds.skill; cuenta como versión anterior al registro.
/** Abre el registry en el pin de una versión. Un pin de otro DS (un chat de Arc tras #852) no está en el registry del
 * core: el error dice de qué DS es el chat, no "index@<sha> no existe". */
export async function openPinned<T>(open: (pin?: string) => Promise<T>, pin: string | undefined, skill: string | undefined): Promise<T> {
  try {
    return await open(pin);
  } catch (e) {
    const current = config().agentSkillId;
    if (pin && skill && skill !== current) throw new HttpError(409, `este chat es de ${skill} y este proceso no tiene su registry (${pin}); el registry de este proceso publica ${current}`);
    throw e;
  }
}

export const dsSkillOf = (pin: string | undefined, recorded: string | undefined): string | undefined => {
  if (!pin) return undefined;
  return recorded !== undefined && SKILL_ID.test(recorded) ? recorded : LEGACY_DS_SKILL;
};

// package.json más el lockfile que haya: con --frozen-lockfile son los dos lo que fija qué queda en node_modules.
const DEPS_FILES = ['package.json', 'bun.lock', 'bun.lockb'];
const depsHash = (dir: string): string => {
  const h = createHash('sha256');
  for (const f of DEPS_FILES) if (existsSync(join(dir, f))) h.update(`${f}\0`).update(readFileSync(join(dir, f))).update('\0');
  return h.digest('hex');
};

export interface RunChecksDeps {
  /** El índice se lee en cada uso (nunca se captura): baseOf mira el commit del padre. */
  index: () => Readonly<Record<string, Readonly<MessageEntry>>>;
}

export class RunChecks {
  constructor(private deps: RunChecksDeps) {}

  /** Contra qué árbol corre un turno: el commit del padre, o HEAD sin padre con versión. Descartar va a esta misma base:
   * discardChanges vuelve a HEAD, y con un padre que no es HEAD el ws (y el preview vivo) saltaba a la versión de otra rama. */
  baseOf(messageId: string): string {
    const parentId = this.deps.index()[messageId]?.parentId;
    return (parentId ? this.deps.index()[parentId]?.commit : undefined) ?? 'HEAD';
  }

  /** Sin escrituras del turno. La vara es el commit del padre y no HEAD: un follow-up sobre una versión que no es HEAD
   * restaura su árbol sin mover HEAD (restoreTree), así que contra HEAD el árbol "difería" aunque el agente no escribiera
   * y commitAll guardaba una versión idéntica a la del padre. Sin padre (primer mensaje) la base sí es HEAD. */
  untouched(messageId: string, dir: string): boolean {
    const base = this.baseOf(messageId);
    return base === 'HEAD' ? isClean(dir) : changedSince(dir, base).length === 0;
  }

  async installDeps(dir: string, log: EventLog, signal?: AbortSignal, o: { afterAgent?: boolean; retryUnfrozen?: boolean } = {}): Promise<void> {
    // Hecho = el último install salió con 0, no que exista node_modules: uno cortado por el plazo o por un error deja un
    // node_modules a medias y las corridas siguientes se saltaban el install para siempre (Arq, R1.3). El marcador vive
    // dentro de node_modules: lo ignora git y desaparece si alguien lo borra.
    // La marca guarda el hash del package.json + lockfile DEL WORKSPACE que se instaló. Cubre la marca vacía legada y los
    // cambios de deps que traiga el árbol (el agente, el DS); una subida del scaffold NO llega a un ws existente, porque su
    // package.json/lock son los que copió al crearse (pendiente de updateDs).
    const done = join(dir, 'node_modules', INSTALLED_MARK);
    if (!existsSync(join(dir, 'package.json'))) return;
    if (existsSync(done) && readFileSync(done, 'utf8') === depsHash(dir)) return;
    // Fuera antes de instalar: con la marca vieja en pie, preview-dist.installed() seguía true y vite arrancaba sobre un
    // node_modules a medias; y un install cortado dejaba marca vieja + node_modules roto.
    rmSync(done, { force: true });
    // La marca nueva que se escribe al final reinicia el vite vivo del ws (wt-deps-restart-plugin): sin eso no resolvía la dep.
    const args = o.afterAgent ? ['install'] : ['install', '--frozen-lockfile'];
    try {
      await sh(log, 'transport:install', ['Installing dependencies', 'Installed dependencies'], 'bun', args, dir, signal);
    } catch (e) {
      // Una versión puede traer package.json y lock que no se corresponden (el install de cierre cayó tras un cambio de deps):
      // con frozen fallaría en cada follow-up para siempre. Un reintento sin frozen lo reconcilia; un Stop no se reintenta.
      if (!o.retryUnfrozen || o.afterAgent || signal?.aborted) throw e;
      await sh(log, 'transport:install-retry', ['Reinstalling without frozen lockfile', 'Reinstalled dependencies'], 'bun', ['install'], dir, signal);
    }
    // Después del install: sin --frozen-lockfile bun reescribe el lockfile, y la marca tiene que coincidir con lo que queda.
    writeFileSync(done, depsHash(dir));
  }

  /** Lo que ve la usuaria en el preview vivo: defectos del navegador más los errores que vite escribió en su
   * terminal. Como el render, queda a la vista y no bloquea; no alimenta el repair, que sale del render-gate. */
  async checkPreview(url: string, dir: string, log: EventLog, previews: PreviewPool, check: PreviewChecker, logFile?: string, signal?: AbortSignal, viewport?: Viewport): Promise<void> {
    const id = 'transport:preview-check';
    log.emit({ type: 'step.start', stepId: id, kind: 'tool', label: 'Checking preview' });
    // Solo supersede corta con SUPERSEDED; el apagado (transport.shutdown) aborta sin motivo. Antes ambos decían "otra
    // corrida empezó", engañoso en un apagado (QA 6.8).
    const superseded = () => log.emit(signal?.reason === SUPERSEDED
      ? { type: 'step.end', stepId: id, label: 'Preview check superseded', status: 'error', error: { type: 'superseded', message: 'otra corrida empezó en este workspace antes de terminar la revisión' } }
      : { type: 'step.end', stepId: id, label: 'Preview check stopped', status: 'error', error: { type: 'stopped', message: 'el transport se apagó antes de terminar la revisión; la versión ya estaba guardada' } });
    try {
      // Lo que vite registró antes (el turno del agente recarga por HMR páginas a medio escribir) es historia del
      // turno, no un defecto de la versión: queda como dato y el check cuenta solo lo de su propia carga.
      const turn = previews.drainErrors(dir);
      const cut = new Promise<null>((resolve) => signal?.addEventListener('abort', () => resolve(null), { once: true }));
      // Q6: el check mide también al ancho de la persona, que es el que ella ve al cerrar la versión.
      const found = signal?.aborted ? null : await Promise.race([check(url, dir, { ...(logFile ? { logFile } : {}), ...(viewport ? { viewport: { width: viewport.width, height: viewport.height } } : {}) }), cut]);
      // El check sigue en su navegador hasta terminar, pero lo que vea ya es la página del turno nuevo: no se reporta.
      if (found === null || signal?.aborted) return void superseded();
      const defects = found;
      const server = previews.drainErrors(dir);
      const n = defects.length + server.length;
      const detail = { kind: 'tool' as const, name: 'preview-runtime', output: { url, defects, server, ...(turn.length ? { turn } : {}) } };
      if (n === 0) log.emit({ type: 'step.end', stepId: id, label: 'Checked preview', status: 'ok', detail });
      else log.emit({ type: 'step.end', stepId: id, label: `Found ${n} preview issue${n === 1 ? '' : 's'}`, status: 'error', detail, error: { type: 'execution-error', message: [...defects.map((d) => `${d.kind} ${d.slug ?? '-'}: ${d.message.split('\n')[0]}`), ...server].slice(0, 5).join('\n') } });
    } catch (e) {
      if (signal?.aborted) return void superseded();
      log.emit({ type: 'step.end', stepId: id, label: 'Preview check failed', status: 'error', error: { type: 'execution-error', message: e instanceof Error ? e.message : String(e) } });
    }
  }

  /** Cuánto de su ventana ocupó el turno (M2 f, O2-B): se registra en el log, no se pinta. Lo emiten TODOS los cierres de
   * un turno con agente (versión, asked y plan), desde agent.trace.context; antes solo salía en el cierre con versión. */
  emitContextUsage(log: EventLog, page: PageModel): void {
    const ctx = page.agent?.trace?.context;
    if (ctx) log.emit({ type: 'context.usage', ratio: ctx.ratio, lastTokens: ctx.lastTokens, floorTokens: ctx.floorTokens, window: ctx.window });
  }
}
