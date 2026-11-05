import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../src/ds-registry';
import { readSkillPack, skillItemPath, skillItemSha } from '../src/skill-registry';
import { openRegistry, type BlobReader } from '../src/runtime/registry-source';

function skill(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-'));
  writeFileSync(join(dir, 'SKILL.md'), '# Arc\n');
  mkdirSync(join(dir, 'references'));
  writeFileSync(join(dir, 'references', 'button.md'), 'Button\n');
  return dir;
}

describe('skill del agente por pin (R6)', () => {
  test('se publica con todos sus archivos, entra al sha del índice y se baja del pin a la caché', async () => {
    const item = readSkillPack('arc-agent', skill());
    expect(item.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/button.md']);
    const path = skillItemPath(item.id, skillItemSha(item));
    expect(buildIndex([], {}, {}, { 'arc-agent': path }).sha).not.toBe(buildIndex([], {}).sha);
    const read: BlobReader = async (p) => {
      if (p === 'index@abcd1234.json') return { version: 'abcd1234', items: {}, skills: { 'arc-agent': path } };
      if (p === path) return item;
      throw new Error(`404 ${p}`);
    };
    const cache = mkdtempSync(join(tmpdir(), 'skill-cache-'));
    const reg = await openRegistry({ pin: 'abcd1234', read, skillCacheDir: cache });
    const dir = await reg.skillPack?.('arc-agent');
    expect(dir).toBe(join(cache, 'abcd1234', 'arc-agent'));
    expect(readFileSync(join(dir as string, 'references', 'button.md'), 'utf8')).toBe('Button\n');
  });

  test('un pin sin skill devuelve undefined; un skill sin SKILL.md o con symlink no se publica', async () => {
    const read: BlobReader = async () => ({ version: 'abcd1234', items: {} });
    const reg = await openRegistry({ pin: 'abcd1234', read, skillCacheDir: mkdtempSync(join(tmpdir(), 'skill-cache-')) });
    expect(await reg.skillPack?.('arc-agent')).toBeUndefined();
    expect(() => readSkillPack('x', mkdtempSync(join(tmpdir(), 'empty-')))).toThrow('falta SKILL.md');
    const dir = skill();
    symlinkSync('/etc/hosts', join(dir, 'references', 'hosts.md'));
    expect(() => readSkillPack('x', dir)).toThrow('symlink');
  });
});
