// Herramientas de verificación que el agente de página llama dentro de su turno (ADR 0011, specs/refinamiento.md),
// como v0 en j049: `npx tsc --noEmit | head -30` y agent-browser contra el dev server, con la captura de vuelta al
// modelo. Definición en formato de tool de la API de Anthropic, como tools.ts; el content del resultado ya tiene la
// forma de un tool_result (texto + imagen), y el servidor MCP (scripts/workspace-mcp.ts) lo traduce para `claude -p`.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkIdentity, formatIdentityCheck, IDENTITY_EDIT_FILE } from '../identity-ephemeral';
import { DESIGN_FILE } from '../identity-design';
import { undefinedTokenReport } from '../css-tokens';
import { dsLintWorkspace, formatLint } from '../ds-lint';
import { runtimeDefects, type RuntimeDefect } from '../runtime-sensors';
import { filesSinceBase } from './git-workspace';
import type { ToolDef } from './tools';
import { ASK_TOOL, ASK_TOOL_DEF, parseQuestion } from './ask-user';
import { EXIT_PLAN_TOOL, parsePlanExit, validatePlanFile } from './plan-exit';
import type { BrowseAction, BrowseRequest, BrowseResult, Overflow } from './browser';
import { MAX_QUESTION, type Describe } from './vision';
import { EDIT_IMAGE_TOOL, IMAGE_TOOL, runEditImageTool, runImageTool, type ImageEdit } from './image-tool';
import type { ImageGen } from './image-step';
import { track } from './children';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };
export type WorkspaceToolResult = { ok: true; content: ContentBlock[] } | { ok: false; error: string };

export interface WorkspaceToolContext {
  dir: string;
  /** El preview vivo del workspace (dev, no dist): lo que ve la usuaria. */
  previews: { ensure(dir: string): Promise<{ url: string }>; drainErrors?(dir: string): string[] };
  browse?: (req: BrowseRequest, opts?: { signal?: AbortSignal }) => Promise<BrowseResult>;
  tsc?: (dir: string, signal?: AbortSignal) => string | Promise<string>;
  describe?: Describe;
  /** Tope de la visión; solo los tests lo bajan. */
  visionMaxMs?: number;
  /** Con generador, el agente tiene `generate_image`; sin él la tool no existe. */
  imageGen?: ImageGen;
  /** Con editor, el agente también tiene `edit_image`. */
  imageEdit?: ImageEdit;
  /** La corrida: al detenerse (Stop, CLI muerto, cierre del transport) la tool en curso se corta y las encoladas no
   * arrancan. Sin esto seguían tsc, chromium, la visión o la imagen ya pagada detrás de un turno muerto (auditoría #5). */
  signal?: AbortSignal;
  /** Id del mensaje en modo plan (M1): con él existe `exit_plan_mode`; sin él, la tool no corre. */
  planMessageId?: string;
  /** Lo que la persona mira en el preview al mandar el mensaje (Q6): `browser` sin viewport mide a ese ancho. */
  viewport?: { width: number; height: number };
}

export const VIEWPORTS = [1440, 375] as const;
const BROWSER_TOOL_DEADLINE = 100_000;
// Captura + visión tienen que responder antes de que el CLI corte la tool MCP (#403: "Connection closed" a los 120,2 s):
// la visión usa lo que la captura dejó de este presupuesto, con piso para no lanzar una llamada que no puede terminar.
const BROWSER_TOOL_BUDGET = 105_000;
const VISION_MAX = 40_000;
const VISION_MIN = 8_000;
const VISION_TRACE_MS = 2_000;
// La latencia de la visión crece con las imágenes (024b517c: 8 tramos en 13,5 s, 13 en 25,2 s): más de 7 van en lotes
// paralelos, cada uno con su rango, y las respuestas se juntan.
export const VISION_BATCH = 7;

