// Traduce el stream-json de `claude -p` (ADR 0011: el agente escribe la página con herramientas) a los eventos
// del transport, para que el builder vea el turno como hoy: un step por tool_use (read/write/bash/search/tool), el
// texto del modelo como text.delta y el result como cierre. Puro: recibe líneas, emite al log y acumula lo que el loop
// necesita decidir (qué escribió, qué verificó y cuándo). Lo único que toca disco son las capturas de la tool browser.

import { SHOT_FILE } from './event-model';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { EditPair, EventLog, StepDetail, StepKind } from './events';
import { AGENT_DIR } from '../skill-registry';
import { ASK_TOOL_FULL, parseQuestion, type AgentQuestion } from './ask-user';
import { EXIT_PLAN_TOOL_FULL, type PlanExit } from './plan-exit';

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  /** Contexto de la primera llamada al modelo (input + caché creada + caché leída): el piso del prompt y del entorno. */
  firstCallTokens?: number;
  /** Contexto de la última llamada: lo que el turno llegó a ocupar. */
  lastCallTokens?: number;
  /** Ventana del modelo que reporta el CLI (modelUsage.contextWindow). */
  contextWindow?: number;
  cacheReadTokens?: number;
  /** Líneas que devolvieron las lecturas (Read) del turno, como el linesRead de v0. */
  linesRead?: number;
}

/** Cada result del CLI trae solo los tokens de su tramo (una reanudación, un mensaje en vuelo): el turno los suma.
 * El piso es el de la primera llamada del turno entero; la última llamada y la ventana son las del tramo más reciente. */
export function addTokens(prev: AgentUsage, next: AgentUsage): AgentUsage {
  const sum = (a?: number, b?: number): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const inputTokens = sum(prev.inputTokens, next.inputTokens), outputTokens = sum(prev.outputTokens, next.outputTokens);
  const cacheReadTokens = sum(prev.cacheReadTokens, next.cacheReadTokens), linesRead = sum(prev.linesRead, next.linesRead);
  const firstCallTokens = prev.firstCallTokens ?? next.firstCallTokens, lastCallTokens = next.lastCallTokens ?? prev.lastCallTokens;
  const contextWindow = next.contextWindow ?? prev.contextWindow;
  const opt = (k: keyof AgentUsage, v: number | undefined): Partial<AgentUsage> => (v === undefined ? {} : { [k]: v });
  return {
    ...next, ...opt('inputTokens', inputTokens), ...opt('outputTokens', outputTokens), ...opt('cacheReadTokens', cacheReadTokens),
    ...opt('linesRead', linesRead), ...opt('firstCallTokens', firstCallTokens), ...opt('lastCallTokens', lastCallTokens), ...opt('contextWindow', contextWindow),
  };
}

/** La medida de contexto del turno para la traza (planes/orq.md O2-B): Make la calcula en el server y la manda como
 * `usageInfo.contextUsageRatio` (make-chat/deob/3277:32541) y v0 guarda `workMetrics.linesRead` por mensaje
 * (deob/v0-design-mode:56042); ninguno la pinta (3277:40269 la descarta), así que aquí solo se registra. */
export interface ContextTrace {
  /** Última llamada sobre la ventana, 3 decimales: comparable entre modelos y pins. */
  ratio: number;
  floorTokens: number;
  lastTokens: number;
  window: number;
  cacheReadTokens?: number;
  linesRead?: number;
}

export function contextTrace(u: AgentUsage): ContextTrace | undefined {
  if (u.firstCallTokens === undefined || u.lastCallTokens === undefined || !u.contextWindow) return undefined;
  return {
    ratio: Math.round((u.lastCallTokens / u.contextWindow) * 1000) / 1000, floorTokens: u.firstCallTokens, lastTokens: u.lastCallTokens, window: u.contextWindow,
    ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}), ...(u.linesRead !== undefined ? { linesRead: u.linesRead } : {}),
  };
}

