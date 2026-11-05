import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePreviewCheck } from '../src/runtime/preview-check';

const dir = mkdtempSync(join(tmpdir(), 'wt-pc-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const script = (name: string, body: string): string => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

describe('preview-check', () => {
  // live5: un crash del sensor salió con 1 sin JSON y el check reportó ENOENT del archivo temporal.
  test('un exit 1 sin JSON es un fallo con la causa del sensor, no un ENOENT', async () => {
    const check = makePreviewCheck(script('crash.ts', "console.error('goto: net::ERR_CONNECTION_REFUSED'); process.exit(1);\n"));
    await expect(check('http://127.0.0.1:1/', dir)).rejects.toThrow(/exit 1\): goto: net::ERR_CONNECTION_REFUSED/);
  });

  // live5 tardó 928 s: Playwright atrapa SIGTERM y su cierre se colgó.
  test('un sensor que ignora SIGTERM cae por timeout con SIGKILL', async () => {
    const check = makePreviewCheck(script('hang.ts', "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n"), 300);
    await expect(check('http://127.0.0.1:1/', dir)).rejects.toThrow(/sin resultado en 0 s/);
  }, 15_000);
});