/** Pregunta a la visión por lotes de tramos en paralelo; con un solo lote, la respuesta va tal cual. */
export async function describeInBatches(describe: Describe, pngs: readonly Buffer[], question: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (pngs.length <= VISION_BATCH) return describe(pngs, question, timeoutMs, signal);
  // Lotes parejos: con cortes de 7, 15 tramos daban 7+7+1 y 8 daban 7+1, y el lote de 1 respondía sin contexto
  // (d62b35cb). El lote más grande es el que manda en la latencia.
  const n = Math.ceil(pngs.length / VISION_BATCH);
  const size = Math.ceil(pngs.length / n);
  const batches = Array.from({ length: n }, (_, i) => ({ from: i * size, to: Math.min(pngs.length, (i + 1) * size) })).filter((b) => b.from < b.to);
  // d62b35cb: con "si no aparece, responde solo 'no aparece'", el lote 8-14 contestó eso a una pregunta sobre "alguna
  // sección" sin revisar sus tramos. Solo se descarta lo que nombra algo concreto que no está.
  const answers = await Promise.allSettled(batches.map((b) => describe(pngs.slice(b.from, b.to), `Estas imágenes son los tramos ${b.from + 1}-${b.to} de ${pngs.length} de la página. Responde sobre lo que se ve en ellos. Si la pregunta nombra una sección o un elemento que no está en estos tramos, di que no aparece y responde el resto. ${question}`, timeoutMs, signal)));
  // Un lote caído no borra lo que respondieron los otros; si caen todos, es un fallo de la visión.
  if (answers.every((a) => a.status === 'rejected')) throw (answers[0] as PromiseRejectedResult).reason;
  return batches.map((b, i) => {
    const a = answers[i];
    return `[tramos ${b.from + 1}-${b.to}] ${a.status === 'fulfilled' ? a.value : `sin respuesta: ${a.reason instanceof Error ? a.reason.message.split('\n')[0] : String(a.reason)}`}`;
  }).join('\n');
}
const secs = (since: number): string => ((Date.now() - since) / 1000).toFixed(1);
// A 1440 la visión mira a media escala: 720×450 son ~442 tokens por tramo contra ~1716, y alcanza para layout. A 375,
// 0,75 (281 px de ancho, texto todavía legible): con escala 1 y 11 tramos haiku no respondió en 40 s (#403, 9cab1be0).
const VISION_SCALE: Record<number, number> = { 1440: 0.5, 375: 0.75 };
const SECTION_NAME = /^[\w-]{1,60}$/;