/** Lo que el loop necesita del turno: sesión para reanudar, resumen final y pruebas de verificación. */
export interface AgentTurn {
  sessionId?: string;
  summary: string;
  usage: AgentUsage;
  isError: boolean;
  /** Rutas relativas al workspace que el agente escribió o editó, en orden. */
  writes: string[];
  /** Secuencia (índice de tool_use) de la última escritura. */
  lastWriteAt: number;
  /** Verificaciones que pasaron, con la secuencia en que ocurrieron. */
  checks: { name: 'typecheck' | 'build' | 'browser:1440' | 'browser:375'; at: number; ok: boolean }[];
  /** Llamadas a Bash que el CLI denegó por permisos (no errores del comando): cada una es un paso perdido. */
  denials: number;
  /** El CLI murió por una señal ajena (SIGHUP, kill) sin dar su result: lo escrito queda en el workspace. */
  interrupted?: boolean;
  /** La pregunta que hizo con la tool ask_user, con sus opciones: el turno no editó y espera la respuesta. */
  question?: AgentQuestion;
  /** El plan entregado con exit_plan_mode (modo plan, M1): el turno no creó versión y espera la decisión de la persona. */
  planExit?: PlanExit;
}

// Textos con que el CLI de Claude Code rechaza un Bash antes de ejecutarlo (vistos en live6 y la demo cc7b8016).
const DENIAL_RE = /requires? approval|Brace expansion|can't be checked before it runs|was blocked\. For security|expansion obfuscation|permission (?:denied|was denied)|not (?:in the )?allowed/i;
/** Un tool_result de Bash con error es denegación cuando el texto es del permisero del CLI y no del comando. */
export const isDenial = (name: string, text: string, isError: boolean): boolean => isError && name === 'Bash' && DENIAL_RE.test(text);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface OpenStep { name: string; input: Obj; seq: number }

/** Etiqueta de lo que se escribe, como la pone el modelo de v0 por paso ("Writing hero"): el rol de la sección en vez
 * de la ruta cuando el archivo es una sección del contrato; el resto, su ruta relativa. */
export function writeTarget(rel: string): string {
  const m = /^src\/sections\/\d+-([a-z0-9-]+)\.(tsx|module\.css|css)$/.exec(rel);
  if (!m) return rel;
  return m[2] === 'tsx' ? (m[1] as string) : `estilos de ${m[1]}`;
}

/** Nombre corto de la herramienta para el contrato de fase (S4 §6): el del CLI tal cual, el de una tool MCP sin el
 * prefijo del servidor. v0 pinta pendiente/hecho por parte con ese nombre (V0:13738-13750). */
const toolOf = (name: string): string => (name === ASK_TOOL_FULL ? 'ask_user' : name.replace(/^mcp__wt__/, ''));

/** Clasificación de cada herramienta del CLI o del MCP `wt` como step del builder. El label lleva el archivo o la
 * sección mientras corre ("Editando hero"), como "Editing X…" de v0 (V0:27594-27596, :901-917). */
function stepOf(name: string, input: Obj, dir: string): { kind: StepKind; label: string; tool: string } {
  const rel = (p: unknown): string => (typeof p === 'string' ? wsRelative(dir, p) : '?');
  const tool = toolOf(name);
  switch (name) {
    case 'Read': return { kind: 'read', label: `Leyendo ${rel(input.file_path)}`, tool };
    case 'Write': return { kind: 'write', label: `Escribiendo ${writeTarget(rel(input.file_path))}`, tool };
    case 'Edit': return { kind: 'write', label: `Editando ${writeTarget(rel(input.file_path))}`, tool };
    case 'Glob': return { kind: 'search', label: `Buscando ${str(input.pattern)}`, tool };
    case 'Grep': return { kind: 'search', label: `Buscando "${str(input.pattern)}"`, tool };
    case 'Bash': return { kind: 'bash', label: labelOfCommand(str(input.command)), tool };
    case ASK_TOOL_FULL: return { kind: 'action', label: 'Preguntando', tool };
    case EXIT_PLAN_TOOL_FULL: return { kind: 'action', label: 'Enviando el plan', tool };
    case 'mcp__wt__typecheck': return { kind: 'tool', label: 'Revisando tipos', tool };
    case 'mcp__wt__browser': return { kind: 'tool', label: `Mirando la página a ${String(input.viewport ?? 1440)} px`, tool };
    // Tools de imagen de S5: gastan créditos y pasan por aprobación 'spend' (Stitch: MediaGenerationApprovalCard :153).
    case 'mcp__wt__generate_image': return { kind: 'tool', label: 'Generando imagen', tool };
    case 'mcp__wt__edit_image': return { kind: 'tool', label: 'Editando imagen', tool };
    default: return { kind: 'tool', label: name, tool };
  }
}

