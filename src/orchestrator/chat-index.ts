// Índice global de chats (docs/spec/deploy-sandbox.md §3): lo que el orquestador necesita saber de cada chat sin despertar su VM.
// Un blob por chat (`chats/<base64url(owner)>/<chatId>.json`) y uno por dueño para el contador (`spend/<base64url(owner)>.json`),
// así el reintento solo choca entre corridas del mismo dueño y `list({ prefix })` lista por dueño. Lo escribe SOLO el orquestador
// (A2). El cliente de Blob entra por deps (A3): el módulo no importa @vercel/blob ni lee ninguna credencial.

import { createHash } from 'node:crypto';

/** Lo mínimo que se le pide a Blob: leer con etag, crear una vez, reemplazar si el etag no cambió, y listar por prefijo. */
export interface BlobClient {
  read(pathname: string): Promise<{ text: string; etag: string } | undefined>;
  /** Falla con BlobExistsError si ya hay un blob en `pathname`. */
  create(pathname: string, body: string): Promise<{ etag: string }>;
  /** Solo escribe si el blob sigue con `ifMatch`; si cambió (o ya no está) falla con BlobConflictError. */
  replace(pathname: string, body: string, ifMatch: string): Promise<{ etag: string }>;
  list(prefix: string): Promise<string[]>;
}

export class BlobExistsError extends Error {}
export class BlobConflictError extends Error {}
export class ChatExistsError extends Error {}
export class ChatNotFoundError extends Error {}
/** Se agotaron los reintentos: otro escritor del mismo blob ganó `maxRetries` veces seguidas. */
export class IndexContentionError extends Error {}

export interface ChatEntry {
  readonly chatId: string;
  readonly owner: string;
  readonly title: string;
  readonly sandbox: Readonly<{ name: string; snapshotId?: string }>;
  readonly head: Readonly<{ messageId: string; commit: string }>;
  readonly updatedAt: number;
  /** Gasto acumulado de este chat, en la unidad que fije el proxy (§1). */
  readonly spend: number;
}

/** Tokens de la Messages API. `input` NO incluye los cache_*: se suman aparte porque cuestan distinto. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cache_creation_input: number;
  readonly cache_read_input: number;
}

export interface SpendCounter {
  readonly owner: string;
  /** USD acumulado: contra esto se comparan los topes. */
  readonly spent: number;
  /** Desglose por modelo, solo para auditar el USD. */
  readonly byModel: Readonly<Record<string, TokenUsage>>;
  /** Ids de las últimas operaciones aplicadas (APPLIED_IDS): un reintento tras un error ambiguo no repite su delta. */
  readonly applied: readonly string[];
  readonly updatedAt: number;
}

/** Cuántos ids de operación recuerda el contador. Un reintento llega segundos después; 64 cubre de sobra las corridas paralelas de un dueño. */
export const APPLIED_IDS = 64;

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cache_creation_input: 0, cache_read_input: 0 };

export interface ChatIndexDeps {
  readonly blob: BlobClient;
  /** Reintentos ante una escritura que perdió la carrera, además del primer intento. */
  readonly maxRetries?: number;
  /** Espera antes del reintento número `attempt` (0, 1, …); por defecto backoff exponencial con jitter. Los tests la inyectan sin espera. */
  readonly sleep?: (attempt: number) => Promise<void>;
  readonly now?: () => number;
  /** true = el contador es por día UTC (`spend/<dueño>/<YYYY-MM-DD>.json`) y el tope del proxy es diario; false (default) = acumulado
   * por dueño, el blob de antes. Un ajuste que cruza la medianoche cae en el día nuevo y el mínimo en 0 evita un gasto negativo. */
  readonly daily?: boolean;
}

const DAY_MS = 86_400_000;
/** Día UTC de un instante y el ms en que empieza el siguiente: lo que GET /spend le dice al builder como `resetsAt`. */
export const dayWindow = (at: number): { day: string; resetsAt: number } => ({ day: new Date(at).toISOString().slice(0, 10), resetsAt: (Math.floor(at / DAY_MS) + 1) * DAY_MS });

