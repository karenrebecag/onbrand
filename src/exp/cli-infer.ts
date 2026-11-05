// Transporte mínimo `claude -p` para los prototipos offline de esta rama. Es el mismo mecanismo que
// src/runtime/infer.ts de exp/v0-compose (claudeCodeInferFree); esa rama no está mergeada aquí, así que se
// duplica lo justo y se borra al converger. Sin key: usa la sesión autenticada de la máquina.

import { execFile } from 'node:child_process';

export type Infer = (system: string, userJson: string) => Promise<unknown>;

const run = (bin: string, args: string[], input: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(bin, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`claude-code: ${err.message}${stderr ? ` — ${stderr.slice(0, 300)}` : ''}`));
      resolve(stdout);
    });
    child.stdin?.end(input);
  });

/** Primer objeto JSON del stdout (tolerante a texto o fences alrededor). */
export function parseJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('claude-code: la salida no contiene un objeto JSON');
  return JSON.parse(body.slice(start, end + 1));
}

export function cliInfer(model = process.env.WT_COMPOSE_MODEL ?? 'sonnet', bin = process.env.WT_COMPOSE_CLI ?? 'claude'): Infer {
  return async (system, userJson) => parseJsonObject(await run(bin, ['-p', '--model', model, '--append-system-prompt', system], userJson));
}