export async function withDeadline<T>(ms: number, message: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    onAbort = () => reject(new Error('la corrida se detuvo'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
// Como v0: las primeras 30 líneas de tsc bastan para corregir y no inundan el contexto.
const TSC_LINES = 30;
const MAX_ACTIONS = 10;
const MAX_NAME = 120;
const ROLES = new Set(['button', 'tab', 'link', 'switch', 'checkbox', 'radio', 'combobox', 'menuitem', 'option']);
const SELECTOR = /^[\w\s.#\-[\]="':>()*,]{1,120}$/;

export const WORKSPACE_TOOL_DEFS: ToolDef[] = [
  ASK_TOOL_DEF,
  {
    name: 'typecheck',
    description: 'Corre tsc --noEmit sobre el workspace. Devuelve los errores de tus archivos (los de la página) y aparte cuántos hay en la librería, que no tocas, más la revisión de la identidad (src/identity.css e index.html) , los tokens CSS que usas sin que existan y el lint del DS sobre src/sections (elementos crudos, estilos inline y colores a mano), que cuenta como error. Úsala después de escribir y antes de mirar el preview.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser',
    description: 'Abre el preview vivo de la página en un navegador y devuelve en texto los errores de la página (excepciones, consola, requests fallidos, secciones que no montaron), los del dev server y el desborde horizontal (scrollWidth contra clientWidth, con los elementos que lo causan). No devuelve imágenes: con `question`, un modelo de visión mira la captura de la página entera a ese viewport y responde esa pregunta en texto. Pregunta algo concreto que puedas comprobar (qué se superpone, qué texto no cabe, qué columna queda vacía en tal sección), no "¿se ve bien?". Las acciones prueban controles: click por rol accesible y nombre, o leer el texto de un selector.',
    input_schema: {
      type: 'object',
      properties: {
        viewport: { description: '1440 o 375; sin él, el ancho que la persona tiene en su preview (si lo hay)' },
        full: { type: 'boolean', description: 'página completa; por defecto true. false captura solo el primer viewport' },
        from: { type: 'number', description: 'píxel desde arriba donde empezar a capturar, para ver lo que una captura anterior dejó sin cubrir; por defecto 0' },
        question: { type: 'string', maxLength: MAX_QUESTION, description: 'pregunta concreta para el modelo de visión sobre la captura' },
        section: { type: 'string', description: 'rol o slug de la sección (hero, 03-precios): la captura cubre solo esa sección' },
        width: { description: 'alias de viewport' },
        fullPage: { description: 'alias de full' },
        actions: {
          type: 'array',
          maxItems: MAX_ACTIONS,
          items: {
            type: 'object',
            properties: {
              click: { type: 'object', properties: { role: { type: 'string', enum: [...ROLES] }, name: { type: 'string' } }, required: ['role', 'name'], additionalProperties: false },
              text: { type: 'string', description: 'selector CSS' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
];

export interface TscError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

export function parseTscOutput(out: string): TscError[] {
  return out.split('\n').flatMap((l) => {
    const m = TSC_LINE.exec(l.trim());
    return m ? [{ file: m[1].replace(/\\/g, '/'), line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] }] : [];
  });
}

/** Errores de los archivos de la página frente a los de la librería del scaffold, que el agente no debe tocar. Los hits del
 * lint del DS entran en la cuenta de la primera línea: es la que lee agent-stream para dar el typecheck por bueno. */
export function formatTypecheck(errors: readonly TscError[], pageFiles: ReadonlySet<string>, lintHits = 0): string {
  const own = errors.filter((e) => pageFiles.has(e.file));
  const library = errors.length - own.length;
  const total = own.length + lintHits;
  const head = total ? `${total} errores en tus archivos:` : '0 errores en tus archivos.';
  const lines = own.slice(0, TSC_LINES).map((e) => `${e.file}(${e.line},${e.col}): ${e.code} ${e.message}`);
  const more = own.length > TSC_LINES ? [`… y ${own.length - TSC_LINES} más`] : [];
  const lib = library ? [`${library} errores en la librería del DS (no son tuyos; no los corrijas).`] : [];
  return [head, ...lines, ...more, ...lib].join('\n');
}

// TS 6 marca `baseUrl` del tsconfig del scaffold como deprecado y aborta antes de revisar nada.
// Asíncrono: corre dentro del proceso del transport, y un spawnSync de hasta 120 s congelaba los streams, los
// heartbeats y las aprobaciones de las demás corridas.
export const runTsc = (dir: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<string> => {
  const bin = join(dir, 'node_modules', '.bin', 'tsc');
  if (!existsSync(bin)) return Promise.reject(new Error('el workspace no tiene typescript instalado'));
  // QA §7.1: tras una suspensión del Mac el tsc se cortó a los 48 ms de pared. Pared y monotónico juntos dicen en la
  // próxima ronda si el plazo vence por un reloj que cuenta la suspensión; sin eso, cualquier fix es a ciegas.
  const wall0 = Date.now();
  const mono0 = performance.now();
  const clocks = (): string => `pared ${Date.now() - wall0} ms, monotónico ${Math.round(performance.now() - mono0)} ms`;
  return new Promise((resolve, reject) => {
    const child = track(spawn(bin, ['--noEmit', '-p', 'tsconfig.app.json', '--ignoreDeprecations', '6.0', '--pretty', 'false'], { cwd: dir, timeout: timeoutMs, ...(signal ? { signal } : {}) }));
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.on('error', reject);
    child.on('close', (_code, signal) => {
      console.error(`[tsc] ${signal ?? 'ok'} ${clocks()}`);
      if (signal) reject(new Error(`tsc cortado (${signal}; ${clocks()})`));
      else resolve(out);
    });
  });
};

const readOr = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

// Sin pack el agente declara la marca en identity.css; se revisa con los tipos para que la corrija en el mismo turno.
function identityReport(dir: string, page: ReadonlySet<string>): string {
  const css = readOr(join(dir, 'src', 'identity.css'));
  const design = join(dir, DESIGN_FILE);
  return formatIdentityCheck(checkIdentity(css, readOr(join(dir, 'index.html')), page.has('src/identity.css'), existsSync(design) ? readFileSync(design, 'utf8') : null, existsSync(join(dir, IDENTITY_EDIT_FILE))));
}

// C4: como Lovable (ZAP 1854: `tail build-errors.log` + `curl`), el dev server compila cada archivo de la página al pedirlo;
// un error de transformación ahí es el que daría `vite build`, sin compilar el proyecto entero.
const DEV_FILE = /^src\/.+\.(tsx?|css)$/;
const DEV_FETCH_MS = 15_000;

async function devServerErrors(ctx: WorkspaceToolContext, page: ReadonlySet<string>): Promise<string[] | null> {
  const files = [...page].filter((f) => DEV_FILE.test(f));
  if (!files.length) return [];
  const { url } = await ctx.previews.ensure(ctx.dir);
  if (!url) return null;
  // Lo que vite registró mientras el agente escribía son cargas de archivos a medias, no el estado actual.
  ctx.previews.drainErrors?.(ctx.dir);
  const failed = await Promise.all(files.map(async (f) => {
    const res = await fetch(new URL(f, url), { signal: AbortSignal.timeout(DEV_FETCH_MS) });
    return res.ok ? null : `${f}: ${(await res.text()).split('\n').find((l) => l.trim()) ?? `HTTP ${res.status}`}`;
  }));
  return [...failed.filter((f): f is string => f !== null), ...(ctx.previews.drainErrors?.(ctx.dir) ?? [])];
}

async function devServerReport(ctx: WorkspaceToolContext, page: ReadonlySet<string>): Promise<{ count: number; text: string }> {
  try {
    const errors = await devServerErrors(ctx, page);
    if (errors === null) return { count: 0, text: '' };
    return errors.length ? { count: errors.length, text: `Dev server: ${errors.length} errores de compilación:\n${errors.map((e) => `- ${e}`).join('\n')}` } : { count: 0, text: 'Dev server: tus archivos compilan.' };
  } catch (e) {
    // Sin preview no hay a quién preguntar: no cuenta como error del agente; el build del commit sigue de red.
    return { count: 0, text: `Dev server: no respondió (${e instanceof Error ? e.message : String(e)}); no se compilaron tus archivos.` };
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseBrowseInput(input: unknown, person?: { width: number; height: number }): Parsed<Omit<BrowseRequest, 'url'> & { question?: string }> {
  const o = (input ?? {}) as Record<string, unknown>;
  // Las tools MCP le llegan al agente diferidas y la primera llamada sale antes del esquema, con los nombres de
  // Playwright (width, fullPage) y valores en string: se aceptan en vez de gastar un fallo del turno.
  const viewport = Number(o.viewport ?? o.width ?? person?.width);
  const own = person !== undefined && viewport === person.width && viewport !== 1440 && viewport !== 375;
  if (viewport !== 1440 && viewport !== 375 && !own) return { ok: false, error: `viewport debe ser 1440 o 375${person ? ` o ${person.width}, el de la persona` : ''}` };
  const fullRaw = o.full ?? o.fullPage;
  const full = fullRaw === 'true' ? true : fullRaw === 'false' ? false : fullRaw;
  if (full !== undefined && typeof full !== 'boolean') return { ok: false, error: 'full debe ser boolean' };
  const from = o.from === undefined ? undefined : Number(o.from);
  if (from !== undefined && !(Number.isFinite(from) && from >= 0)) return { ok: false, error: 'from debe ser un número de píxeles >= 0' };
  const question = typeof o.question === 'string' ? o.question.trim() : undefined;
  if (o.question !== undefined && (question === undefined || !question || question.length > MAX_QUESTION)) return { ok: false, error: `question debe ser un texto de 1 a ${MAX_QUESTION} caracteres` };
  const section = o.section === undefined ? undefined : String(o.section);
  if (section !== undefined && !SECTION_NAME.test(section)) return { ok: false, error: 'section debe ser el rol o el slug de una sección (hero, 03-precios)' };
  const raw = o.actions ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_ACTIONS) return { ok: false, error: `actions debe ser una lista de hasta ${MAX_ACTIONS}` };
  const actions: BrowseAction[] = [];
  for (const a of raw as Record<string, unknown>[]) {
    const click = a?.click as Record<string, unknown> | undefined;
    if (click && typeof click.role === 'string' && ROLES.has(click.role) && typeof click.name === 'string' && click.name.length <= MAX_NAME) actions.push({ click: { role: click.role, name: click.name } });
    else if (typeof a?.text === 'string' && SELECTOR.test(a.text)) actions.push({ text: a.text });
    else return { ok: false, error: `acción inválida: ${JSON.stringify(a).slice(0, 200)}` };
  }
  return { ok: true, value: { viewport, ...(own ? { height: person.height } : {}), full: (full as boolean | undefined) ?? true, ...(from ? { from } : {}), actions, ...(question ? { question } : {}), ...(section ? { section } : {}) } };
}

/** Lo que el registry materializó en el workspace (ADR 0011: el DS completo del pin, después del commit base), según las
 * marcas `.wt/ds@<pin>` que deja el transport. No es de la página aunque git lo vea como nuevo. */
export function libraryFiles(dir: string): Set<string> {
  const wt = join(dir, '.wt');
  if (!existsSync(wt)) return new Set();
  const marks = readdirSync(wt).filter((f) => f.startsWith('ds@'));
  return new Set(marks.flatMap((m) => readFileSync(join(wt, m), 'utf8').split('\n').map((l) => l.trim().replace(/\\/g, '/')).filter((l) => l.includes('/'))));
}

const sectionsOf = (dir: string): string[] => {
  const d = join(dir, 'src', 'sections');
  return existsSync(d) ? readdirSync(d).filter((f) => /^\d+-.+\.tsx$/.test(f)).map((f) => f.replace(/\.tsx$/, '')).sort() : [];
};

export function formatOverflow(o: Overflow): string {
  if (o.scrollWidth <= o.clientWidth) return `Sin desborde horizontal (scrollWidth ${o.scrollWidth} = clientWidth ${o.clientWidth}).`;
  return [`Desborde horizontal: scrollWidth ${o.scrollWidth} > clientWidth ${o.clientWidth}.`, ...o.offenders.map((e) => `- ${e}`)].join('\n');
}

export interface ShotExtent { segments: number; pageHeight: number; shownHeight: number; from?: number; section?: string }

/** Cuántos tramos van adjuntos y qué parte de la página cubren: el agente tiene que saber si hay página sin ver y cómo
 * pedir el resto (`from`), porque el tope de tramos no sube. */
export function formatExtent(viewport: number, e: ShotExtent): string {
  const from = e.from ?? 0;
  // Una sección termina antes que la página: no es una captura incompleta ni hay que pedir `from` (024b517c).
  if (e.section) return `Captura a ${viewport} px de la sección ${e.section}: ${e.segments} tramo${e.segments > 1 ? 's' : ''}, ${from}–${e.shownHeight} px de ${e.pageHeight}.`;
  const head = e.segments > 1 ? `Captura a ${viewport} px${from ? ` desde ${from} px` : ''}: ${e.segments} tramos de arriba abajo, en orden.` : `Captura a ${viewport} px${from ? ` desde ${from} px` : ' (primer viewport)'}.`;
  if (e.shownHeight >= e.pageHeight) return `${head} ${from ? `Cubren ${from}–${e.pageHeight} px: hasta el final de la página (${e.pageHeight} px).` : `Página completa (${e.pageHeight} px).`}`;
  return `${head} Cubren ${from ? `${from}–` : ''}${e.shownHeight} px de ${e.pageHeight}: lo de más abajo no está capturado. Para verlo, llama otra vez con {"viewport": ${viewport}, "full": true, "from": ${e.shownHeight}}.`;
}

/** La captura llegó al final de la página, según el texto de formatExtent. Va junto a él para que no se desacoplen. */
export const reachesPageEnd = (text: string): boolean => /Página completa \(\d+ px\)|hasta el final de la página/.test(text);

export function formatBrowse(viewport: number, defects: readonly RuntimeDefect[], server: readonly string[], texts: readonly string[], actionErrors: readonly string[], overflow: Overflow, extent?: ShotExtent): string {
  const lines = [extent ? formatExtent(viewport, extent) : `Captura a ${viewport} px.`, formatOverflow(overflow), defects.length ? `${defects.length} errores de la página:` : '0 errores de la página.'];
  lines.push(...defects.map((d) => `- ${d.kind}${d.slug ? ` ${d.slug}` : ''}: ${d.message.split('\n')[0]}`));
  if (server.length) lines.push(`${server.length} errores del dev server:`, ...server.map((s) => `- ${s}`));
  lines.push(...actionErrors.map((e) => `- acción: ${e}`), ...texts.map((t) => `texto: ${t}`));
  return lines.join('\n');
}

export async function runWorkspaceTool(name: string, input: unknown, ctx: WorkspaceToolContext): Promise<WorkspaceToolResult> {
  // Una tool que esperaba en la cola de la corrida no arranca si la corrida ya terminó.
  if (ctx.signal?.aborted) return { ok: false, error: `${name}: la corrida se detuvo` };
  try {
    switch (name) {
      case ASK_TOOL: {
        const q = parseQuestion(input);
        if (!q.ok) return q;
        return { ok: true, content: [{ type: 'text', text: 'Pregunta enviada: la persona ve las opciones como botones. No escribas archivos; termina el turno repitiendo la pregunta en una línea.' }] };
      }
      case EXIT_PLAN_TOOL: {
        if (!ctx.planMessageId) return { ok: false, error: `${EXIT_PLAN_TOOL}: solo existe en modo plan` };
        const plan = parsePlanExit(input);
        if (!plan.ok) return plan;
        const valid = validatePlanFile(plan.value, { dir: ctx.dir, messageId: ctx.planMessageId });
        if (!valid.ok) return valid;
        return { ok: true, content: [{ type: 'text', text: 'Plan enviado: la persona lo aprueba, lo edita o lo rechaza. Termina el turno sin escribir nada más.' }] };
      }
      case 'typecheck': {
        const errors = parseTscOutput(await (ctx.tsc ? ctx.tsc(ctx.dir, ctx.signal) : runTsc(ctx.dir, undefined, ctx.signal)));
        const library = libraryFiles(ctx.dir);
        const page = new Set(filesSinceBase(ctx.dir).filter((f) => !library.has(f)));
        const lint = dsLintWorkspace(ctx.dir);
        const dev = await devServerReport(ctx, page);
        const report = [formatTypecheck(errors, page, lint.length + dev.count), formatLint(lint), ...(dev.text ? [dev.text] : []), identityReport(ctx.dir, page), undefinedTokenReport(ctx.dir)];
        return { ok: true, content: [{ type: 'text', text: report.join('\n') }] };
      }
      case 'browser': {
        const req = parseBrowseInput(input, ctx.viewport);
        if (!req.ok) return req;
        // Tope de la tool entera (preview + chromium), por debajo del watchdog del loop (120 s): si algo cuelga fuera del
        // tope interno de browse, el agente recibe un error y vuelve a llamar en vez de perder el servidor wt
        // (gen 3fc160a7: "Connection closed" a los 120 s y browser:1440 sin verificar).
        const { question, ...browseReq } = req.value;
        const started = Date.now();
        const scale = question ? VISION_SCALE[browseReq.viewport] : undefined;
        const shot = await withDeadline(BROWSER_TOOL_DEADLINE, 'browser: sin respuesta en 100 s; vuelve a llamar', async () => {
          const { url } = await ctx.previews.ensure(ctx.dir);
          const browse = ctx.browse ?? (await import('./browser')).browse;
          return browse({ url, ...browseReq, ...(scale ? { scale } : {}) }, ctx.signal ? { signal: ctx.signal } : {});
        }, ctx.signal);
        const mounted = new Map([[req.value.viewport, shot.mounted]]);
        const defects = runtimeDefects(shot.issues, sectionsOf(ctx.dir), mounted);
        const server = ctx.previews.drainErrors?.(ctx.dir) ?? [];
        const found = req.value.section && !shot.actionErrors.some((e) => e.startsWith(`sección "${req.value.section}"`));
        const text = formatBrowse(req.value.viewport, defects, server, shot.texts, shot.actionErrors, shot.overflow, { segments: shot.pngs.length, pageHeight: shot.pageHeight, shownHeight: shot.shownHeight, from: shot.from, ...(found ? { section: req.value.section } : {}) });
        if (!question) return { ok: true, content: [{ type: 'text', text }] };
        // Un fallo del modelo de visión no tira la medición: el agente recibe errores y desborde y sabe que no hubo respuesta.
        const left = Math.min(ctx.visionMaxMs ?? VISION_MAX, BROWSER_TOOL_BUDGET - (Date.now() - started));
        const visionStart = Date.now();
        const shotSecs = secs(started);
        const answer = left < Math.min(VISION_MIN, ctx.visionMaxMs ?? VISION_MIN)
          ? `Sin respuesta visual: la captura se llevó el tiempo de la tool (${Math.round((Date.now() - started) / 1000)} s).`
          // El proceso del CLI vence en `left` y trae su traza; este tope de respaldo llega después, para no taparla.
          : await withDeadline(left + VISION_TRACE_MS, `sin respuesta en ${Math.round(left / 1000)} s`, async () => describeInBatches(ctx.describe ?? (await import('./vision')).createDescribe(), shot.pngs, question, left, ctx.signal), ctx.signal)
            .then((a) => `Respuesta visual (${secs(visionStart)} s): ${a}`, (e) => `Sin respuesta visual (${secs(visionStart)} s): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
        // El tiempo de la visión aparte del de la captura: la tool entera mezclaba los dos en las mediciones de #403.
        console.error(`[vision] ${req.value.viewport}px ${shot.pngs.length} tramos, captura ${shotSecs} s: ${answer.slice(0, 300)}`);
        return { ok: true, content: [{ type: 'text', text: `${text}\n${answer}` }] };
      }
      case IMAGE_TOOL: {
        if (!ctx.imageGen) return { ok: false, error: 'generate_image: este turno no tiene paso de imagen' };
        const r = await runImageTool(ctx.dir, input, ctx.imageGen, ctx.signal);
        return r.ok ? { ok: true, content: [{ type: 'text', text: r.text }] } : r;
      }
      case EDIT_IMAGE_TOOL: {
        if (!ctx.imageEdit) return { ok: false, error: 'edit_image: este turno no tiene editor de imagen' };
        const r = await runEditImageTool(ctx.dir, input, ctx.imageEdit, ctx.signal);
        return r.ok ? { ok: true, content: [{ type: 'text', text: r.text }] } : r;
      }
      default:
        return { ok: false, error: `tool desconocida: ${name}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
