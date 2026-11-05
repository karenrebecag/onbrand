// Aprobación de tools de conector (contrato de Orq, ronda conectores): `claude -p --permission-prompt-tool` llama a
// nuestra tool `approve` por cada tool que no está en --allowedTools y espera su respuesta. Aquí se decide si esa
// llamada pasa sola, se deniega sin preguntar o queda pendiente hasta que el usuario decide en el builder. El turno
// no se corta: la tool del CLI bloquea, así el agente sigue con su contexto en vez de tener que volver a pedirla.

import type { ApprovalLink } from './approval-link';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { AlwaysStore } from './approvals-always';
import { LOCAL_OWNER } from './session';
import type { ApprovalDecision, ApprovalKind, ApprovalRequest } from './event-model';
import { EDIT_IMAGE_TOOL, IMAGE_TOOL } from './image-tool';
import { EXIT_PLAN_TOOL_FULL } from './plan-exit';
import { MCP_SERVER } from './workspace-mcp';

export const PERMISSION_MODES = ['ask', 'auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const APPROVAL_SERVER = 'approval';
export const APPROVAL_TOOL = `mcp__${APPROVAL_SERVER}__approve`;
export const APPROVAL_TIMEOUT_MS = 120_000;

/** Lo que manda el CLI a la permission-prompt-tool (verificado con 2.1.311). */
export interface PermissionAsk {
  tool_name: string;
  input: unknown;
  tool_use_id: string;
}

/** Respuesta que el CLI espera como texto JSON del tool_result. */
export type PermissionReply = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string };

/** Servidor MCP de la tool, o null si es una tool del CLI (Bash, Write...). */
export function serverOf(toolName: string): string | null {
  const [prefix, server, tool] = toolName.split('__');
  return prefix === 'mcp' && server && tool ? server : null;
}

/** Conector = tool MCP que no es nuestra. Bash fuera de la lista o una tool del DS no llegan al usuario: se
 * deniegan como antes de existir la aprobación. */
export const isConnectorTool = (toolName: string): boolean => {
  const server = serverOf(toolName);
  return server !== null && server !== MCP_SERVER && server !== APPROVAL_SERVER;
};

/** Tools propias que gastan créditos: no van en --allowedTools y pasan por la tarjeta con nota de costo, como la de
 * generación de Lovable (MediaGenerationApprovalCard deob :133-196, registry :4855). */
export const SPEND_TOOLS: ReadonlySet<string> = new Set([`mcp__${MCP_SERVER}__${IMAGE_TOOL}`, `mcp__${MCP_SERVER}__${EDIT_IMAGE_TOOL}`]);

/** Tarjeta del plan (H6): exit_plan_mode. No gasta créditos, pero pasa por una tarjeta como el gasto y nunca se
 * autoaprueba. El turno no la espera (el transport la maneja diferida en su tools/call), así que no llega a `ask`. */
export const PLAN_TOOLS: ReadonlySet<string> = new Set([EXIT_PLAN_TOOL_FULL]);

/** Sin `readOnlyHint: true` declarado, la tool escribe: ante la duda se pregunta. */
export const kindOf = (toolName: string, readOnly: ReadonlySet<string>): ApprovalKind => (PLAN_TOOLS.has(toolName) ? 'plan' : SPEND_TOOLS.has(toolName) ? 'spend' : readOnly.has(toolName) ? 'read' : 'write');

/** En fase plan, las únicas escrituras permitidas son al archivo del plan del mensaje. `file_path` del CLI puede venir
 * absoluto o relativo al workspace: se resuelve contra el mismo dir antes de comparar. */
export function writesPlanFile(input: unknown, plan: { dir: string; path: string }): boolean {
  const fp = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).file_path : undefined;
  if (typeof fp !== 'string' || !fp) return false;
  const got = isAbsolute(fp) ? resolve(fp) : resolve(plan.dir, fp);
  return got === resolve(plan.dir, plan.path);
}

export const denyMessage = (toolName: string, decision: Exclude<ApprovalDecision, 'allow'>): string => `El usuario no aprobó ${toolName} (${decision})`;

export function isPermissionMode(v: unknown): v is PermissionMode {
  return PERMISSION_MODES.includes(v as PermissionMode);
}

export interface ApprovalSink {
  request(r: ApprovalRequest): void;
  decision(callId: string, decision: ApprovalDecision, scope?: 'always'): void;
}

