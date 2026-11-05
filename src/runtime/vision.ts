// Verificación visual con pregunta: un modelo de visión mira las capturas y devuelve texto, como `vision--describe_image`
// de Lovable (registry-CmMIU-Jy deob :8856; ZAP lov1358 offset 74667: el agente pasa `image_paths` + una `question`
// concreta y recibe la respuesta). Las imágenes no entran al contexto del agente: en V4 eran ~448 k tokens releídos en
// cada llamada siguiente (planes/qa.md §Audit-2).

import { execFile } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { gatewayConnection } from './gateway-auth';
import { gatewayModel } from './infer';
import { track } from './children';
import { config, type ComposeProvider } from '../config';

export type Describe = (pngs: readonly Buffer[], question: string, timeoutMs: number, signal?: AbortSignal) => Promise<string>;

export const MAX_QUESTION = 1000;
const MAX_ANSWER_TOKENS = 400;
// Lovable responde en un párrafo corto; un modelo chico alcanza para "qué se superpone en tal sección".
const DEFAULT_MODEL = 'haiku';

const SYSTEM = 'Eres el revisor visual de una landing. Las imágenes son tramos de una captura de la misma página, de arriba abajo y en orden. Responde solo lo que se pregunta, en español y en 5 frases como máximo, con lo que se ve: qué sección, qué elemento y qué está mal. Si algo no se ve en las imágenes, dilo; no supongas.';

const imageBlock = (png: Buffer) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: png.toString('base64') } });

/** El mensaje de usuario del CLI en stream-json: las imágenes van en el mensaje, sin tool Read. Con Read, cada tramo
 * era una vuelta de modelo (#403 medido: 35 s a 375 y más de 120 s a 1440). */
export function visionInput(pngs: readonly Buffer[], question: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [...pngs.map(imageBlock), { type: 'text', text: `${SYSTEM}\n\nPregunta: ${question}` }] } })}\n`;
}

/** El texto final del stream-json: la línea `result`. */
export function resultOf(stdout: string): string {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const o = JSON.parse(line) as { type?: string; result?: unknown; is_error?: boolean };
      if (o.type !== 'result') continue;
      if (o.is_error || typeof o.result !== 'string') throw new Error(`visión: el CLI terminó con error: ${String(o.result).slice(0, 200)}`);
      return o.result.trim();
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('visión:')) throw e;
    }
  }
  throw new Error('visión: el CLI no devolvió resultado');
}

export type VisionRun = (bin: string, args: string[], input: string, timeoutMs: number, signal?: AbortSignal) => Promise<string>;

/** Qué alcanzó a emitir el CLI antes de cortarse: tipo/subtipo de cada evento de stream-json, contados. Distingue un CLI
 * que no arrancó, uno que reintentaba la API y uno que esperaba al modelo (#403, 024b517c: una sección de 1 tramo vació
 * los 40 s sin un solo dato). */
export function streamTrace(stdout: string): string {
  const counts = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    try {
      const o = JSON.parse(line) as { type?: string; subtype?: string };
      const k = [o.type, o.subtype].filter(Boolean).join('/');
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    } catch { /* línea parcial del corte */ }
  }
  return counts.size ? [...counts].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(', ') : 'ninguno';
}

const spawnVision: VisionRun = (bin, args, input, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    // `timeout` mata el proceso: un CLI colgado no queda huérfano después de que la tool respondió. `signal` lo mata cuando
    // la corrida se detiene: sin él seguía hasta su plazo detrás de una tool ya respondida (auditoría #4).
    const child = track(execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const tail = String(stderr).trim().split('\n').slice(-1)[0]?.slice(0, 200);
      reject(new Error(`${err.killed ? `sin respuesta en ${Math.round(timeoutMs / 1000)} s` : err.message.split('\n')[0]} (eventos del CLI: ${streamTrace(String(stdout))}${tail ? `; stderr: ${tail}` : ''})`));
    }));
    child.stdin?.end(input);
  });

/** Argumentos de un `claude -p` sin herramientas, sin MCP ni ajustes del usuario (hooks, plugins): solo el modelo. */
export const visionArgs = (model: string): string[] => [
  '-p', '--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--tools', '', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence',
];

/** Por la sesión de Claude Code. */
export function cliDescribe(o: { bin?: string; model?: string; run?: VisionRun } = {}): Describe {
  const run = o.run ?? spawnVision;
  const bin = o.bin ?? process.env.WT_COMPOSE_CLI ?? 'claude';
  const model = o.model ?? process.env.WT_VISION_MODEL ?? DEFAULT_MODEL;
  return async (pngs, question, timeoutMs, signal) => resultOf(await run(bin, visionArgs(model), visionInput(pngs, question), timeoutMs, signal));
}

/** Por el Gateway (deploy): las imágenes van como bloques de la Messages API. */
export function gatewayDescribe(o: { model?: string } = {}): Describe {
  const { baseURL, token } = gatewayConnection();
  const client = new Anthropic({ baseURL, authToken: token, maxRetries: 0 });
  const model = gatewayModel(o.model ?? process.env.WT_VISION_MODEL ?? DEFAULT_MODEL);
  return async (pngs, question, timeoutMs, signal) => {
    const res = await client.messages.create(
      { model, max_tokens: MAX_ANSWER_TOKENS, system: SYSTEM, messages: [{ role: 'user', content: [...pngs.map(imageBlock), { type: 'text', text: question }] }] },
      { timeout: timeoutMs, ...(signal ? { signal } : {}) },
    );
    return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim();
  };
}

export function createDescribe(provider: ComposeProvider = config().composeProvider): Describe {
  return provider === 'gateway' ? gatewayDescribe() : cliDescribe();
}
