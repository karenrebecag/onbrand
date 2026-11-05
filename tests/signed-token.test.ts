import { test, expect } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { sign, verify, MAX_TTL_MS, type TokenClaims } from '../src/signed-token';
import { signedVerifier } from '../src/runtime/signed-verifier';
import { issueIdentity } from '../src/orchestrator/identity';
import { isRejection, ALL_SCOPES, providerVerifier } from '../src/runtime/session';

const keys = generateKeyPairSync('ed25519');
const NOW = 1_000_000;
const claims: TokenClaims = { typ: 'identity', owner: 'user_1', scopes: ['chat:read', 'chat:write'], chat: 'chat-a', exp: NOW + 60_000 };
const expectId = { typ: 'identity', chat: 'chat-a', now: NOW } as const;

test('ida y vuelta: lo firmado con la privada verifica con la pública', () => {
  const v = verify(keys.publicKey, sign(keys.privateKey, claims), expectId);
  expect(v).toEqual({ ok: true, claims });
});

test('un token de preview no vale como identidad', () => {
  const t = sign(keys.privateKey, { ...claims, typ: 'preview' });
  expect(verify(keys.publicKey, t, expectId)).toEqual({ ok: false, code: 'invalid' });
  expect(verify(keys.publicKey, t, { ...expectId, typ: 'preview' }).ok).toBe(true);
});

test('el token de otro chat no vale en esta VM', () => {
  const t = sign(keys.privateKey, { ...claims, chat: 'chat-b' });
  expect(verify(keys.publicKey, t, expectId)).toEqual({ ok: false, code: 'invalid' });
});

test('vencido: expired, justo en exp ya no vale', () => {
  const t = sign(keys.privateKey, claims);
  expect(verify(keys.publicKey, t, { ...expectId, now: claims.exp })).toEqual({ ok: false, code: 'expired' });
  expect(verify(keys.publicKey, t, { ...expectId, now: claims.exp - 1 }).ok).toBe(true);
});

test('un byte cambiado en payload o firma invalida el token', () => {
  const t = sign(keys.privateKey, claims);
  const flip = (s: string, i: number): string => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  expect(verify(keys.publicKey, flip(t, 3), expectId).ok).toBe(false);
  expect(verify(keys.publicKey, flip(t, t.length - 3), expectId).ok).toBe(false);
  expect(verify(keys.publicKey, `${t}=`, expectId).ok).toBe(false);
});

test('otra llave no verifica', () => {
  const other = generateKeyPairSync('ed25519');
  expect(verify(other.publicKey, sign(keys.privateKey, claims), expectId)).toEqual({ ok: false, code: 'invalid' });
});

test('signedVerifier: header firmado da la sesión; sin header, ajeno o vencido da Rejection', async () => {
  let now = NOW;
  const v = signedVerifier(keys.publicKey, 'chat-a', () => now);
  const session = { owner: 'user_1', scopes: new Set(['chat:read', 'spend'] as const) };
  const token = issueIdentity(keys.privateKey, session, 'chat-a', 60_000, () => now);

  const ok = await v.verify({ 'x-wt-identity': token });
  expect(isRejection(ok)).toBe(false);
  if (!isRejection(ok)) {
    expect(ok.owner).toBe('user_1');
    expect([...ok.scopes].sort()).toEqual(['chat:read', 'spend']);
  }
  expect(await v.verify({})).toEqual({ code: 'no-session' });
  expect(await signedVerifier(keys.publicKey, 'chat-b').verify({ 'x-wt-identity': token })).toEqual({ code: 'no-session' });
  now += 60_000;
  expect(await v.verify({ 'x-wt-identity': token })).toEqual({ code: 'expired' });
});

test('signedVerifier rechaza un scope que el runtime no conoce', async () => {
  const t = sign(keys.privateKey, { ...claims, scopes: ['chat:read', 'admin'] });
  expect(await signedVerifier(keys.publicKey, 'chat-a', () => NOW).verify({ 'x-wt-identity': t })).toEqual({ code: 'no-session' });
  expect(ALL_SCOPES.has('admin' as never)).toBe(false);
});

test("signedVerifier rechaza owner 'local' aunque la firma sea válida ('' ya no se puede firmar)", async () => {
  const t = sign(keys.privateKey, { ...claims, owner: 'local' });
  expect(await signedVerifier(keys.publicKey, 'chat-a', () => NOW).verify({ 'x-wt-identity': t })).toEqual({ code: 'no-session' });
});

test('un exp más lejos que el tope de su typ es invalid, aunque la firma sea buena', () => {
  const far = (typ: 'identity' | 'preview', ttl: number) => verify(keys.publicKey, sign(keys.privateKey, { ...claims, typ, exp: NOW + ttl }), { ...expectId, typ });
  expect(far('identity', 15 * 60_000).ok).toBe(true);
  expect(far('identity', 15 * 60_000 + 1)).toEqual({ ok: false, code: 'invalid' });
  expect(far('preview', 2 * 3_600_000).ok).toBe(true);
  expect(far('preview', 2 * 3_600_000 + 1)).toEqual({ ok: false, code: 'invalid' });
});

