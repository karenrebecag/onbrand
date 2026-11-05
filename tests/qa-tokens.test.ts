// Los tokens de QA de identidad (scripts/qa-tokens.ts) valen contra el runtime configurado con las WT_* que imprime el
// mismo script: A y B son dueños distintos, EXPIRED vence, y las cookies de preview son de B para ese ws.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QA_OWNER_A, QA_OWNER_B, qaTokens } from '../scripts/qa-tokens';
import { jwtVerifierFromEnv } from '../src/adapters/jwt/verifier';
import { verifyPreviewToken } from '../src/runtime/preview-token';
import { isRejection } from '../src/runtime/session';

test('A y B verifican con su dueño y todos los scopes; EXPIRED es expired; las cookies de preview son de B y la vencida no vale', async () => {
  const now = Date.now();
  const ws = 'w'.repeat(32);
  const env = qaTokens({ ws, builderOrigin: 'http://localhost:5173', ttlMs: 3_600_000, previewSecret: Buffer.from('s'.repeat(32)), now });
  const v = jwtVerifierFromEnv(env, () => {});
  const who = async (t: string) => { const s = await v.verify({ authorization: `Bearer ${t}` }); return isRejection(s) ? s : { owner: s.owner, scopes: s.scopes.size }; };
  expect(await who(env.QA_TOKEN_A!)).toEqual({ owner: QA_OWNER_A, scopes: 4 });
  expect(await who(env.QA_TOKEN_B!)).toEqual({ owner: QA_OWNER_B, scopes: 4 });
  expect(await who(env.QA_TOKEN_EXPIRED!)).toEqual({ code: 'expired' });
  const secret = Buffer.from(env.WT_PREVIEW_SECRET!, 'utf8');
  const cookie = (c: string) => verifyPreviewToken(c.slice(c.indexOf('=') + 1), secret, ws, now);
  expect(env.QA_PREVIEW_COOKIE_B).toBeUndefined();
  expect(cookie(env.QA_PREVIEW_COOKIE_EXPIRED!)).toEqual({ ok: false, code: 'expired' });
});

const run = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync(['bun', join(import.meta.dir, '..', 'scripts', 'qa-tokens.ts'), ...args], { env: { ...process.env, ...env } });

test('el CLI nunca usa ni imprime el WT_PREVIEW_SECRET del entorno (podría ser el de un deploy real)', () => {
  const real = 'secreto-de-produccion-'.padEnd(40, 'x');
  const out = run(['--ws', 'w'.repeat(32)], { WT_PREVIEW_SECRET: real });
  expect(out.exitCode).toBe(0);
  expect(out.stdout.toString()).toContain('WT_PREVIEW_SECRET=');
  expect(out.stdout.toString()).not.toContain(real);
});

test('--out sobre un archivo existente falla sin tocarlo (el mode 0600 no se aplicaría)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'qa-tokens-')), '.env.qa');
  writeFileSync(file, 'previo\n', { mode: 0o644 });
  const out = run(['--ws', 'w'.repeat(32), '--out', file]);
  expect(out.exitCode).toBe(2);
  expect(readFileSync(file, 'utf8')).toBe('previo\n');
});