/** El label del paso cerrado: el mismo verbo en pasado. Las de imagen van antes que "Editando", que las pisaría. */
function doneLabel(label: string): string {
  return label
    .replace(/^Generando imagen/, 'Imagen generada').replace(/^Editando imagen/, 'Imagen editada')
    .replace(/^Enviando el plan/, 'Plan enviado').replace(/^Leyendo/, 'Leído').replace(/^Escribiendo/, 'Escrito').replace(/^Editando/, 'Editado').replace(/^Buscando/, 'Buscó')
    .replace(/^Revisando tipos/, 'Tipos revisados').replace(/^Compilando/, 'Compilado').replace(/^Mirando/, 'Vio').replace(/^Ejecutando/, 'Ejecutó');
}

function labelOfCommand(cmd: string): string {
  if (/tsc\b/.test(cmd)) return 'Revisando tipos';
  if (/vite build/.test(cmd)) return 'Compilando';
  return `Ejecutando ${cmd.split(/\s+/).slice(0, 3).join(' ')}`;
}

/** Tope por lado de cada par antes/después, el mismo que la salida de una tool: el diff completo está en GET /diff. */
export const EDIT_PAIR_MAX = 4000;

/** Los pares old/new de un Edit (old_string/new_string, replace_all), de un MultiEdit (edits[]) o el contenido de un
 * Write, recortados a EDIT_PAIR_MAX por lado. Make los pinta en vivo (MAKE-CHAT:40042-40063, :40136-40141); nosotros al
 * cerrar el paso. */
export function editsOf(name: string, input: Obj): { edits: EditPair[]; truncated?: true } | undefined {
  const raw: Obj[] = name === 'Write' ? [{ new_string: input.content }]
    : name === 'Edit' ? [input]
    : name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.filter(isObj)
    : [];
  let truncated = false;
  const cut = (s: string): string => { if (s.length <= EDIT_PAIR_MAX) return s; truncated = true; return s.slice(0, EDIT_PAIR_MAX); };
  const edits = raw.flatMap((e): EditPair[] => {
    if (typeof e.new_string !== 'string') return [];
    const before = typeof e.old_string === 'string' ? { before: cut(e.old_string) } : {};
    return [{ ...before, after: cut(e.new_string), ...(e.replace_all === true ? { replaceAll: true as const } : {}) }];
  });
  if (!edits.length) return undefined;
  return truncated ? { edits, truncated: true } : { edits };
}

/** El destino de un `mv a b`: la única edición por Bash que el allowlist deja pasar (agent-loop.ts CLI_TOOLS: mv y
 * mkdir). Figma Make cuenta bash como edición solo con treatBashAsEditing (FIGMA-APP:444176-444230). */
export function mvTarget(cmd: string): string | undefined {
  const words = cmd.trim().split(/\s+/).filter((w) => !w.startsWith('-')).map((w) => w.replace(/^["']|["']$/g, ''));
  return words[0] === 'mv' && words.length >= 3 ? words[words.length - 1] : undefined;
}

function detailOf(step: OpenStep, output: string, isError: boolean, dir: string): StepDetail {
  const rel = (p: unknown): string => (typeof p === 'string' ? wsRelative(dir, p) : '?');
  const { name, input } = step;
  switch (name) {
    case 'Read': return { kind: 'read', paths: [rel(input.file_path)] };
    case 'Write': return { kind: 'write', path: rel(input.file_path), op: 'create', ...editsOf(name, input) };
    case 'Edit': case 'MultiEdit': return { kind: 'write', path: rel(input.file_path), op: 'update', ...editsOf(name, input) };
    case 'Glob': case 'Grep': return { kind: 'search', scope: 'repo', query: str(input.pattern) };
    case 'Bash': return { kind: 'bash', command: str(input.command), exitCode: isError ? 1 : 0 };
    default: return { kind: 'tool', name: name.replace(/^mcp__wt__/, ''), input, output: output.slice(0, 4000) };
  }
}

// El CLI anota cada imagen de un tool_result con la ruta de su cache local; no es del agente y no sale del Mac (fac2bce5).
const CLI_IMAGE_SOURCE = /^\[Image: source: [^\]\n]*\]$/gm;

/** Texto de un tool_result: string o lista de bloques (text/image). La imagen no se copia al log: sus PNG se devuelven
 * aparte para escribirlos a disco. */
function resultText(content: unknown): { text: string; hasImage: boolean; pngs: string[] } {
  if (typeof content === 'string') return { text: content, hasImage: false, pngs: [] };
  if (!Array.isArray(content)) return { text: '', hasImage: false, pngs: [] };
  let hasImage = false;
  const parts: string[] = [];
  const pngs: string[] = [];
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === 'text') parts.push(str(c.text).replace(CLI_IMAGE_SOURCE, '').trim());
    if (c.type === 'image') {
      hasImage = true;
      const src = isObj(c.source) ? c.source : {};
      if (src.type === 'base64' && src.media_type === 'image/png' && typeof src.data === 'string') pngs.push(src.data);
    }
  }
  return { text: parts.filter(Boolean).join('\n'), hasImage, pngs };
}