export interface ChatIndex {
  createChat(entry: ChatEntry): Promise<ChatEntry>;
  getChat(owner: string, chatId: string): Promise<ChatEntry | undefined>;
  /** Lee, aplica `change` (pura: devuelve la entrada nueva, no muta) y escribe con el etag leído; reintenta si perdió la carrera. */
  updateChat(owner: string, chatId: string, change: (current: ChatEntry) => ChatEntry): Promise<ChatEntry>;
  listChats(owner: string): Promise<ChatEntry[]>;
  /** "Siempre" del dueño para las tools de gasto (spec orquestador-enrutamiento §8): la fuente única, con el orquestador como único escritor. */
  readAlways(owner: string): Promise<string[]>;
  /** Idempotente. Lanza ALWAYS_LIMIT si ya hay tantas, o si el nombre no tiene forma de tool. */
  addAlways(owner: string, tool: string): Promise<string[]>;
  /** Idempotente: quitar lo que no estaba no falla. */
  removeAlways(owner: string, tool: string): Promise<string[]>;
  /** Petición de aprobación pendiente de un chat (spec §8.1): la registra la VM con su token de corrida, pero los patrones los calcula el índice a partir de la tool,
   * nunca los dicta la VM. Idempotente por `callId` (la primera tool registrada manda). Lanza `PendingLimitError` con `PENDING_LIMIT` vigentes. `spend`: la tool es de gasto y admite "siempre". */
  registerPending(owner: string, chat: string, callId: string, tool: string, spend: boolean, ttlMs: number, input?: unknown): Promise<PendingItem>;
  readPending(owner: string, chat: string, callId: string): Promise<PendingItem | undefined>;
  /** Fija la decisión de la persona una sola vez: 'none' = no hay registro vigente, 'decided' = ya se decidió. */
  decidePending(owner: string, chat: string, callId: string, decision: PendingDecision): Promise<'ok' | 'none' | 'decided'>;
  /** Deshace la decisión si la VM no la aceptó, para poder volver a decidir la tarjeta. No toca lo ya entregado. */
  revertPending(owner: string, chat: string, callId: string): Promise<void>;
  /** Entrega el permiso de una llamada aprobada una sola vez (marca `granted`); undefined si no hay decisión allow/always o ya se entregó. */
  takeGrant(owner: string, chat: string, callId: string): Promise<PendingItem | undefined>;
  /** Consume el permiso (jti = callId): true solo la primera vez y para la tool registrada. */
  useGrant(owner: string, chat: string, callId: string, tool: string): Promise<boolean>;
  readSpend(owner: string): Promise<SpendCounter>;
  addSpend(owner: string, amountUsd: number, tokens?: SpendTokens, opId?: string): Promise<SpendCounter>;
  /** Como addSpend pero con delta de cualquier signo: el proxy reserva la estimación antes de reenviar y la ajusta al usage real
   * (puede bajar). El contador nunca queda negativo. `day` (con `daily`) liquida contra el día de la reserva, no el de hoy: una
   * corrida que cruza la medianoche UTC cierra su cuenta en el contador donde reservó. */
  adjustSpend(owner: string, deltaUsd: number, tokens?: SpendTokens, opId?: string, day?: string): Promise<SpendCounter>;
  /** Reserva condicional: suma `amountUsd` solo si `spent + amountUsd <= capUsd`, decidido DENTRO del read-modify-write con el etag, así
   * N reservas paralelas del mismo dueño no leen el mismo valor y se cuelan. `ok: false` no suma nada. */
  reserveSpend(owner: string, amountUsd: number, capUsd: number, opId: string): Promise<{ ok: boolean; counter: SpendCounter; day?: string }>;
}

/** `opId` hace idempotente la operación: el mismo id dos veces suma una (error de red tras un write que sí se aplicó). */
export interface SpendTokens {
  readonly model: string;
  readonly usage: TokenUsage;
}

