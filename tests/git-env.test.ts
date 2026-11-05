import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv } from '../src/runtime/git-env';
import { commitAll, initRepo } from '../src/runtime/git-workspace';

test('gitEnv deja solo lo que git necesita: sin WT_*, tokens ni GIT_* heredados; lo explícito va encima', () => {
  const env = gitEnv({ GIT_INDEX_FILE: '/x' }, { PATH: '/bin', HOME: '/h', WT_ORCH_PRIVATE_KEY: 'k', ANTHROPIC_API_KEY: 'a', BLOB_READ_WRITE_TOKEN: 't', GIT_DIR: '/otro', GIT_INDEX_FILE: '/viejo' });
  expect(env).toEqual({ PATH: '/bin', HOME: '/h', GIT_INDEX_FILE: '/x' });
});

// El agente escribe el workspace entero, .git/hooks incluido. Revisión de Arq a #816: el env filtrado no bastaba, el hook
// corría código en el proceso del runtime en cada commitAll, fuera de la aprobación de tools. Ahora no corre (core.hooksPath).
test('un hook pre-commit escrito en el .git del workspace no corre en commitAll (ni ve los secretos del proceso)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-env-'));
  const prev = { WT_ORCH_PRIVATE_KEY: process.env.WT_ORCH_PRIVATE_KEY, BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN };
  try {
    writeFileSync(join(dir, 'a.txt'), 'x');
    initRepo(dir);
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\nenv > "${join(dir, 'visto.txt')}"\n`);
    chmodSync(hook, 0o755);
    process.env.WT_ORCH_PRIVATE_KEY = 'SECRETO-1';
    process.env.BLOB_READ_WRITE_TOKEN = 'SECRETO-2';
    writeFileSync(join(dir, 'b.txt'), 'y');
    commitAll(dir, 'cambio');
    expect(existsSync(join(dir, 'visto.txt'))).toBe(false);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  }
});