/** Capturas de la tool browser, para que el builder muestre lo que vio el agente (GET /runs/:id/shots/:file). */
export const SHOTS_DIR = `${AGENT_DIR}/shots`;
/** El nombre lo arma el stream con el tool_use_id del CLI; el transport solo sirve lo que cumpla esto. */
// Uno solo para el escritor, el endpoint y parseEvent: el nombre llega a una URL y a una ruta del workspace.
export { SHOT_FILE };

function writeShots(dir: string, toolUseId: string, pngs: readonly string[]): string[] {
  const files = pngs.map((_, i) => `${toolUseId}-${i}.png`);
  if (!files.length || !files.every((f) => SHOT_FILE.test(f))) return [];
  try {
    const shotsDir = join(dir, SHOTS_DIR);
    mkdirSync(shotsDir, { recursive: true });
    // Si .wt/shots o un archivo ya existente fuera un symlink, escribir seguiría el enlace fuera del workspace.
    if (realpathSync(shotsDir) !== join(realpathSync(dir), SHOTS_DIR)) return [];
    pngs.forEach((b64, i) => {
      const path = join(shotsDir, files[i]);
      rmSync(path, { force: true });
      writeFileSync(path, Buffer.from(b64, 'base64'), { flag: 'wx' });
    });
    return files;
  } catch {
    // Sin capturas el paso sigue valiendo: la verificación es el texto, la imagen es para mirarla.
    return [];
  }
}

/** Ruta relativa a la raíz del workspace. Una ruta relativa del agente se resuelve contra el workspace, no contra el cwd
 * del server: gen3 mostró "Editado ../../../../wt-fix/src/sections/01-navbar.tsx" y agent.files salía igual de mal. */
const wsRelative = (dir: string, p: string): string => relative(dir, resolve(dir, p)) || p;

const TSC_RE = /tsc\b[^|&;]*--noEmit/;
const BUILD_RE = /vite build/;

/** Qué verificación prueba un tool_use terminado, si alguna. El típico `tsc … | head` reporta exit 0 aunque haya
 * errores, así que el texto manda: con "error TS" no pasó. */
function checksOf(step: OpenStep, text: string, isError: boolean): AgentTurn['checks'] {
  const bad = isError || /error TS\d+/.test(text);
  // La tool resume en la primera línea: "30 errores en tus archivos:" o "0 errores".
  if (step.name === 'mcp__wt__typecheck') {
    const count = /(\d+)\s+errores?\b/i.exec(text.split('\n')[0] ?? '');
    return [{ name: 'typecheck', at: step.seq, ok: !bad && !(count && Number(count[1]) > 0) }];
  }
  // Una captura que respondió; ya no gatea el turno (agent-composer: lo obligatorio con preview es typecheck).
  if (step.name === 'mcp__wt__browser') {
    const vp = Number(step.input.viewport ?? 1440);
    return [{ name: vp === 375 ? 'browser:375' : 'browser:1440', at: step.seq, ok: !isError }];
  }
  if (step.name === 'Bash') {
    const cmd = str(step.input.command);
    const checks: AgentTurn['checks'] = [];
    if (TSC_RE.test(cmd)) checks.push({ name: 'typecheck', at: step.seq, ok: !bad });
    if (BUILD_RE.test(cmd)) checks.push({ name: 'build', at: step.seq, ok: !isError && !/\berror\b/i.test(text) });
    return checks;
  }
  return [];
}