// Mismo alfabeto que el messageId del Runtime: el chatId llega a un pathname, así que no puede traer `/` ni `..`. Se repite aquí
// y no se importa de runtime/shared porque el orquestador se despliega aparte del Runtime.
const CHAT_ID = /^[a-z0-9-]{1,63}$/;
export type PendingDecision = 'allow' | 'always' | 'skip';
export interface PendingItem {
  readonly tool: string;
  /** `Tool(<tool>:*)`: el alcance de ESA llamada, el que la tarjeta muestra y el grant cubre. */
  readonly patterns: readonly string[];
  /** `Dynamic(<tool>)` solo en tools de gasto; vacío = la tarjeta no ofrece "siempre". */
  readonly remember: readonly string[];
  /** Lo que la VM registró como argumentos de la llamada: la tarjeta lo muestra desde aquí y el permiso cubre solo su hash. */
  readonly input?: unknown;
  readonly args: string;
  readonly exp: number;
  readonly decision?: PendingDecision;
  readonly granted?: true;
  readonly used?: true;
}
export class PendingLimitError extends Error {}
export class PendingInputError extends Error {}
/** Tope de los argumentos que la VM registra con la tarjeta: lo que la persona ve y lo que el permiso cubre. */
export const PENDING_INPUT_MAX_BYTES = 16 * 1024;
const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null');
/** sha256 del JSON con claves ordenadas: dos objetos con los mismos argumentos dan el mismo hash sin importar el orden de las claves. */
export const argsHash = (input: unknown): string => createHash('sha256').update(canonical(input ?? {})).digest('hex');
/** Aprobaciones pendientes vigentes por chat. Se tomó el mismo valor que ALWAYS_LIMIT a falta de fuente (ni v0 ni approvals.ts limitan pendientes); son límites distintos y uno no arrastra al otro. */
export const PENDING_LIMIT = 16;
const CALL_ID = /^[A-Za-z0-9._-]{1,128}$/;
const pendingPath = (owner: string, chat: string): string => `pending/${b64(owner)}/${chat}.json`;

/** Cuántas tools de gasto distintas puede tener un dueño: hoy son 2; el tope evita que una VM comprometida llene el blob. */
export const ALWAYS_LIMIT = 16;
export const TOOL_NAME = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_-]{1,64}$/;
const alwaysPath = (owner: string): string => `always/${b64(owner)}.json`;
const REMEMBER = /^Dynamic\((mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_-]{1,64})\)$/;
/** Lo guardado son patrones `Dynamic(<tool>)` (v0: lo recordado es siempre eso); el formato anterior `{tools}` se sigue leyendo como `Dynamic(<tool>)`. */
function parseAlways(text: string | undefined, pathname: string): string[] {
  if (text === undefined) return [];
  const v: unknown = JSON.parse(text);
  const bad = new Error(`chat-index: ${ref(pathname)} no tiene la forma de un "siempre"`);
  if (!isObject(v)) throw bad;
  let tools: unknown[];
  if (Array.isArray(v.patterns)) tools = v.patterns.map((x) => (typeof x === 'string' ? REMEMBER.exec(x)?.[1] : undefined));
  else if (Array.isArray(v.tools)) tools = v.tools;
  else throw bad;
  if (!tools.every((t): t is string => typeof t === 'string' && TOOL_NAME.test(t))) throw bad;
  return [...new Set(tools)].sort();
}
const alwaysBody = (tools: readonly string[], at: number): string => JSON.stringify({ patterns: tools.map((t) => `Dynamic(${t})`), updatedAt: at });

/** Lo vencido se descarta al leer y, como el contrato de Blob no borra, queda fuera en la siguiente escritura. */
function parsePending(text: string | undefined, pathname: string, at: number): Record<string, PendingItem> {
  const out: Record<string, PendingItem> = Object.create(null);
  if (text === undefined) return out;
  const v: unknown = JSON.parse(text);
  if (!isObject(v) || !isObject(v.items)) throw new Error(`chat-index: ${ref(pathname)} no tiene la forma de un registro de aprobaciones`);
  for (const [id, raw] of Object.entries(v.items)) {
    if (!isObject(raw) || typeof raw.tool !== 'string' || typeof raw.exp !== 'number' || typeof raw.args !== 'string' || !Array.isArray(raw.patterns) || !Array.isArray(raw.remember)) throw new Error(`chat-index: ${ref(pathname)} trae una aprobación mal formada`);
    if (raw.exp > at) out[id] = raw as unknown as PendingItem;
  }
  return out;
}
const withoutInput = (item: PendingItem): PendingItem => { const { input: _input, ...rest } = item; return rest as PendingItem; };
// HACK: el input de una aprobación decidida pero nunca entregada (allow/always sin takeGrant) queda en el blob hasta que alguien reescriba ese chat; no hay barrido de pending/<owner>/.
// Barrido cuando haya un cron del perfil (fila en la checklist del deploy).
const pendingBody = (items: Record<string, PendingItem>): string => JSON.stringify({ items });

