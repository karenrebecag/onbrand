// Transporte por la CLI de Claude Code (`claude -p`) para la frontera CopyGenerator. No necesita key
// ni API: usa la sesión autenticada de Claude Code de la máquina (va a la suscripción). Es el camino
// por defecto; el de API (claude-transport.ts) queda para entornos sin la CLI. El prompt page-content-1
// es el mismo (buildSystemPrompt): el contrato de entrada/salida no cambia según el transporte.

import { execFile } from 'node:child_process';
import { llmCopyGenerator, type CopyGenerator, type LlmInfer } from './generator';
import { buildSystemPrompt } from './claude-transport';

/** Modelo por defecto para la CLI; override por WT_COPY_MODEL (alias sonnet|opus|haiku o id completo). */
const DEFAULT_MODEL = 'sonnet';

/** Ejecuta un comando con input por stdin y devuelve stdout. Inyectable para tests (sin spawn real). */
export type RunCli = (bin: string, args: string[], input: string) => Promise<string>;

const spawnCli: RunCli = (bin, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(bin, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`claude-code: ${err.message}${stderr ? ` — ${stderr.slice(0, 200)}` : ''}`));
      resolve(stdout);
    });
    child.stdin?.end(input);
  });

export interface ClaudeCodeOptions {
  model?: string;
  bin?: string;
  run?: RunCli;
}

/** Extrae el primer objeto JSON del stdout (tolerante a texto alrededor). */
function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('claude-code: la salida no contiene un objeto JSON');
  return JSON.parse(text.slice(start, end + 1));
}

/** LlmInfer que invoca `claude -p --model <m> --append-system-prompt <sys>` con el inputJson por stdin. */
export function claudeCodeInfer(opts: ClaudeCodeOptions = {}): LlmInfer {
  const run = opts.run ?? spawnCli;
  const bin = opts.bin ?? 'claude';
  const model = opts.model ?? DEFAULT_MODEL;
  return async (_prompt, context) => {
    const args = ['-p', '--model', model, '--append-system-prompt', buildSystemPrompt(context)];
    return parseJsonObject(await run(bin, args, context.inputJson));
  };
}

/** Generador respaldado por la CLI de Claude Code. `WT_COPY_MODEL` cambia el modelo; `WT_COPY_CLI` el
 * binario. No valida que la CLI exista: quien selecciona decide (ver copyGeneratorFromEnv). */
export function claudeCodeGenerator(env: Record<string, string | undefined> = process.env): CopyGenerator {
  return llmCopyGenerator(claudeCodeInfer({
    ...(env.WT_COPY_MODEL ? { model: env.WT_COPY_MODEL } : {}),
    ...(env.WT_COPY_CLI ? { bin: env.WT_COPY_CLI } : {}),
  }));
}