test('signedVerifier detrás de providerVerifier también cierra local; issueIdentity no firma local ni vacío', async () => {
  const v = providerVerifier(signedVerifier(keys.publicKey, 'chat-a', () => NOW));
  const t = sign(keys.privateKey, { ...claims, owner: 'local' });
  expect(await v.verify({ 'x-wt-identity': t })).toEqual({ code: 'no-session' });
  for (const owner of ['', 'local']) expect(() => issueIdentity(keys.privateKey, { owner, scopes: ALL_SCOPES }, 'chat-a', 60_000)).toThrow();
});

test('issueIdentity no emite con ttl mayor al tope ni no positivo', () => {
  const s = { owner: 'user_1', scopes: ALL_SCOPES };
  expect(() => issueIdentity(keys.privateKey, s, 'chat-a', MAX_TTL_MS.identity + 1)).toThrow();
  expect(() => issueIdentity(keys.privateKey, s, 'chat-a', 0)).toThrow();
  expect(() => issueIdentity(keys.privateKey, s, 'chat-a', MAX_TTL_MS.identity)).not.toThrow();
});

test('la sesión queda acotada al chat y el verifier no se construye con chat vacío', async () => {
  const t = issueIdentity(keys.privateKey, { owner: 'user_1', scopes: ALL_SCOPES }, 'chat-a', 60_000, () => NOW);
  const s = await signedVerifier(keys.publicKey, 'chat-a', () => NOW).verify({ 'x-wt-identity': t });
  expect(isRejection(s) ? undefined : [...(s.chats ?? [])]).toEqual(['chat-a']);
  expect(() => signedVerifier(keys.publicKey, '')).toThrow();
});

test('sign falla en el orquestador con claims inválidos', () => {
  expect(() => sign(keys.privateKey, { ...claims, owner: '' })).toThrow();
  expect(() => sign(keys.privateKey, { ...claims, exp: Number.POSITIVE_INFINITY })).toThrow();
});

test('llave que no es Ed25519 se rechaza; exp en segundos (unidad equivocada) es expired', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const t = sign(keys.privateKey, claims);
  expect(verify(rsa.publicKey, t, expectId)).toEqual({ ok: false, code: 'invalid' });
  expect(verify(ec.publicKey, t, expectId)).toEqual({ ok: false, code: 'invalid' });
  expect(() => sign(rsa.privateKey, claims)).toThrow();
  expect(verify(keys.publicKey, sign(keys.privateKey, { ...claims, exp: Math.floor(Date.now() / 1000) + 60 }), { ...expectId, now: Date.now() })).toEqual({ ok: false, code: 'expired' });
});

test("typ 'run': exige tope de vida de config y claim run; sin chat solo vale para run", () => {
  const t = sign(keys.privateKey, { ...claims, typ: 'run', run: 'msg-1' });
  expect(verify(keys.publicKey, t, { typ: 'run', now: NOW, maxTtlMs: 60_000 })).toMatchObject({ ok: true, claims: { run: 'msg-1' } });
  expect(verify(keys.publicKey, t, { typ: 'run', now: NOW })).toEqual({ ok: false, code: 'invalid' });
  expect(verify(keys.publicKey, t, { typ: 'run', now: NOW, maxTtlMs: 59_999 })).toEqual({ ok: false, code: 'invalid' });
  expect(verify(keys.publicKey, sign(keys.privateKey, claims), { typ: 'identity', now: NOW })).toEqual({ ok: false, code: 'invalid' });
  expect(() => sign(keys.privateKey, { ...claims, typ: 'run' })).toThrow('run');
});

test('maxTtlMs en identity/preview solo endurece el tope fijo, nunca lo afloja', () => {
  const t = sign(keys.privateKey, { ...claims, exp: NOW + 60_000 });
  expect(verify(keys.publicKey, t, { ...expectId, maxTtlMs: 59_999 })).toEqual({ ok: false, code: 'invalid' });
  expect(verify(keys.publicKey, t, { ...expectId, maxTtlMs: 60_000 }).ok).toBe(true);
  expect(verify(keys.publicKey, sign(keys.privateKey, { ...claims, typ: 'run', run: '' }), { typ: 'run', now: NOW, maxTtlMs: Number.POSITIVE_INFINITY })).toEqual({ ok: false, code: 'invalid' });
  const far = sign(keys.privateKey, { ...claims, exp: NOW + 16 * 60_000 });
  expect(verify(keys.publicKey, far, { ...expectId, maxTtlMs: 24 * 3_600_000 })).toEqual({ ok: false, code: 'invalid' });
});