/** El dueño suele ser un email y la ruta lo lleva en base64url (se decodifica trivial): al log va un hash corto, y ni la ruta ni el mensaje del parser (puede citar el contenido). */
function logCorruptAlways(owner: string, what: string): void {
  console.error(`[chat-index] "siempre" corrupto del dueño ${createHash('sha256').update(owner).digest('hex').slice(0, 8)}: ${what}`);
}

/** Los pathnames llevan el dueño en base64url (un email se decodifica trivial) y estos mensajes llegan a los logs: se cita un hash corto, no la ruta. */
const ref = (pathname: string): string => createHash('sha256').update(pathname).digest('hex').slice(0, 8);

const b64 = (owner: string): string => Buffer.from(owner).toString('base64url');

const chatPath = (owner: string, chatId: string): string => `chats/${b64(owner)}/${chatId}.json`;
const spendPath = (owner: string, day?: string): string => (day === undefined ? `spend/${b64(owner)}.json` : `spend/${b64(owner)}/${day}.json`);

function checkOwner(owner: string): void {
  if (!owner) throw new Error('chat-index: el dueño no puede ser vacío');
}
function checkChatId(chatId: string): void {
  if (!CHAT_ID.test(chatId)) throw new Error(`chat-index: chatId inválido "${chatId}"`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Un blob que no tiene la forma del índice no se usa a medias: falla en voz alta (un JSON editado a mano o de otra versión). */
function parseChat(text: string, pathname: string): ChatEntry {
  const v: unknown = JSON.parse(text);
  const ok = isObject(v) && typeof v.chatId === 'string' && typeof v.owner === 'string' && typeof v.title === 'string' && typeof v.updatedAt === 'number' && typeof v.spend === 'number'
    && isObject(v.sandbox) && typeof v.sandbox.name === 'string' && isObject(v.head) && typeof v.head.messageId === 'string' && typeof v.head.commit === 'string';
  if (!ok) throw new Error(`chat-index: ${ref(pathname)} no tiene la forma de una entrada de chat`);
  return v as unknown as ChatEntry;
}
const USAGE_KEYS = ['input', 'output', 'cache_creation_input', 'cache_read_input'] as const;
// Sin prototipo: el nombre del modelo viene del upstream y '__proto__' o 'constructor' no deben leerse como propios.
function parseByModel(v: unknown, pathname: string): Record<string, TokenUsage> {
  const out: Record<string, TokenUsage> = Object.create(null);
  if (v === undefined) return out;
  if (!isObject(v)) throw new Error(`chat-index: ${ref(pathname)} trae un byModel que no es un objeto`);
  for (const [model, u] of Object.entries(v)) {
    if (!isObject(u) || !USAGE_KEYS.every((k) => typeof u[k] === 'number' && Number.isFinite(u[k]) && (u[k] as number) >= 0)) throw new Error(`chat-index: ${ref(pathname)} trae un uso inválido para "${model}"`);
    out[model] = { input: u.input as number, output: u.output as number, cache_creation_input: u.cache_creation_input as number, cache_read_input: u.cache_read_input as number };
  }
  return out;
}
function parseSpend(text: string, pathname: string): SpendCounter {
  const v: unknown = JSON.parse(text);
  if (!(isObject(v) && typeof v.owner === 'string' && typeof v.spent === 'number' && typeof v.updatedAt === 'number')) throw new Error(`chat-index: ${ref(pathname)} no tiene la forma de un contador`);
  const applied = v.applied === undefined ? [] : Array.isArray(v.applied) && v.applied.every((x) => typeof x === 'string') ? (v.applied as string[]) : undefined;
  if (!applied) throw new Error(`chat-index: ${ref(pathname)} trae un applied que no es una lista de ids`);
  return { owner: v.owner, spent: v.spent, byModel: parseByModel(v.byModel, pathname), applied, updatedAt: v.updatedAt };
}

const sumUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cache_creation_input: a.cache_creation_input + b.cache_creation_input,
  cache_read_input: a.cache_read_input + b.cache_read_input,
});

