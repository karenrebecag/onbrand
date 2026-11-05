// Cierre del ciclo de corrida (ADR 0014 Enmienda 1, PR 1): cómo un turno se vuelve versión, pregunta, plan o nada, y cómo se
// recupera una corrida que el proceso anterior dejó a medias. Toda escritura del índice pasa por `updateEntry` (regla 5): las
// que antes se hacían con `this.index[id].x = ...` + `save()` se pliegan en el patch de `end`, que es el único que persiste el
// desenlace. El estado (Maps, índice) se lee por referencia; `end`/`keepStopped`/`keepPlan`/`materialize`/`recover` son suyos,
// las comprobaciones (baseOf/untouched/installDeps/checkPreview/emitContextUsage) viven en run-checks.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_FILE, parsePagePlanMd, planInvented } from '../page-plan-md';
import { openEventLog, readEvents, type EngineEvent, type EventLog, type FinishReason, type Outcome } from './events';
import { changedFiles, changedSince, commitAll, isRepo, listFiles, parentOf, restoreTree } from './git-workspace';
import { normalizePage, type PageModel } from './runner';
import { step } from './step';
import type { Viewport } from './follow-up-context';
import type { SuggestHook } from './agent-composer';
import type { PreviewChecker } from './preview-check';
import type { PinnedLost } from './pinned';
import type { RuntimeDefect } from '../runtime-sensors';
import type { PreviewDist } from './preview-dist';
import type { AgentMcp } from './agent-mcp';
import type { VariantRuns } from './variants';
import { mergeResumed, RunChecks } from './run-checks';
import { INSTRUCTIONS_FILE, lastSessionId, OUTCOME_OF, PAGE_FILE, PAGE_PATHS, REQUEST_FILE, sh, VERSION_BUILD, type Composer, type MessageEntry, type RuntimeOptions } from './shared';

/** Origen del corte que shutdown() deja en stopReasons; keepStopped lo lee como caída del transport. */
export const SHUTDOWN_REASON = 'cierre del transport';

export interface RunCloseDeps {
  opts: RuntimeOptions;
  logDir: string;
  index: () => Readonly<Record<string, Readonly<MessageEntry>>>;
  updateEntry: (id: string, patch: Partial<MessageEntry>) => void;
  wsDir: (ws: string) => string;
  checks: RunChecks;
  previewDist: PreviewDist;
  agentMcp: Pick<AgentMcp, 'cancelPlan'>;
  variants: Pick<VariantRuns, 'failVariant' | 'enqueue'>;
  stopReasons: Map<string, string>;
  /** El preview-check tardío de cada workspace: una corrida nueva lo corta. */
  lateChecks: Map<string, AbortController>;
  /** Pasos tardíos por mensaje (preview-check ‖ sugerencias): corren después de message.end y settle() los espera. */
  late: Map<string, Promise<unknown>>;
}

type EndOptions = {
  outcome?: Outcome;
  interrupted?: true;
  continuable?: boolean;
  usage?: Extract<EngineEvent, { type: 'message.end' }>['usage'];
  /** Lo que antes se escribía con `this.index[id].x = ...` antes de end(): se pliega aquí para que updateEntry lo persista
   * junto con el desenlace, en una sola escritura (regla 5). */
  commit?: string;
  sessionId?: string;
  asked?: string;
  plan?: MessageEntry['plan'];
};

export class RunClose {
  constructor(private deps: RunCloseDeps) {}

  /** keepPlan le pone al plan el commit del padre: si la fase build cae antes de su commit, ese commit no es suyo. */
  private inheritedCommit(entry: Readonly<MessageEntry>): boolean {
    return entry.plan !== undefined && entry.commit !== undefined && entry.commit === (entry.parentId ? this.deps.index()[entry.parentId]?.commit : undefined);
  }

