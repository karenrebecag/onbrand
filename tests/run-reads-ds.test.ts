// C3: GET /chats/:id devuelve `ds {pin, latest}`: el pin de la versión HEAD del chat (su request.json) y el `latest` del
// registry. Sin registry no hay campo. RunReads directo sobre un repo real; el registry es una función falsa.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAll, initRepo } from '../src/runtime/git-workspace';
import { RunReads, type RunReadsDeps } from '../src/runtime/run-reads';
import type { MessageEntry } from '../src/runtime/shared';
import { dsSkillOf, LEGACY_DS_SKILL } from '../src/runtime/run-checks';

let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'reads-ds-'));
  dir = join(tmp, 'ws', 'c1');
  mkdirSync(dir, { recursive: true });
  initRepo(dir);
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const version = (pin: string | undefined, file: string): string => {
  writeFileSync(join(dir, file), file);
  writeFileSync(join(dir, 'request.json'), JSON.stringify(pin ? { registryPin: pin } : {}));
  return commitAll(dir, file);
};

function reads(index: Record<string, MessageEntry>, registry?: RunReadsDeps['opts']['registry']): RunReads {
  return new RunReads({
    index: () => index,
    entry: (id) => index[id] as MessageEntry,
    wsDir: () => dir,
    logDir: join(tmp, 'logs'),
    isFinished: () => true,
    brandOf: () => undefined,
    stableUrl: () => 'http://127.0.0.1:1/',
    servableDist: () => undefined,
    exportDist: async () => { throw new Error('sin export en este test'); },
    atCommit: () => false,
    opts: { ...(registry ? { registry } : {}) },
  });
}

const entry = (commit: string, at: number, parentId?: string): MessageEntry => ({ ws: 'c1', commit, at, prompt: 'p', ...(parentId ? { parentId } : {}) });
const ds = async (r: RunReads) => ((await r.thread('c1')) as { ds?: { pin?: string; skill?: string; latest?: string; latestSkill?: string } }).ds;

test('ds.pin es el de la versión HEAD del chat y ds.latest el que publica el registry', async () => {
  const c1 = version('aaaaaaaa', 'a.txt');
  const c2 = version('bbbbbbbb', 'b.txt');
  const index = { c1: entry(c1, 1), c2: entry(c2, 2, 'c1') };
  expect(await ds(reads(index, async () => ({ pin: 'cccccccc' })))).toEqual({ pin: 'bbbbbbbb', skill: 'arc-agent', latest: 'cccccccc', latestSkill: 'base-agent' });
});

test('sin registry no hay campo ds, aunque la versión tenga pin', async () => {
  const c1 = version('aaaaaaaa', 'a.txt');
  expect(await ds(reads({ c1: entry(c1, 1) }))).toBeUndefined();
});

test('un registry que falla deja el pin sin latest, y una versión sin pin deja solo latest', async () => {
  const c1 = version('aaaaaaaa', 'a.txt');
  expect(await ds(reads({ c1: entry(c1, 1) }, async () => { throw new Error('blob caído'); }))).toEqual({ pin: 'aaaaaaaa', skill: 'arc-agent' });
  const c2 = version(undefined, 'b.txt');
  expect(await ds(reads({ c1: entry(c2, 1) }, async () => ({ pin: 'cccccccc' })))).toEqual({ latest: 'cccccccc', latestSkill: 'base-agent' });
});

test('el latest se reutiliza en lecturas seguidas: el registry se abre una vez', async () => {
  const c1 = version('aaaaaaaa', 'a.txt');
  let opens = 0;
  const r = reads({ c1: entry(c1, 1) }, async () => { opens++; return { pin: 'cccccccc' }; });
  await ds(r);
  await ds(r);
  expect(opens).toBe(1);
});

test('un dsSkill que no es id de skill en request.json cuenta como versión anterior al registro', () => {
  expect(dsSkillOf('aaaaaaaa', '<img src=x>')).toBe(LEGACY_DS_SKILL);
  expect(dsSkillOf('aaaaaaaa', 'base-agent')).toBe('base-agent');
  expect(dsSkillOf(undefined, 'base-agent')).toBeUndefined();
});
