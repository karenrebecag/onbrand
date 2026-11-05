import { expect, test } from 'bun:test';
import type { ChatEntry } from '../src/orchestrator/chat-index';
import { cachedSandbox } from '../src/orchestrator/cached-sandbox';
import { fakeSandboxProvider, type SandboxEnv } from '../src/orchestrator/sandbox';

const chat = (id: string): ChatEntry => ({ chatId: id, owner: 'u', title: '', sandbox: { name: '' }, head: { messageId: '', commit: '' }, updatedAt: 0, spend: 0 });
const env: SandboxEnv = { WT_IDENTITY_PUBLIC_KEY: 'P', WT_PREVIEW_PUBLIC_KEY: 'P', WT_CHAT_ID: 'c' };

test('ensure dentro del TTL no vuelve a llamar al proveedor; pasado el TTL, sí; stop lo olvida', async () => {
  const fake = fakeSandboxProvider(async () => 'http://vm');
  let t = 1000;
  const p = cachedSandbox(fake.provider, 100, () => t);
  const a = await p.ensure(chat('c'), env);
  t += 50;
  expect(await p.ensure(chat('c'), env)).toBe(a);
  expect(fake.calls.filter((c) => c === 'ensure:c')).toHaveLength(1);
  t += 100;
  await p.ensure(chat('c'), env);
  expect(fake.calls.filter((c) => c === 'ensure:c')).toHaveLength(2);
  await p.stop('c');
  await p.ensure(chat('c'), env);
  expect(fake.calls.filter((c) => c === 'ensure:c')).toHaveLength(3);
});

test('requests simultáneas por el mismo chat comparten una sola llamada al proveedor', async () => {
  const fake = fakeSandboxProvider(async () => { await new Promise((r) => setTimeout(r, 20)); return 'http://vm'; });
  const p = cachedSandbox(fake.provider);
  const [a, b, c] = await Promise.all([p.ensure(chat('c'), env), p.ensure(chat('c'), env), p.ensure(chat('c'), env)]);
  expect(b).toBe(a);
  expect(c).toBe(a);
  expect(fake.calls.filter((x) => x === 'ensure:c')).toHaveLength(1);
});

test('un ensure que falla no queda cacheado y un TTL inválido se rechaza', async () => {
  let fail = true;
  const fake = fakeSandboxProvider(async () => { if (fail) throw new Error('api caída'); return 'http://vm'; });
  const p = cachedSandbox(fake.provider);
  await expect(p.ensure(chat('c'), env)).rejects.toThrow('api caída');
  fail = false;
  expect((await p.ensure(chat('c'), env)).apiUrl).toBe('http://vm');
  expect(() => cachedSandbox(fake.provider, -1)).toThrow('ttlMs');
});