  /** Una corrida que el proceso anterior dejó sin message.end (kill -9, crash) se cierra: si no, el cliente espera un
   * final que nunca llega. Como el Stop, lo que el agente alcanzó a escribir en un follow-up queda como versión detenida;
   * sin nada que guardar, el workspace vuelve a la última versión. Con el lock del root, solo llegan aquí corridas
   * muertas, nunca las vivas de otro proceso. */
  recover(id: string): 'queued' | undefined {
    const entry = this.deps.index()[id];
    if (!existsSync(join(this.deps.logDir, `${id}.ndjson`))) {
      // Una variante sin log cayó mientras se bifurcaba o se planeaba, antes de run.queued: no hay plan con qué seguir.
      if (entry.variantOf) this.deps.variants.failVariant(id, 'la variante se interrumpió: el transport se reinició antes de prepararla');
      return undefined;
    }
    const { events, done } = readEvents(this.deps.logDir, id);
    // El estado sale del log (R3.2): run.queued sin run.started es una variante que esperaba lugar; vuelve a la cola.
    const queued = events.find((e): e is Extract<EngineEvent, { type: 'run.queued' }> => e.type === 'run.queued');
    if (queued && !done && !events.some((e) => e.type === 'run.started')) {
      this.deps.variants.enqueue(id, { attachments: [], prompt: queued.variant.prompt, ...(entry.model ? { model: entry.model } : {}), ...entry.variantRun, variant: queued.variant });
      return 'queued';
    }
    const log = openEventLog(this.deps.logDir, id);
    // Todo cierre termina en settled, también el de una corrida que cayó entre message.end y settled (ADR 0013, regla
    // común 2; event-model.ts:71): sin él el builder la daba por viva para siempre (builder.md §1).
    if (done) {
      if (!events.some((e) => e.type === 'settled')) log.emit({ type: 'settled' });
      return undefined;
    }
    const dir = this.deps.wsDir(entry.ws);
    if (this.endedBeforeCrash(entry, events)) {
      this.reemitEnd(id, entry, dir, log);
      log.emit({ type: 'settled' });
      return undefined;
    }
    log.emit({ type: 'error', message: 'la corrida se interrumpió: el transport se reinició antes de terminar' });
    if (entry.kind) {
      // Patch, edición directa y restore no tienen "lo que alcanzó a escribir el agente": a medio aplicar se descartan
      // (ADR 0013 D2; nosotros.md §7.3, §7.9).
      if (!entry.commit && isRepo(dir)) restoreTree(dir, this.deps.checks.baseOf(id));
      this.end(id, log, 'error', { outcome: 'failed', interrupted: true, continuable: false });
    } else if ((!entry.commit || this.inheritedCommit(entry)) && isRepo(dir)) {
      const sessionId = lastSessionId(dir, entry.at ?? 0);
      if (sessionId) this.deps.updateEntry(id, { sessionId });
      this.keepStopped(id, dir, log, { interrupted: true });
    } else if (entry.commit) {
      // Cayó entre el commit y el message.end: la versión está completa (Arq, verificación de R2).
      this.end(id, log, 'stop', { outcome: 'ok', interrupted: true, continuable: false });
    } else this.end(id, log, 'stopped', { interrupted: true, continuable: false });
    log.emit({ type: 'settled' });
    return undefined;
  }

  /** end() escribe el índice antes del message.end: si el log no lo tiene pero el índice trae un desenlace posterior al
   * último message.start, el cierre ya se decidió y solo faltó emitirlo. Uno anterior es de otra fase del mismo mensaje
   * (el plan asked cuya fase build cayó a medias) y no cuenta. */
  private endedBeforeCrash(entry: Readonly<MessageEntry>, events: readonly EngineEvent[]): boolean {
    const start = [...events].reverse().find((e) => e.type === 'message.start');
    return entry.outcome !== undefined && entry.endedAt !== undefined && start !== undefined && entry.endedAt > start.at;
  }