const backoff = (attempt: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * 2 ** Math.min(attempt, 5)));

export function createChatIndex(deps: ChatIndexDeps): ChatIndex {
  const { blob } = deps;
  const maxRetries = deps.maxRetries ?? 8;
  const sleep = deps.sleep ?? backoff;
  const now = deps.now ?? Date.now;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const spendFor = (owner: string, day?: string): string => {
    if (!deps.daily) return spendPath(owner);
    if (day !== undefined && !DAY.test(day)) throw new Error(`chat-index: día inválido "${day}"`);
    return spendPath(owner, day ?? dayWindow(now()).day);
  };

  /** Lee-modifica-escribe con reintento: `next` recibe lo vigente (o undefined) y devuelve el texto a guardar y el resultado. */
  /** `body` ausente = no hay nada que cambiar: no se escribe (ni se crea el blob) y no hay contención de etag que provocar. */
  async function rmw<T>(pathname: string, next: (current: string | undefined) => { body?: string; result: T }): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const current = await blob.read(pathname);
      const { body, result } = next(current?.text);
      if (body === undefined) return result;
      try {
        if (current) await blob.replace(pathname, body, current.etag);
        else await blob.create(pathname, body);
        return result;
      } catch (e) {
        // Perder la carrera (otro escribió el mismo blob entre mi lectura y mi escritura) es lo esperado: se relee y se reaplica.
        if (!(e instanceof BlobConflictError || e instanceof BlobExistsError)) throw e;
        if (attempt < maxRetries) await sleep(attempt);
      }
    }
    throw new IndexContentionError(`chat-index: ${ref(pathname)} sigue en disputa tras ${maxRetries + 1} intentos`);
  }

  return {
    async createChat(entry) {
      checkOwner(entry.owner);
      checkChatId(entry.chatId);
      try {
        await blob.create(chatPath(entry.owner, entry.chatId), JSON.stringify(entry));
      } catch (e) {
        if (e instanceof BlobExistsError) throw new ChatExistsError(`chat-index: el chat ${entry.chatId} ya existe`);
        throw e;
      }
      return entry;
    },

    async getChat(owner, chatId) {
      checkOwner(owner);
      checkChatId(chatId);
      const pathname = chatPath(owner, chatId);
      const hit = await blob.read(pathname);
      return hit ? parseChat(hit.text, pathname) : undefined;
    },

    async updateChat(owner, chatId, change) {
      checkOwner(owner);
      checkChatId(chatId);
      const pathname = chatPath(owner, chatId);
      return rmw(pathname, (text) => {
        if (text === undefined) throw new ChatNotFoundError(`chat-index: no hay chat ${chatId}`);
        const next = change(parseChat(text, pathname));
        // El dueño y el id son la llave del blob: un cambio que los toque escribiría una entrada que no se encuentra donde está.
        if (next.owner !== owner || next.chatId !== chatId) throw new Error('chat-index: updateChat no puede cambiar owner ni chatId');
        const stamped: ChatEntry = { ...next, updatedAt: now() };
        return { body: JSON.stringify(stamped), result: stamped };
      });
    },

    async listChats(owner) {
      checkOwner(owner);
      // El prefijo termina en `/` y base64url no tiene `/`: el dueño 'a' no recoge los chats de 'ab'.
      const paths = await blob.list(`chats/${b64(owner)}/`);
      const entries = await Promise.all(paths.map(async (pathname) => {
        const hit = await blob.read(pathname);
        return hit ? parseChat(hit.text, pathname) : undefined;
      }));
      return entries.filter((e): e is ChatEntry => e !== undefined).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async readAlways(owner) {
      checkOwner(owner);
      const hit = await blob.read(alwaysPath(owner));
      // Un archivo corrupto se lee como vacío (vuelve a preguntar, nunca autoaprueba) y se reporta: el dueño no debe quedar sin poder ver ni revocar.
      try { return parseAlways(hit?.text, alwaysPath(owner)); } catch { logCorruptAlways(owner, 'se lee como vacío'); return []; }
    },

    async addAlways(owner, tool) {
      checkOwner(owner);
      if (!TOOL_NAME.test(tool)) throw new Error(`chat-index: nombre de tool inválido "${tool.slice(0, 80)}"`);
      const pathname = alwaysPath(owner);
      return rmw(pathname, (text) => {
        const tools = parseAlways(text, pathname);
        if (tools.includes(tool)) return { body: alwaysBody(tools, now()), result: tools };
        if (tools.length >= ALWAYS_LIMIT) throw new Error(`chat-index: ${owner} ya tiene ${ALWAYS_LIMIT} "siempre"`);
        const next = [...tools, tool].sort();
        return { body: alwaysBody(next, now()), result: next };
      });
    },

    async removeAlways(owner, tool) {
      checkOwner(owner);
      const pathname = alwaysPath(owner);
      return rmw(pathname, (text) => {
        let tools: string[] = [];
        try { tools = parseAlways(text, pathname); } catch { logCorruptAlways(owner, 'se vacía'); }
        const next = tools.filter((t) => t !== tool);
        return { body: alwaysBody(next, now()), result: next };
      });
    },

    async registerPending(owner, chat, callId, tool, spend, ttlMs, input = {}) {
      checkOwner(owner);
      checkChatId(chat);
      if (!CALL_ID.test(callId) || !TOOL_NAME.test(tool)) throw new Error('chat-index: callId o tool inválidos');
      if (Buffer.byteLength(JSON.stringify(input) ?? 'null') > PENDING_INPUT_MAX_BYTES) throw new PendingInputError('chat-index: argumentos de la aprobación demasiado grandes');
      const pathname = pendingPath(owner, chat);
      return rmw(pathname, (text) => {
        const items = parsePending(text, pathname, now());
        const existing = items[callId];
        if (existing) return { result: existing };
        if (Object.keys(items).length >= PENDING_LIMIT) throw new PendingLimitError(`chat-index: ${chat} ya tiene ${PENDING_LIMIT} aprobaciones pendientes`);
        const item: PendingItem = { tool, patterns: [`Tool(${tool}:*)`], remember: spend ? [`Dynamic(${tool})`] : [], input, args: argsHash(input), exp: now() + ttlMs };
        items[callId] = item;
        return { body: pendingBody(items), result: item };
      });
    },

    async readPending(owner, chat, callId) {
      checkOwner(owner);
      checkChatId(chat);
      const pathname = pendingPath(owner, chat);
      const hit = await blob.read(pathname);
      return parsePending(hit?.text, pathname, now())[callId];
    },

    async decidePending(owner, chat, callId, decision) {
      const pathname = pendingPath(owner, chat);
      checkOwner(owner);
      checkChatId(chat);
      return rmw(pathname, (text) => {
        const items = parsePending(text, pathname, now());
        const item = items[callId];
        if (!item) return { result: 'none' as const };
        if (item.decision) return { result: 'decided' as const };
        // skip no se revierte ni entrega grant: el input (cuerpos de correo, datos de terceros) ya no hace falta en el blob.
        items[callId] = decision === 'skip' ? { ...withoutInput(item), decision } : { ...item, decision };
        return { body: pendingBody(items), result: 'ok' as const };
      });
    },

    async revertPending(owner, chat, callId) {
      const pathname = pendingPath(owner, chat);
      checkOwner(owner);
      checkChatId(chat);
      await rmw(pathname, (text) => {
        const items = parsePending(text, pathname, now());
        const item = items[callId];
        if (!item?.decision || item.granted) return { result: undefined };
        const { decision: _decision, ...rest } = item;
        items[callId] = rest;
        return { body: pendingBody(items), result: undefined };
      });
    },

    async takeGrant(owner, chat, callId) {
      const pathname = pendingPath(owner, chat);
      checkOwner(owner);
      checkChatId(chat);
      return rmw(pathname, (text) => {
        const items = parsePending(text, pathname, now());
        const item = items[callId];
        if (!item || (item.decision !== 'allow' && item.decision !== 'always') || item.granted) return { result: undefined };
        // Entregado el permiso solo hace falta `args` (el hash); el input se queda fuera del blob. Un revert ya no es posible tras `granted`.
        items[callId] = { ...withoutInput(item), granted: true };
        return { body: pendingBody(items), result: item };
      });
    },

    async useGrant(owner, chat, callId, tool) {
      const pathname = pendingPath(owner, chat);
      checkOwner(owner);
      checkChatId(chat);
      return rmw(pathname, (text) => {
        const items = parsePending(text, pathname, now());
        const item = items[callId];
        if (!item || !item.granted || item.used || item.tool !== tool) return { result: false };
        items[callId] = { ...item, used: true };
        return { body: pendingBody(items), result: true };
      });
    },

    async readSpend(owner) {
      checkOwner(owner);
      const pathname = spendFor(owner);
      const hit = await blob.read(pathname);
      return hit ? parseSpend(hit.text, pathname) : { owner, spent: 0, byModel: Object.create(null), applied: [], updatedAt: 0 };
    },

    async addSpend(owner, amount, tokens, opId) {
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`chat-index: el gasto debe ser un número >= 0, llegó ${amount}`);
      return applySpend(owner, amount, tokens, opId);
    },

    async adjustSpend(owner, delta, tokens, opId, day) {
      if (!Number.isFinite(delta)) throw new Error(`chat-index: el ajuste debe ser un número finito, llegó ${delta}`);
      return applySpend(owner, delta, tokens, opId, undefined, day);
    },

    async reserveSpend(owner, amount, cap, opId) {
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`chat-index: la reserva debe ser un número >= 0, llegó ${amount}`);
      if (!Number.isFinite(cap) || cap < 0) throw new Error(`chat-index: el tope debe ser un número >= 0, llegó ${cap}`);
      let ok = true;
      // El día se fija ANTES del rmw: la reserva y su liquidación posterior usan el mismo, aunque el reintento cruce la medianoche.
      const day = deps.daily ? dayWindow(now()).day : undefined;
      const counter = await applySpend(owner, amount, undefined, opId, (spent) => { ok = spent + amount <= cap; return ok; }, day);
      return { ok, counter, ...(day === undefined ? {} : { day }) };
    },
  };

  function applySpend(owner: string, amount: number, tokens: SpendTokens | undefined, opId: string | undefined, allow?: (spent: number) => boolean, day?: string): Promise<SpendCounter> {
    checkOwner(owner);
    const pathname = spendFor(owner, day);
    return rmw(pathname, (text) => {
      const current = text === undefined ? undefined : parseSpend(text, pathname);
      // Ya aplicado: se reescribe lo vigente sin sumar (el rmw necesita un body; es idéntico al leído).
      if (current && opId !== undefined && current.applied.includes(opId)) return { body: text!, result: current };
      // Sin cupo no se suma: se reescribe lo vigente (o un contador en cero si aún no existe) y el que llama ve `ok: false`.
      if (allow && !allow(current?.spent ?? 0)) {
        const unchanged: SpendCounter = current ?? { owner, spent: 0, byModel: Object.create(null), applied: [], updatedAt: now() };
        return { body: text ?? JSON.stringify(unchanged), result: unchanged };
      }
      const byModel: Record<string, TokenUsage> = Object.assign(Object.create(null), current?.byModel);
      if (tokens) byModel[tokens.model] = sumUsage(Object.hasOwn(byModel, tokens.model) ? byModel[tokens.model]! : ZERO_USAGE, tokens.usage);
      const applied = opId === undefined ? (current?.applied ?? []) : [...(current?.applied ?? []), opId].slice(-APPLIED_IDS);
      const counter: SpendCounter = { owner, spent: Math.max(0, (current?.spent ?? 0) + amount), byModel, applied, updatedAt: now() };
      return { body: JSON.stringify(counter), result: counter };
    });
  }
}
