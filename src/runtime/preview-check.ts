// Revisión del preview vivo al final del run (P2): el render-gate mide dist/, pero lo que ve la usuaria es el
// dev server, donde un error de runtime o de transformación de vite no deja rastro (RE-v0: "Show N preview
// issues"). Corre el sensor preview.runtime de QA tal cual, sobre la URL del preview y el workspace.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeDefect } from '../runtime-sensors';
import { agentEnv } from './agent-loop';
import { track } from './children';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'preview-runtime.ts');
const TIMEOUT_MS = 90_000;
// Playwright atrapa SIGTERM para cerrar el navegador con gracia y ese cierre puede colgarse (live5: 928 s).
const KILL_GRACE_MS = 5_000;

/** `logFile`: el log del mensaje, donde están las secciones elegidas de los mensajes en vuelo (`steer`). `viewport`: lo que
 * la persona mira al mandar el mensaje (Q6); el script lo mide además de los anchos fijos. */
export type PreviewChecker = (url: string, dir: string, opts?: { logFile?: string; viewport?: { width: number; height: number } }) => Promise<RuntimeDefect[]>;

/** Sale 1 cuando hay defectos: eso es un resultado, y solo cuenta si dejó el JSON. Otro exit, el timeout o un exit 1
 * sin JSON (un crash que no pasó por el script) son fallos con su causa. El JSON va fuera del workspace porque la
 * versión ya está commiteada y no debe quedar sucia. */
export function makePreviewCheck(script = SCRIPT, timeoutMs = TIMEOUT_MS): PreviewChecker {
  return async (url, dir, opts = {}) => {
    const tmp = mkdtempSync(join(tmpdir(), 'wt-preview-check-'));
    const out = join(tmp, 'preview.json');
    try {
      const { code, stderr, timedOut } = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve, reject) => {
        const child = track(spawn('bun', [script, url, dir, '--json', out, ...(opts.logFile ? ['--log', opts.logFile] : []), ...(opts.viewport ? ['--viewport', `${opts.viewport.width}x${opts.viewport.height}`] : [])], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], env: agentEnv(process.env) }));
        let stderr = '';
        let timedOut = false;
        child.stderr.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-400); });
        let killer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        }, timeoutMs);
        child.on('error', reject);
        // 'exit' y no 'close': un nieto que herede el pipe de stderr no debe alargar la espera.
        child.on('exit', (code) => { clearTimeout(timer); clearTimeout(killer); resolve({ code, stderr, timedOut }); });
      });
      if (timedOut) throw new Error(`preview-runtime: sin resultado en ${Math.round(timeoutMs / 1000)} s`);
      if ((code !== 0 && code !== 1) || !existsSync(out)) throw new Error(`preview-runtime falló (exit ${code}): ${stderr.trim()}`);
      const defects = (JSON.parse(readFileSync(out, 'utf8')) as { defects?: unknown }).defects;
      if (!Array.isArray(defects)) throw new Error('preview-runtime: falta defects en el JSON');
      return defects as RuntimeDefect[];
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

export const runPreviewCheck: PreviewChecker = makePreviewCheck();