  /** El message.end que end() no alcanzó a emitir, con lo que ya está en el índice y sin recalcular; y su snapshot, como
   * lo emiten keepStopped/keepPlan después de end: una pregunta o un plan con el commit del padre, sin archivos. */
  private reemitEnd(id: string, entry: Readonly<MessageEntry>, dir: string, log: EventLog): void {
    const outcome = entry.outcome as Outcome;
    // El finishReason no se guarda: sale del outcome. Una edición directa reemitida dice 'stop' en vez de 'patch'; el
    // desenlace, que es lo que lee el builder, es el mismo.
    const finishReason: FinishReason = outcome === 'stopped' ? 'stopped' : outcome === 'failed' ? 'error' : 'stop';
    log.emit({ type: 'message.end', finishReason, outcome, ...(entry.interrupted ? { interrupted: true as const } : {}), ...(entry.continuable !== undefined ? { continuable: entry.continuable } : {}) });
    if (!entry.commit) return;
    const own = entry.asked === undefined && !this.inheritedCommit(entry) && isRepo(dir);
    log.emit({ type: 'snapshot', dir, files: own ? listFiles(dir, entry.commit, PAGE_PATHS) : [], commit: entry.commit });
  }

  /** Cierre de toda corrida: message.end con su desenlace, y el mismo desenlace en el índice para GET /chats (ADR 0013,
   * regla común 3). Sin outcome explícito sale de finishReason. commit/sessionId/asked/plan se persisten aquí con el
   * desenlace en una sola escritura (regla 5). */
  end(messageId: string, log: EventLog, finishReason: FinishReason, o: EndOptions = {}): void {
    const outcome = o.outcome ?? OUTCOME_OF[finishReason];
    // El índice se escribe ANTES del message.end: si el proceso muere entre los dos, recover ve done=true y solo emite
    // settled, así que commit/sessionId/plan tienen que estar ya en disco (Arq, revisión de PR 1; antes keepPlan y
    // materialize los guardaban antes de emitir).
    if (this.deps.index()[messageId]) {
      this.deps.updateEntry(messageId, {
        outcome,
        endedAt: Date.now(),
        ...(o.interrupted ? { interrupted: true as const } : {}),
        ...(o.continuable !== undefined ? { continuable: o.continuable } : {}),
        ...(o.commit !== undefined ? { commit: o.commit } : {}),
        ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
        ...(o.asked !== undefined ? { asked: o.asked } : {}),
        ...(o.plan !== undefined ? { plan: o.plan } : {}),
      });
    }
    log.emit({ type: 'message.end', finishReason, outcome, ...(o.interrupted ? { interrupted: true as const } : {}), ...(o.continuable !== undefined ? { continuable: o.continuable } : {}), ...(o.usage ? { usage: o.usage } : {}) });
  }