export interface StreamTranslator {
  /** Una línea del stdout del CLI. Las que no son JSON se ignoran. */
  feed(line: string): void;
  /** Estado acumulado del turno (se puede leer en cualquier momento). */
  turn(): AgentTurn;
}

/** Crea el traductor para un workspace: las rutas de los steps salen relativas a `dir`. Con `parentStepId`, cada paso
 * del turno cuelga del paso que lo abrió (agent:write): sin él el cliente los pinta planos y el padre, ya cerrado,
 * aparece como "Página escrita" antes de los pasos que lo componen. */
export function createStreamTranslator(log: EventLog | undefined, dir: string, parentStepId?: string): StreamTranslator {
  const parent = parentStepId ? { parentStepId } : {};
  const open = new Map<string, OpenStep>();
  const turn: AgentTurn = { summary: '', usage: {}, isError: false, writes: [], lastWriteAt: -1, checks: [], denials: 0 };
  let seq = 0;
  // Cada bloque de texto del CLI es un párrafo completo (sin partial messages); el cliente concatena los deltas, y
  // en 999ea0e0 el progreso y el resumen salieron pegados ("…las secciones.La landing…").
  let textBlocks = 0;
  // El texto que precede a una tool es progreso ("Escribo el plan…"), no parte de la respuesta: sale como paso y el
  // mensaje queda solo con lo que el agente dice al final (fac2bce5: el resumen empezaba con el progreso).
  let pending = '';
  const flushText = (): void => {
    if (!pending) return;
    log?.emit({ type: 'text.delta', text: `${textBlocks++ ? '\n\n' : ''}${pending}` });
    pending = '';
  };
  const noteProgress = (): void => {
    if (!pending) return;
    const id = `agent:note-${seq}`;
    const label = pending.length > 200 ? `${pending.slice(0, 199)}…` : pending;
    log?.emit({ type: 'step.start', stepId: id, kind: 'thinking', label, ...parent });
    log?.emit({ type: 'step.end', stepId: id, label, status: 'ok' });
    pending = '';
  };
  // Lo que la llamada llevó al modelo, como lo mide ctx-per-turn.py: input + caché creada + caché leída. Un mensaje
  // del CLI sin usage (p. ej. el eco de un tool_result) no cuenta como llamada.
  const noteCall = (usage: unknown): void => {
    if (!isObj(usage)) return;
    const n = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
    const ctx = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
    if (!ctx) return;
    turn.usage = { ...turn.usage, ...(turn.usage.firstCallTokens === undefined ? { firstCallTokens: ctx } : {}), lastCallTokens: ctx };
  };
  const onToolUse = (c: Obj): void => {
    noteProgress();
    const id = str(c.id);
    const name = str(c.name);
    const input = isObj(c.input) ? c.input : {};
    const step: OpenStep = { name, input, seq: seq++ };
    open.set(id, step);
    const { kind, label, tool } = stepOf(name, input, dir);
    log?.emit({ type: 'step.start', stepId: id, kind, label, tool, ...parent });
  };
  const onToolResult = (c: Obj): void => {
    const id = str(c.tool_use_id);
    const step = open.get(id);
    if (!step) return;
    open.delete(id);
    const isError = c.is_error === true;
    const { text, hasImage, pngs } = resultText(c.content);
    if (!isError && step.name === 'Read' && text) turn.usage = addTokens(turn.usage, { linesRead: text.split('\n').length });
    // Un mv también mueve lastWriteAt: el archivo cambió de lugar y la verificación anterior ya no vale.
    const written = (step.name === 'Write' || step.name === 'Edit' || step.name === 'MultiEdit') && typeof step.input.file_path === 'string' ? step.input.file_path
      : step.name === 'Bash' ? mvTarget(str(step.input.command)) : undefined;
    if (!isError && written) {
      const rel = wsRelative(dir, written);
      if (!turn.writes.includes(rel)) turn.writes.push(rel);
      turn.lastWriteAt = step.seq;
    }
    turn.checks.push(...checksOf(step, text, isError));
    const denied = isDenial(step.name, text, isError);
    if (denied) turn.denials++;
    const asked = step.name === ASK_TOOL_FULL && !isError ? parseQuestion(step.input) : undefined;
    if (asked?.ok) turn.question = asked.value;
    // El input ya lo validó la tool (plan-exit.ts); un error de la tool no deja plan. El callId lo genera el transport y
    // viaja en el resultado de la tool.
    const callId = /callId[:=]\s*([\w-]+)/.exec(text)?.[1];
    const planned = step.name === EXIT_PLAN_TOOL_FULL && !isError ? { ...(callId ? { callId } : {}), planPath: str(step.input.planPath), summary: str(step.input.summary) } : undefined;
    if (planned?.planPath) turn.planExit = planned;
    const base: StepDetail = planned?.planPath ? { kind: 'action', name: 'plan', summary: planned.summary } : asked?.ok ? { kind: 'action', name: 'question', summary: asked.value.question, followUps: asked.value.options } : detailOf(step, hasImage ? `${text}\n[captura adjunta]` : text, isError, dir);
    const shots = step.name === 'mcp__wt__browser' && base.kind === 'tool' ? writeShots(dir, id, pngs) : [];
    const detail: StepDetail = shots.length && base.kind === 'tool' ? { ...base, shots } : base;
    const { label } = stepOf(step.name, step.input, dir);
    log?.emit({ type: 'step.end', stepId: id, label: denied ? `${label}: denegado por el CLI` : isError ? `${label}: falló` : doneLabel(label), status: isError ? 'error' : 'ok', detail, ...(isError ? { error: { type: denied ? 'tool-denied' : 'tool', message: text.slice(0, 500) } } : {}) });
  };
  return {
    feed(line) {
      let e: unknown;
      try { e = JSON.parse(line); } catch { return; }
      if (!isObj(e)) return;
      if (e.type === 'system' && e.subtype === 'init' && typeof e.session_id === 'string') turn.sessionId = e.session_id;
      if (e.type === 'assistant' && isObj(e.message) && Array.isArray(e.message.content)) {
        noteCall(e.message.usage);
        for (const c of e.message.content) {
          if (!isObj(c)) continue;
          if (c.type === 'tool_use') onToolUse(c);
          else if (c.type === 'text' && str(c.text).trim()) {
            flushText();
            pending = str(c.text);
          }
        }
      }
      if (e.type === 'user' && isObj(e.message) && Array.isArray(e.message.content)) {
        for (const c of e.message.content) if (isObj(c) && c.type === 'tool_result') onToolResult(c);
      }
      if (e.type === 'result') {
        flushText();
        turn.summary = str(e.result);
        turn.isError = e.is_error === true || e.subtype === 'error';
        // v0 cierra cada mensaje con la tool Done ("Summarizing" → "Summarized"): el resumen es un paso visible.
        if (turn.summary.trim() && !turn.isError) {
          log?.emit({ type: 'step.start', stepId: 'agent:summary', kind: 'action', label: 'Resumiendo', ...parent });
          log?.emit({ type: 'step.end', stepId: 'agent:summary', label: 'Resumen listo', status: 'ok', detail: { kind: 'action', name: 'summary', summary: `${turn.summary.length} caracteres` } });
        }
        const u = isObj(e.usage) ? e.usage : {};
        // Una corrida usa un modelo; si el CLI reporta varios, la ventana es la mayor (la que acota el contexto).
        const windows = isObj(e.modelUsage) ? Object.values(e.modelUsage).map((m) => (isObj(m) && typeof m.contextWindow === 'number' ? m.contextWindow : 0)) : [];
        const contextWindow = Math.max(0, ...windows);
        turn.usage = addTokens(turn.usage, {
          ...(typeof u.cache_read_input_tokens === 'number' ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
          ...(contextWindow ? { contextWindow } : {}),
          ...(typeof u.input_tokens === 'number' ? { inputTokens: u.input_tokens + (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0) + (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0) } : {}),
          ...(typeof u.output_tokens === 'number' ? { outputTokens: u.output_tokens } : {}),
          ...(typeof e.total_cost_usd === 'number' ? { costUsd: e.total_cost_usd } : {}),
          ...(typeof e.duration_ms === 'number' ? { durationMs: e.duration_ms } : {}),
        });
        if (typeof e.session_id === 'string') turn.sessionId = e.session_id;
      }
    },
    turn: () => turn,
  };
}