// Token media (spec orquestador-enrutamiento §4): un recurso, un chat, 5 minutos; no vale como ningún otro tipo ni al revés.
test('token media: ida y vuelta, y solo abre su ruta, su chat y dentro de su vida', () => {
  const m: TokenClaims = { typ: 'media', owner: 'user_1', scopes: [], chat: 'chat-a', path: 'runs/m1/shots/a.png', exp: NOW + 60_000 };
  const t = sign(keys.privateKey, m);
  const ask = { typ: 'media', chat: 'chat-a', path: 'runs/m1/shots/a.png', now: NOW } as const;
  expect(verify(keys.publicKey, t, ask)).toEqual({ ok: true, claims: m });
  expect(verify(keys.publicKey, t, { ...ask, path: 'runs/m1/shots/b.png' })).toEqual({ ok: false, code: 'invalid' });
  expect(verify(keys.publicKey, t, { ...ask, chat: 'chat-b' })).toEqual({ ok: false, code: 'invalid' });
  expect(verify(keys.publicKey, t, { typ: 'media', chat: 'chat-a', now: NOW })).toEqual({ ok: false, code: 'invalid' });
  expect(verify(keys.publicKey, t, { ...ask, now: NOW + 60_001 })).toEqual({ ok: false, code: 'expired' });
  const long = sign(keys.privateKey, { ...m, exp: NOW + MAX_TTL_MS.media + 1 });
  expect(verify(keys.publicKey, long, ask)).toEqual({ ok: false, code: 'invalid' });
  expect(() => sign(keys.privateKey, { ...m, path: undefined })).toThrow('path');
});

test('un token media no vale como identidad, preview ni run, y esos no valen como media', () => {
  const media = sign(keys.privateKey, { typ: 'media', owner: 'user_1', scopes: ['chat:write'], chat: 'chat-a', path: 'p', exp: NOW + 60_000 });
  for (const typ of ['identity', 'preview'] as const) expect(verify(keys.publicKey, media, { typ, chat: 'chat-a', now: NOW }).ok).toBe(false);
  expect(verify(keys.publicKey, media, { typ: 'run', maxTtlMs: 3_600_000, now: NOW }).ok).toBe(false);
  for (const typ of ['identity', 'preview'] as const) {
    const other = sign(keys.privateKey, { ...claims, typ });
    expect(verify(keys.publicKey, other, { typ: 'media', chat: 'chat-a', path: 'p', now: NOW }).ok).toBe(false);
  }
});

test('el claim apps solo existe en un token run, con hasta 20 textos', () => {
  const keys = generateKeyPairSync('ed25519');
  const now = Date.now();
  const run = sign(keys.privateKey, { typ: 'run', owner: 'u', scopes: [], chat: 'c', run: '', exp: now + 60_000, apps: ['slack'] });
  const ok = verify(keys.publicKey, run, { typ: 'run', maxTtlMs: 3_600_000, now });
  expect(ok.ok && ok.claims.apps).toEqual(['slack']);
  const media = sign(keys.privateKey, { typ: 'media', owner: 'u', scopes: [], chat: 'c', path: 'p', exp: now + 60_000, apps: ['slack'] });
  expect(verify(keys.publicKey, media, { typ: 'media', chat: 'c', path: 'p', now }).ok).toBe(false);
  const many = sign(keys.privateKey, { typ: 'run', owner: 'u', scopes: [], chat: 'c', run: '', exp: now + 60_000, apps: Array.from({ length: 21 }, (_, i) => `a${i}`) });
  expect(verify(keys.publicKey, many, { typ: 'run', maxTtlMs: 3_600_000, now }).ok).toBe(false);
});

test('un token grant lleva call, tool y patterns; ningún otro tipo los lleva, y vence en lo que dice MAX_TTL_MS.grant', () => {
  const keys = generateKeyPairSync('ed25519');
  const now = Date.now();
  const grant = sign(keys.privateKey, { typ: 'grant', owner: 'u', scopes: [], chat: 'c', exp: now + 60_000, call: 'k1', tool: 'mcp__a__b', patterns: ['Tool(mcp__a__b:*)'], args: 'abc' });
  const ok = verify(keys.publicKey, grant, { typ: 'grant', chat: 'c', now });
  expect(ok.ok && [ok.claims.call, ok.claims.tool, ok.claims.patterns, ok.claims.args]).toEqual(['k1', 'mcp__a__b', ['Tool(mcp__a__b:*)'], 'abc']);
  expect(verify(keys.publicKey, grant, { typ: 'grant', chat: 'otro', now }).ok).toBe(false);
  expect(verify(keys.publicKey, grant, { typ: 'run', maxTtlMs: 3_600_000, now }).ok).toBe(false);
  const long = sign(keys.privateKey, { typ: 'grant', owner: 'u', scopes: [], chat: 'c', exp: now + MAX_TTL_MS.grant + 60_000, call: 'k1', tool: 'mcp__a__b', patterns: [], args: 'abc' });
  expect(verify(keys.publicKey, long, { typ: 'grant', chat: 'c', now }).ok).toBe(false);
  expect(() => sign(keys.privateKey, { typ: 'grant', owner: 'u', scopes: [], chat: 'c', exp: now + 1 })).toThrow();
  const stray = sign(keys.privateKey, { typ: 'identity', owner: 'u', scopes: [], chat: 'c', exp: now + 60_000, call: 'k1', tool: 't', patterns: [], args: 'abc' });
  expect(verify(keys.publicKey, stray, { typ: 'identity', chat: 'c', now }).ok).toBe(false);
});