  /** Cancel de la persona, como el Stop de Lovable: lo que el agente alcanzó a escribir queda como versión, sin gates. Sin
   * page.json en el árbol (primer mensaje) ese commit no serviría de padre a un follow-up, y sin escrituras duplicaría la
   * del padre: en ambos casos no hay versión y el hilo sigue colgando del padre. */
  keepStopped(messageId: string, dir: string, log: EventLog, o: { outcome?: 'stopped' | 'failed'; interrupted?: true } = {}): undefined {
    const outcome = o.outcome ?? 'stopped';
    const finishReason: FinishReason = outcome === 'failed' ? 'error' : 'stopped';
    // La recuperación al reiniciar también pasa por aquí, sin pedido de corte: ahí ya hay un error que lo explica.
    const reason = this.deps.stopReasons.get(messageId);
    this.deps.stopReasons.delete(messageId);
    // Un SIGTERM al transport es una caída para la corrida, igual que el kill -9 que cierra recover (R2.6): queda
    // interrumpida y se puede continuar con la sesión que alcanzó a escribir. Sin esto solo el crash ofrecía Continuar.
    const interrupted = o.interrupted ?? (reason === SHUTDOWN_REASON ? (true as const) : undefined);
    const entry = this.deps.index()[messageId];
    // sessionId/plan que antes se escribían sobre el entry antes de end(): se acumulan y se pliegan en el end final.
    const patch: { sessionId?: string; plan?: MessageEntry['plan'] } = {};
    // Un corte de la persona deja sin decidir el plan que ya se había enviado (§8). Un apagado o una recuperación no: ahí el
    // plan sigue pendiente y su decisión vale tras reiniciar.
    if (entry?.plan?.status === 'pending' && !interrupted) this.deps.agentMcp.cancelPlan(messageId, entry, 'stopped', log);
    if (interrupted && entry && !entry.sessionId) {
      const sessionId = isRepo(dir) ? lastSessionId(dir, entry.at ?? 0) : undefined;
      if (sessionId) patch.sessionId = sessionId;
    }
    // La fase build del plan reanuda plan.sessionId, que solo llena keepPlan y un turno caído nunca llegó a él: se le da la
    // sesión recuperada, o sin ninguna el plan no se podría aprobar nunca y se cancela.
    if (interrupted && entry?.plan?.status === 'pending' && !entry.plan.sessionId) {
      const sid = patch.sessionId ?? entry.sessionId;
      if (sid) patch.plan = { ...entry.plan, sessionId: sid };
      else this.deps.agentMcp.cancelPlan(messageId, entry, 'stopped', log);
    }
    if (reason) {
      log.emit({ type: 'step.start', stepId: 'transport:stop', kind: 'action', label: 'Detenido' });
      log.emit({ type: 'step.end', stepId: 'transport:stop', label: 'Detenido', status: 'ok', detail: { kind: 'action', name: 'stop', summary: `${reason} a las ${new Date().toISOString()}` } });
    }
    if (!existsSync(join(dir, PAGE_FILE)) || this.deps.checks.untouched(messageId, dir)) {
      if (isRepo(dir)) restoreTree(dir, this.deps.checks.baseOf(messageId));
      // Sin versión no hay nada sobre qué seguir (R2.6): el builder ofrece reenviar el pedido.
      this.end(messageId, log, finishReason, { outcome, ...patch, ...(interrupted ? { interrupted: true as const } : {}), ...(interrupted || outcome === 'failed' ? { continuable: false } : {}) });
      return undefined;
    }
    const commit = commitAll(dir, this.deps.index()[messageId].title ?? messageId);
    // Una versión que quedó a medias por una caída (del transport o del CLI) se puede seguir con la sesión que la escribió.
    const continuable = interrupted || outcome === 'failed' ? Boolean(patch.sessionId ?? entry?.sessionId) : undefined;
    // end persiste el commit con el desenlace en una sola escritura.
    this.end(messageId, log, finishReason, { outcome, ...patch, commit, ...(interrupted ? { interrupted: true as const } : {}), ...(continuable !== undefined ? { continuable } : {}) });
    log.emit({ type: 'snapshot', dir, files: listFiles(dir, commit, PAGE_PATHS), commit });
    return undefined;
  }

  /** Cierre de un turno de plan (H6, §6): no crea versión. Como `asked`, cuelga del padre (commit del padre si lo hay) y
   * el picker lo filtra. El plan vive en `.wt` (fuera del commit); si algo tocó el árbol versionado, se descarta. */
  keepPlan(messageId: string, dir: string, log: EventLog, fresh: PageModel): undefined {
    const entry = this.deps.index()[messageId];
    this.deps.checks.emitContextUsage(log, fresh);
    // El filtro de Approvals impide escrituras fuera de `.wt/plans/`; esto es defensa: un árbol sucio no se guarda.
    if (isRepo(dir) && !this.deps.checks.untouched(messageId, dir)) restoreTree(dir, this.deps.checks.baseOf(messageId));
    const parentCommit = entry.parentId ? this.deps.index()[entry.parentId]?.commit : undefined;
    const usage = fresh.agent?.usage ? { usage: fresh.agent.usage } : {};
    if (entry.plan) {
      // La sesión del turno de plan, para reanudar la fase build al aprobar.
      const plan = fresh.agent?.sessionId ? { ...entry.plan, sessionId: fresh.agent.sessionId } : undefined;
      this.end(messageId, log, 'stop', { outcome: 'asked', ...usage, ...(parentCommit ? { commit: parentCommit } : {}), ...(plan ? { plan } : {}) });
      if (parentCommit) log.emit({ type: 'snapshot', dir, files: [], commit: parentCommit });
      return undefined;
    }
    // Sin exit_plan_mode: si el agente preguntó (ask_user), cae al caso `asked` con la pregunta; si no, es un error visible.
    if (fresh.agent?.question) {
      this.end(messageId, log, 'stop', { outcome: 'asked', ...usage, ...(parentCommit ? { commit: parentCommit } : {}), asked: fresh.agent.question.question });
      if (parentCommit) log.emit({ type: 'snapshot', dir, files: [], commit: parentCommit });
      return undefined;
    }
    log.emit({ type: 'error', message: 'el plan no se envió: el turno terminó sin llamar a exit_plan_mode' });
    this.end(messageId, log, 'error');
    return undefined;
  }