interface Pending {
  chat: string;
  owner: string;
  toolName: string;
  resolve: (d: ApprovalDecision, scope?: 'always') => void;
  /** Con orquestador el índice global es la fuente: el almacén local no se escribe, para que nadie lo tome por ella. */
  remote: boolean;
  /** Lo que la tarjeta muestra: el input de la llamada y cuándo vence, para servir GET /approvals/:callId sin otra fuente. */
  input: unknown;
  exp: number;
}

/** La tarjeta de aprobación tal como la pinta el builder: misma forma que el orquestador (routes.ts pendingView). Con
 * `decision` cuando ya se decidió: la tarjeta dice "ya decidida" en vez de "no disponible" mientras viva el proceso. */
export interface ApprovalCard {
  callId: string;
  tool: string;
  patterns: string[];
  rememberPatterns: string[];
  input: unknown;
  expiresAt: number;
  decision?: 'allow' | 'skip';
}

export class DecisionError extends Error {
  constructor(readonly status: 404 | 409, message: string) {
    super(message);
  }
}

/** Pendientes de todo el transport, por callId (el tool_use_id del CLI, único por llamada). */
export class Approvals {
  private pending = new Map<string, Pending>();
  // callId → chat de cada tarjeta que pasó por aquí; solo strings cortos, vive lo que el proceso.
  private seen = new Map<string, string>();
  // callId → la tarjeta ya decidida y su decisión: tras decidir, el GET la sigue dando con `decision` (no 404) mientras
  // viva el proceso, como el orquestador (routes.ts pendingView con rec.decision). Un timeout no entra: ese es un 404.
  private decided = new Map<string, { chat: string; card: ApprovalCard }>();
  /** callId -> permiso firmado de esa llamada, hasta que `takeGrantFor` lo recoge. */
  private grants = new Map<string, string>();
  /** "Siempre" de la tarjeta de gasto, por (dueño, tool) y para cualquier chat de ese dueño: el de Lovable dice "Images
   * generated from any chat. You won't be asked again." (registry-CmMIU-Jy :4855-4859). Así una corrida de variantes no
   * pregunta N veces. Vive en AlwaysStore; aquí solo se lee y se pide escribir (ADR 0014 reglas 2-3). */
  private always: AlwaysStore;

  /** `alwaysPath`: dónde se guarda el "siempre"; con archivo sobrevive al reinicio. `ownerOf`: quién es el dueño de un
   * chat; sin identidad todos son 'local' y nada cambia (docs/spec/identidad-sesion.md lo inyectará). */
  constructor(private timeoutMs = APPROVAL_TIMEOUT_MS, alwaysPath?: string, private ownerOf: (chat: string) => string = () => LOCAL_OWNER, private now: () => number = Date.now) {
    this.always = new AlwaysStore((t) => SPEND_TOOLS.has(t), alwaysPath);
  }

  /** GET /approvals/always: lo que hoy se autoaprueba, para el menú de la tarjeta. */
  alwaysTools(owner = LOCAL_OWNER): string[] {
    return this.always.tools(owner);
  }

  /** DELETE /approvals/always/:tool, "Preguntar cada vez" (Lovable :1453-1463). Idempotente; false si no es de gasto. */
  revokeAlways(toolName: string, owner = LOCAL_OWNER): boolean {
    if (!SPEND_TOOLS.has(toolName)) return false;
    if (this.always.delete(owner, toolName)) this.always.persist();
    return true;
  }

