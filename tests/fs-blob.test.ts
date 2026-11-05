import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobConflictError, BlobExistsError, createChatIndex } from '../src/orchestrator/chat-index';
import { fsBlobClient } from '../src/orchestrator/fs-blob';

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'fs-blob-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('create no pisa, replace exige el etag vigente y list devuelve rutas relativas por prefijo', async () => {
  const b = fsBlobClient(fresh());
  const { etag } = await b.create('chats/a/1.json', '{"v":1}');
  await expect(b.create('chats/a/1.json', 'otro')).rejects.toBeInstanceOf(BlobExistsError);
  await expect(b.replace('chats/a/1.json', '{"v":2}', 'viejo')).rejects.toBeInstanceOf(BlobConflictError);
  const next = await b.replace('chats/a/1.json', '{"v":2}', etag);
  expect(await b.read('chats/a/1.json')).toEqual({ text: '{"v":2}', etag: next.etag });
  await b.create('chats/b/2.json', '{}');
  expect(await b.list('chats/a/')).toEqual(['chats/a/1.json']);
  expect(await b.read('chats/a/no.json')).toBeUndefined();
});

test('un pathname que sale del directorio se rechaza en toda operación', async () => {
  const root = fresh();
  const b = fsBlobClient(root);
  for (const bad of ['../fuera.json', '/abs.json', 'a/../../x', 'a//b']) {
    await expect(b.create(bad, 'x')).rejects.toThrow(/pathname inválido/);
    await expect(b.read(bad)).rejects.toThrow(/pathname inválido/);
  }
  expect(existsSync(join(root, '..', 'fuera.json'))).toBe(false);
});

test('el índice de chats corre entero sobre disco: gasto concurrente del mismo dueño no pierde sumas', async () => {
  const index = createChatIndex({ blob: fsBlobClient(fresh()), daily: true, maxRetries: 30, sleep: async () => undefined });
  await Promise.all(Array.from({ length: 12 }, (_, i) => index.addSpend('u', 1, undefined, `op-${i}`)));
  expect((await index.readSpend('u')).spent).toBe(12);
});
