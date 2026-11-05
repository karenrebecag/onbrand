// Arranque real de scripts/serve.ts: los guards del gate de preview asimétrico (deploy-sandbox §4, security-reviewer).
// Pública XOR secreto; con 'signed' la pública es obligatoria; fuera de loopback sin ningún gate no arranca.
import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

const keys = generateKeyPairSync('ed25519');
const PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const CHAT = 'chat0123456789abcdefghijklmn';
const baseEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

async function boot(env: Record<string, string>): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(['bun', 'scripts/serve.ts'], { env: { ...baseEnv, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return { code, err };
}

test('secreto y pública a la vez salen con 2: son excluyentes', async () => {
  const { code, err } = await boot({ WT_PREVIEW_SECRET: 'x'.repeat(32), WT_PREVIEW_PUBLIC_KEY: PEM });
  expect(code).toBe(2);
  expect(err).toContain('excluyentes');
});

test('con WT_SESSION_PROVIDER=signed y sin pública del preview sale con 2', async () => {
  const { code, err } = await boot({ WT_SESSION_PROVIDER: 'signed', WT_IDENTITY_PUBLIC_KEY: PEM, WT_CHAT_ID: CHAT });
  expect(code).toBe(2);
  expect(err).toContain('WT_PREVIEW_PUBLIC_KEY');
});

test('fuera de loopback sin ningún gate de preview sale con 2', async () => {
  const { code, err } = await boot({ WT_HOST: '0.0.0.0', WT_ORIGIN_SECRET: 's'.repeat(32), WT_SESSION_PROVIDER: 'signed', WT_IDENTITY_PUBLIC_KEY: PEM, WT_CHAT_ID: CHAT });
  expect(code).toBe(2);
  expect(err).toContain('fuera de loopback');
});

test('--no-render-check se retiró (#854) y sale con 2 en vez de ignorarse', async () => {
  const p = Bun.spawn(['bun', 'scripts/serve.ts', '--no-render-check'], { env: baseEnv, stdout: 'pipe', stderr: 'pipe' });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  expect(code).toBe(2);
  expect(err).toContain('--no-render-check se retiró');
});
