import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Approvals, type ApprovalSink } from '../src/runtime/approvals';
import type { ApprovalDecision, ApprovalRequest } from '../src/runtime/events';
import { Runtime } from '../src/runtime/server';
import { ALL_SCOPES, type SessionVerifier } from '../src/runtime/session';

const IMG = 'mcp__wt__generate_image';
const ask = (id: string) => ({ tool_name: IMG, input: { prompt: 'p', target_path: '/images/a.jpg' }, tool_use_id: id });
const sink = () => {
  const requests: ApprovalRequest[] = [];
  const decisions: [ApprovalDecision, string | undefined][] = [];
  const s: ApprovalSink = { request: (r) => { requests.push(r); }, decision: (_c, d, scope) => { decisions.push([d, scope]); } };
  return { s, requests, decisions };
};

let tmp: string | undefined;
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = undefined; });

test('"siempre" sobrevive al reinicio, se ve resuelto en el hilo y "Preguntar cada vez" lo revoca', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'approvals-always-'));
  const path = join(tmp, 'approvals.json');
  const first = new Approvals(10_000, path);
  const pending = first.ask('chat', 'ask', new Set(), ask('t1'), sink().s);
  first.decide('chat', 't1', 'always');
  await pending;
  // Otro proceso con el mismo archivo: no pregunta, y el hilo recibe la tarjeta ya resuelta con scope always.
  const again = new Approvals(10_000, path);
  expect(again.alwaysTools()).toEqual([IMG]);
  const seen = sink();
  expect(await again.ask('otro-chat', 'ask', new Set(), ask('t2'), seen.s)).toMatchObject({ behavior: 'allow' });
  expect(seen.requests.map((r) => r.callId)).toEqual(['t2']);
  expect(seen.decisions).toEqual([['allow', 'always']]);
  // La preaprobación del T1 no es una decisión de la persona: no se pinta.
  const pre = sink();
  await again.ask('chat', 'ask', new Set(), ask('t3'), pre.s, undefined, true);
  expect(pre.requests).toEqual([]);
  // Revocado, vuelve a preguntar, también tras otro reinicio; una tool que no es de gasto no se revoca.
  expect(again.revokeAlways('mcp__slack__send_message')).toBe(false);
  expect(again.revokeAlways(IMG)).toBe(true);
  expect(new Approvals(10_000, path).alwaysTools()).toEqual([]);
  const asked = sink();
  const p = again.ask('chat', 'ask', new Set(), ask('t4'), asked.s);
  expect(asked.requests.map((r) => r.callId)).toEqual(['t4']);
  expect(asked.decisions).toEqual([]);
  again.decide('chat', 't4', 'skip');
  await p;
});

test('GET y DELETE /approvals/always', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'approvals-always-http-'));
  const root = join(tmp, 'state');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'approvals.json'), JSON.stringify({ tools: [IMG, 'mcp__slack__send_message'] }));
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(scaffold, { recursive: true });
  const t = new Runtime({ root, allow: {}, compose: async () => ({ sections: [] }), build: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault') });
  const s = t.listen(0);
  await new Promise((r) => s.once('listening', r));
  const at = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  try {
    // Lo que no es de gasto en el archivo se ignora.
    expect(await (await fetch(`${at}/approvals/always`)).json()).toEqual({ tools: [IMG] });
    expect((await fetch(`${at}/approvals/always/${encodeURIComponent('mcp__slack__send_message')}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await fetch(`${at}/approvals/always/${encodeURIComponent(IMG)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status).toBe(204);
    expect((await fetch(`${at}/approvals/always/${encodeURIComponent(IMG)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status).toBe(204);
    expect(await (await fetch(`${at}/approvals/always`)).json()).toEqual({ tools: [] });
  } finally {
    s.close();
  }
});

test('GET/DELETE /approvals/always responden solo el "siempre" de session.owner (fase 3)', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'approvals-always-owner-http-'));
  const root = join(tmp, 'state');
  mkdirSync(root, { recursive: true });
  // alice tiene el "siempre"; local y bob no.
  writeFileSync(join(root, 'approvals.json'), JSON.stringify({ owners: { alice: [IMG] } }));
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(scaffold, { recursive: true });
  // Verifier de prueba: el dueño sale de un header, para actuar como alice o bob contra el mismo server.
  const session: SessionVerifier = { verify: async (h) => ({ owner: String(h['x-test-owner'] ?? 'local'), scopes: ALL_SCOPES }) };
  const t = new Runtime({ root, allow: {}, compose: async () => ({ sections: [] }), build: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), session });
  const s = t.listen(0);
  await new Promise((r) => s.once('listening', r));
  const at = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const get = (owner: string) => fetch(`${at}/approvals/always`, { headers: { 'x-test-owner': owner } }).then((r) => r.json());
  const del = (owner: string) => fetch(`${at}/approvals/always/${encodeURIComponent(IMG)}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-test-owner': owner } }).then((r) => r.status);
  try {
    expect(await get('alice')).toEqual({ tools: [IMG] });
    expect(await get('bob')).toEqual({ tools: [] });
    // bob revoca: idempotente (204) y no toca lo de alice.
    expect(await del('bob')).toBe(204);
    expect(await get('alice')).toEqual({ tools: [IMG] });
    // alice revoca el suyo.
    expect(await del('alice')).toBe(204);
    expect(await get('alice')).toEqual({ tools: [] });
  } finally {
    s.close();
  }
});

test('un approvals.json ilegible no tumba el arranque y un disco que falla no deja colgada la decisión', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'approvals-always-bad-'));
  const path = join(tmp, 'approvals.json');
  writeFileSync(path, '{ roto');
  const a = new Approvals(10_000, path);
  expect(a.alwaysTools()).toEqual([]);
  // persist() falla (la ruta es un directorio): la llamada se resuelve igual y el "siempre" vale en este proceso.
  rmSync(path);
  mkdirSync(path);
  const p = a.ask('chat', 'ask', new Set(), ask('b1'), sink().s);
  expect(() => a.decide('chat', 'b1', 'always')).not.toThrow();
  expect(await p).toMatchObject({ behavior: 'allow' });
  expect(a.alwaysTools()).toEqual([IMG]);
});

test('el "siempre" de un dueño no aprueba a otro y sobrevive al reinicio por dueño', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'approvals-always-owner-'));
  const path = join(tmp, 'approvals.json');
  const ownerOf = (chat: string) => (chat.startsWith('x-') ? 'x' : 'y');
  const a = new Approvals(10_000, path, ownerOf);
  const p = a.ask('x-1', 'ask', new Set(), ask('o1'), sink().s);
  a.decide('x-1', 'o1', 'always');
  await p;
  const asked = sink();
  const other = a.ask('y-1', 'ask', new Set(), ask('o2'), asked.s);
  expect(asked.decisions).toEqual([]);
  a.decide('y-1', 'o2', 'skip');
  await other;
  expect(a.alwaysTools('x')).toEqual([IMG]);
  expect(a.alwaysTools('y')).toEqual([]);
  expect(new Approvals(10_000, path, ownerOf).alwaysTools('x')).toEqual([IMG]);
  expect(new Approvals(10_000, path, ownerOf).alwaysTools('y')).toEqual([]);
});