  /** De una página ya decidida a una versión: workspace, build, commit y preview. Con el agente (ADR 0011, C5) los
   * archivos ya están escritos en el workspace; materialize solo los commitea, construye y sirve. */
  async materialize(messageId: string, dir: string, log: EventLog, raw: PageModel, extra: string[], finishReason: 'stop' | 'stopped', request: Record<string, unknown>, instructions?: string[], resumeOnBuild?: (error: string) => Promise<PageModel | undefined>, viewport?: Viewport): Promise<void> {
    // page.json guarda lo mismo que se emitió (children de nodo ya en props).
    let page = normalizePage(raw);
    // Como v0, que cierra la pregunta con user-input-required y sin versión (planes/ec.md §F1): el mensaje apunta a la
    // versión del padre y la pregunta queda en el índice para el historial de la respuesta.
    const parentId = this.deps.index()[messageId].parentId;
    const parentCommit = parentId ? this.deps.index()[parentId]?.commit : undefined;
    // Pregunta = el turno no dejó nada en el árbol. No basta con que el agente no haya usado Write/Edit: generate_image y
    // edit_image escriben public/images por su cuenta, y un turno que solo cambió fotos quedaba como pregunta, con la
    // versión del padre y las imágenes sin commit (QA A8).
    // Un turno que terminó con un result de error y no escribió nada no es versión ni pregunta: antes quedaba como
    // pregunta con el texto del error (nosotros.md §6, §7.8; ADR 0013, regla común 3).
    if (raw.agent?.failed && !raw.agent.files.length && (!parentCommit || !changedSince(dir, parentCommit).length)) {
      restoreTree(dir, this.deps.checks.baseOf(messageId));
      this.end(messageId, log, 'error', { outcome: 'failed', continuable: false, ...(raw.agent.usage ? { usage: raw.agent.usage } : {}) });
      return undefined;
    }
    if (raw.agent && !raw.agent.files.length && parentCommit && finishReason === 'stop' && !changedSince(dir, parentCommit).length) {
      this.deps.checks.emitContextUsage(log, raw);
      this.end(messageId, log, finishReason, { outcome: 'asked', commit: parentCommit, asked: raw.agent.question?.question ?? raw.agent.summary, ...(raw.agent.usage ? { usage: raw.agent.usage } : {}) });
      log.emit({ type: 'snapshot', dir, files: [], commit: parentCommit });
      return undefined;
    }
    // Con el agente (ADR 0011, C5) los archivos ya están en el workspace: no hay TSX que emitir ni composición que validar.
    if (!raw.agent) throw new Error('materialize: el runner se retiró (C5); todo compose pasa por el agente');
    const written = raw.agent.files;
    writeFileSync(join(dir, PAGE_FILE), JSON.stringify(page, null, 2));
    writeFileSync(join(dir, REQUEST_FILE), JSON.stringify(request, null, 2));
    // Sin instructions nuevas (patch) queda el archivo del padre tal cual.
    if (instructions) writeFileSync(join(dir, INSTRUCTIONS_FILE), JSON.stringify(instructions, null, 2));
    // Tras el agente: si tocó package.json o el lockfile, frozen fallaría y cada follow-up caería en install para siempre.
    await this.deps.checks.installDeps(dir, log, undefined, { afterAgent: Boolean(raw.agent) });
    // Sin --base (R5.5): el dist se sirve en la raíz del origen por ws (`<ws>.localhost:<previewPort>`), igual que el dev
    // server (preview.ts). Los snapshots viejos con --base se descartan en distFor (assets bajo /preview/ no resuelven).
    if (this.deps.opts.build !== false) {
      const [cmd, ...args] = this.deps.opts.buildCommand ?? VERSION_BUILD;
      const build = (): Promise<void> => sh(log, 'transport:build', ['Building', 'Built'], cmd, args, dir);
      try {
        await build();
      } catch (e) {
        // R6 C2: v0 corre el build dentro del loop y el agente ve el error; aquí corre después del turno, así que el error
        // vuelve por UNA reanudación de su sesión. Si el turno no terminó, la corrida cierra con el error del primer build; si el
        // segundo build también falla, con el del SEGUNDO (el que describe el estado final del árbol que se iba a guardar).
        const next = raw.agent?.sessionId && resumeOnBuild ? await resumeOnBuild(e instanceof Error ? e.message : String(e)) : undefined;
        if (!next?.agent || next.agent.failed || next.agent.interrupted) throw e;
        raw = mergeResumed(raw, next);
        page = normalizePage(raw);
        writeFileSync(join(dir, PAGE_FILE), JSON.stringify(page, null, 2));
        await build();
      }
    }
    // La página la miró el propio agente (tool browser) y la revisa el preview-check: el render-gate (que leía el
    // render-input.json del runner) se retiró con el runner (C5).
    const commit = step(log, 'transport:commit', 'action', ['Saving version', 'Saved version'], () => {
      const sha = commitAll(dir, this.deps.index()[messageId].title ?? messageId);
      return { value: sha, detail: { kind: 'action', name: 'commit', summary: sha } };
    });
    // Visible apenas se commitea, antes de los pasos async (preview): un GET /chats concurrente ya ve la versión.
    this.deps.updateEntry(messageId, { commit });
    // M2 (C4): lo que el plan declara inventado, para que la persona vea qué de la página es de ejemplo.
    const planMd = join(dir, PLAN_FILE);
    if (existsSync(planMd)) log.emit({ type: 'facts.invented', items: planInvented(parsePagePlanMd(readFileSync(planMd, 'utf8'))) });
    // dist/<commit> por versión (R5.3): guarda el dist recién construido bajo .wt (ignorado por git) para servir la
    // versión como estático cuando su vite no está vivo. Bloque aparte del build a propósito (C2 de orqWT irá ahí).
    if (this.deps.opts.build !== false) this.deps.previewDist.trySaveDist(dir, commit);
    let checkUrl: string | undefined;
    if (this.deps.opts.previews) {
      log.emit({ type: 'step.start', stepId: 'transport:preview', kind: 'action', label: 'Starting preview' });
      try {
        const { url, localUrl } = await this.deps.opts.previews.ensure(dir);
        log.emit({ type: 'step.end', stepId: 'transport:preview', label: 'Preview ready', status: 'ok', detail: { kind: 'action', name: 'preview', summary: url } });
        checkUrl = localUrl;
      } catch (e) {
        // Sin preview la versión igual quedó guardada: el error es del paso, no del mensaje.
        log.emit({ type: 'step.end', stepId: 'transport:preview', label: 'Preview failed', status: 'error', error: { type: 'execution-error', message: e instanceof Error ? e.message : String(e) } });
      }
    }
    // Un failed que escribió es versión (decisión de Arq: un result de error suele ser una caída de la API a mitad de un turno
    // pagado, nosotros.md §6, §7.8), y como una corrida que el CLI no pudo terminar, se puede continuar con su sesión.
    const outcome: Outcome = raw.agent?.failed ? 'failed' : finishReason === 'stopped' ? 'stopped' : 'ok';
    this.deps.checks.emitContextUsage(log, raw);
    const continuable = outcome === 'ok' ? undefined : Boolean(raw.agent?.sessionId);
    this.end(messageId, log, finishReason, { outcome, ...(raw.agent?.sessionId ? { sessionId: raw.agent.sessionId } : {}), ...(continuable !== undefined ? { continuable } : {}), ...(raw.agent?.usage ? { usage: raw.agent.usage } : {}) });
    // Lo que cambió la versión sale del diff de su commit contra la versión padre, no de los Write/Edit del agente: ahí no
    // entran las imágenes de generate_image/edit_image ni lo que escribe el sistema (App, marca), y el builder marcaba
    // "no cambió" variantes que habían reemplazado fotos (QA A8, c7c7ec26).
    const base = parentCommit ?? parentOf(dir, commit);
    log.emit({ type: 'snapshot', dir, files: base ? changedFiles(dir, base, commit) : [...written, ...extra, PAGE_FILE, REQUEST_FILE], commit });
    this.startLate(messageId, dir, log, page, raw, finishReason, checkUrl, viewport);
  }