  /** Lo que responde la permission-prompt-tool. Bloquea solo cuando hay que preguntar. `preapproveSpend`: el T1 corre
   * con imágenes habilitadas, que es la opción de la persona (S5 regla 1, adaptación sin extract), y lo mismo cada
   * variante de un grupo pedido con imágenes; no guarda un "siempre" (regla 10), así el primer follow-up vuelve a preguntar. */
  async ask(chat: string, mode: PermissionMode, readOnly: ReadonlySet<string>, ask: PermissionAsk, sink: ApprovalSink, reason?: string, preapproveSpend = false, plan?: { dir: string; path: string }, alwaysRemote?: () => Promise<ReadonlySet<string> | undefined>, link?: ApprovalLink): Promise<PermissionReply> {
    const { tool_name: toolName, input, tool_use_id: callId } = ask;
    const owner = this.ownerOf(chat);
    // Fase plan (H6): el agente lee y planea; Write/Edit salen de allowedTools y caen aquí. La única escritura que pasa es
    // el archivo del plan del mensaje; no se genera imagen ni se escribe por un conector hasta que la persona aprueba.
    if (plan) {
      if (toolName === 'Write' || toolName === 'Edit') {
        return writesPlanFile(input, plan) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'modo plan: sin cambios al código, solo el archivo del plan' };
      }
      if (SPEND_TOOLS.has(toolName)) return { behavior: 'deny', message: 'modo plan: no se generan imágenes hasta aprobar el plan' };
      if (isConnectorTool(toolName) && kindOf(toolName, readOnly) !== 'read') return { behavior: 'deny', message: 'modo plan: solo lecturas de conector hasta aprobar el plan' };
    }
    const spend = SPEND_TOOLS.has(toolName);
    if (!spend && !isConnectorTool(toolName)) return { behavior: 'deny', message: `${toolName} no está permitida en este agente` };
    const kind = kindOf(toolName, readOnly);
    if (mode === 'auto' && kind === 'read') return { behavior: 'allow', updatedInput: input };
    if (spend && preapproveSpend) return { behavior: 'allow', updatedInput: input };
    // Con orquestador (alwaysRemote) manda el índice global y un fallo de la consulta es "no hay siempre"; sin él, el AlwaysStore local.
    const isAlways = spend && (alwaysRemote ? ((await alwaysRemote())?.has(toolName) ?? false) : this.always.has(owner, toolName));
    if (isAlways) {
      // El "siempre" de la persona se ve en el hilo, ya resuelto, para que la tarjeta tenga dónde colgar "Preguntar cada
      // vez" (Lovable :1743-1748). La preaprobación del T1 no es una decisión suya y no se pinta.
      sink.request({ callId, toolName, app: serverOf(toolName) as string, ...(reason ? { reason } : {}), input, kind });
      sink.decision(callId, 'allow', 'always');
      return { behavior: 'allow', updatedInput: input };
    }
    if (this.pending.has(callId)) return { behavior: 'deny', message: denyMessage(toolName, 'skip') };
    // Con orquestador la tarjeta existe primero allí (de ahí salen los patrones que la persona ve y el permiso que se acuña); si no la acepta, no se muestra.
    if (link && !(await link.register(callId, toolName, input))) return { behavior: 'deny', message: `${toolName}: no se pudo registrar la aprobación; reintenta` };
    let scope: 'always' | undefined;
    this.seen.set(callId, chat);
    const decided = new Promise<ApprovalDecision>((resolve) => this.pending.set(callId, { chat, owner, toolName, remote: Boolean(alwaysRemote), input, exp: this.now() + this.timeoutMs, resolve: (d, s) => { scope = s; resolve(d); } }));
    const timer = setTimeout(() => this.settle(callId, 'timeout'), this.timeoutMs);
    sink.request({ callId, toolName, app: serverOf(toolName) as string, ...(reason ? { reason } : {}), input, kind });
    const decision = await decided;
    clearTimeout(timer);
    // QA G3a (ab82a7f7): el 'Permitir siempre' se registraba como allow a secas y el log no decía por qué G3b no preguntó.
    sink.decision(callId, decision, scope);
    if (link && decision === 'allow' && !spend) {
      const grant = await link.grant(callId);
      if (grant) this.grants.set(callId, grant);
    }
    return decision === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: denyMessage(toolName, decision) };
  }

  /** El permiso de esa llamada (una sola vez): lo recoge quien va a presentarlo al orquestador. */
  takeGrantFor(callId: string): string | undefined {
    const grant = this.grants.get(callId);
    this.grants.delete(callId);
    return grant;
  }

  /** La tool de la tarjeta que espera decisión en este chat; con ella se decide qué scope pide contestarla. */
  pendingTool(chat: string, callId: string): string | undefined {
    const p = this.pending.get(callId);
    return p?.chat === chat ? p.toolName : undefined;
  }

  /** La tarjeta con los patrones derivados de la tool, como el índice (chat-index.ts registerPending): patterns siempre
   * `Tool(t:*)`; rememberPatterns solo para gasto, `Dynamic(t)`. */
  private cardOf(p: Pending, callId: string): ApprovalCard {
    return {
      callId,
      tool: p.toolName,
      patterns: [`Tool(${p.toolName}:*)`],
      rememberPatterns: SPEND_TOOLS.has(p.toolName) ? [`Dynamic(${p.toolName})`] : [],
      input: p.input,
      expiresAt: p.exp,
    };
  }

  /** GET /chats/:id/approvals/:callId: la tarjeta de este chat, con la misma forma que el orquestador (routes.ts
   * pendingView). Mientras espera, sin `decision`; ya decidida, con ella. undefined = no existe, es de otro chat o venció
   * (un pendiente vivo pasado su `exp`) → 404. */
  pendingView(chat: string, callId: string): ApprovalCard | undefined {
    const p = this.pending.get(callId);
    if (p && p.chat === chat) return this.now() > p.exp ? undefined : this.cardOf(p, callId);
    const d = this.decided.get(callId);
    return d && d.chat === chat ? d.card : undefined;
  }

  /** ¿Este chat tuvo alguna vez una tarjeta con ese callId? Separa "no existe" (404) de "ya se decidió" (409, que sigue
   * saliendo de decide): una tarjeta decidida ya no está en `pending`, por eso no basta mirar ahí. */
  knows(chat: string, callId: string): boolean {
    return this.seen.get(callId) === chat;
  }

  /** POST /chats/:id/approvals/:callId. 409 si ya no espera: decidido, vencido o de otro chat. `always` solo se guarda
   * para una tool de gasto; en un conector vale como `allow`, porque la aprobación de un conector es por llamada. */
  decide(chat: string, callId: string, decision: 'allow' | 'always' | 'skip'): { always?: string } {
    const p = this.pending.get(callId);
    if (!p || p.chat !== chat) throw new DecisionError(409, `${callId} no espera decisión`);
    // La tarjeta sobrevive a settle con su decisión, para que el GET diga "ya decidida" (always cuenta como allow).
    this.decided.set(callId, { chat, card: { ...this.cardOf(p, callId), decision: decision === 'skip' ? 'skip' : 'allow' } });
    if (decision === 'always' && SPEND_TOOLS.has(p.toolName) && !p.remote) this.always.add(p.owner, p.toolName);
    // La llamada del CLI se resuelve antes de escribir: un disco que falla no puede dejarla colgada hasta el timeout.
    this.settle(callId, decision === 'always' ? 'allow' : decision, decision === 'always' ? 'always' : undefined);
    if (decision === 'always' && SPEND_TOOLS.has(p.toolName)) {
      if (!p.remote) {
        try {
          this.always.persist();
        } catch (e) {
          console.error(`[approvals] el "siempre" de ${p.toolName} vale en este proceso pero no se guardó: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Bajo el orquestador quien lo escribe en el índice global es él, a partir de esto.
      return { always: p.toolName };
    }
    return {};
  }

  /** Al cerrar un turno lo que quedó pendiente se omite: el CLI ya no está para recibirlo. */
  cancelChat(chat: string): void {
    for (const [callId, p] of this.pending) if (p.chat === chat) this.settle(callId, 'skip');
  }

  private settle(callId: string, decision: ApprovalDecision, scope?: 'always'): void {
    const p = this.pending.get(callId);
    if (!p) return;
    this.pending.delete(callId);
    p.resolve(decision, scope);
  }
}

export const APPROVAL_MCP_SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'approval-mcp.ts');

/** Dónde pide la permission-prompt-tool: el endpoint interno del transport y el token de la corrida. */
export interface ApprovalEndpoint {
  url: string;
  token: string;
}

/** Suma el servidor `approval` a un --mcp-config (o crea uno). URL y token van en `env`, no en `args`; el JSON entero no
 * puede ir en el argv de `claude`: va a un archivo con mcpConfigFile. */
export function withApprovalServer(config: string | undefined, endpoint: ApprovalEndpoint, script = APPROVAL_MCP_SCRIPT): string {
  const base = config ? (JSON.parse(config) as { mcpServers?: Record<string, unknown> }) : {};
  const server = { command: 'bun', args: [script], env: { WT_APPROVAL_URL: endpoint.url, WT_APPROVAL_TOKEN: endpoint.token } };
  return JSON.stringify({ ...base, mcpServers: { ...(base.mcpServers ?? {}), [APPROVAL_SERVER]: server } });
}

/** --mcp-config acepta una ruta: el JSON con el token va a un archivo 0600 fuera del workspace (el agente lee el
 * workspace) y no al argv, que cualquiera ve en `ps`. Se borra al cerrar la corrida. */
export function mcpConfigFile(config: string, root = tmpdir()): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(root, 'wt-mcp-'));
  const path = join(dir, 'mcp-config.json');
  writeFileSync(path, config, { mode: 0o600 });
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