  /** Con la versión ya guardada y el turno cerrado, preview-check y sugerencias corren en paralelo (síntesis A: 45-93 s que
   * la persona esperaba en serie). Lovable entrega featureSuggestions como asyncRunResult del run ya terminado
   * (dashboard-shared-CKfq1xYq.deob.js:4756-4762). */
  private startLate(messageId: string, dir: string, log: EventLog, page: PageModel, raw: PageModel, finishReason: 'stop' | 'patch' | 'stopped', checkUrl: string | undefined, viewport?: Viewport): void {
    const ws = this.deps.index()[messageId].ws;
    const jobs: Promise<unknown>[] = [];
    // Un turno que preguntó no escribió nada (#402): como v0 con user-input-required, no hay qué revisar y sus chips son
    // las respuestas, que unas sugerencias nuevas pisarían.
    if (raw.agent && !raw.agent.files.length) return;
    if (checkUrl && this.deps.opts.previews && this.deps.opts.previewCheck) {
      const stop = new AbortController();
      this.deps.lateChecks.set(ws, stop);
      const check = withPinnedLost(this.deps.opts.previewCheck, raw.agent?.pinnedLost ?? []);
      jobs.push(this.deps.checks.checkPreview(checkUrl, dir, log, this.deps.opts.previews, check, join(this.deps.logDir, `${messageId}.ndjson`), stop.signal, viewport).finally(() => {
        if (this.deps.lateChecks.get(ws) === stop) this.deps.lateChecks.delete(ws);
      }));
    }
    const suggest = (this.deps.opts.compose as Composer & { suggest?: SuggestHook }).suggest;
    const prompt = this.deps.index()[messageId].prompt;
    // Un turno detenido, caído o de arreglo no tiene siguiente paso que ofrecer: no se gasta la llamada.
    if (suggest && raw.agent && finishReason === 'stop' && !raw.agent.failed && !raw.agent.interrupted && prompt) {
      const lang = typeof page.page?.lang === 'string' ? page.page.lang : 'es';
      jobs.push(suggest({ prompt, summary: raw.agent.summary, lang }, log, raw.agent.factsDisclosed));
    }
    if (jobs.length) this.deps.late.set(messageId, Promise.allSettled(jobs));
  }
}

/** Lo dictado literal que el turno perdió (Q1/O3, QA #615) va con los defectos del preview-check, para que la persona lo
 * vea en la misma revisión y el siguiente follow-up lo reciba en preview-del-padre.md. Del contrato de página (owner A):
 * el texto lo fijó la persona, no un bloque. */
function withPinnedLost(check: PreviewChecker, lost: readonly PinnedLost[]): PreviewChecker {
  if (!lost.length) return check;
  const defects = lost.map((p): RuntimeDefect => ({ field: 'preview.runtime', owner: 'A', kind: 'preserve-text', slug: /src\/sections\/(\d{2}-[^/]+)\.tsx$/.exec(p.file)?.[1] ?? null, viewport: 0, message: `el texto dictado en ${p.messageId} ya no está en ${p.file}: "${p.text}"`.slice(0, 300), text: p.text }));
  return async (url, dir, opts) => [...(await check(url, dir, opts)), ...defects];
}
