// Fase 5 (identidad-sesion.md §3): el adaptador JWT (cualquier IdP RS256 con JWKS), con un par RSA propio y sin red. Cubre la verificación
// (firma, iss, exp, azp, alg), el JWKS (rotación, edad, fallos), el arranque por env, el 401 por HTTP y que el core nunca
// recibe 'local'.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SCOPES_CLAIM as SCOPES_CLAIM, JWKS_HARD_MAX_AGE_MS, JWKS_MAX_AGE_MS, JWKS_RETRY_AFTER_ERROR_MS, jwtVerifier, jwtVerifierFromEnv } from '../src/adapters/jwt/verifier';
import { issueIdentity } from '../src/orchestrator/identity';
import { signedVerifier } from '../src/runtime/signed-verifier';
import { isRejection } from '../src/runtime/session';
import { Runtime } from '../src/runtime/server';

const ISSUER = 'https://idp.example.test';
const NOW = 1_800_000_000_000;
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey, publicKey } = rsa();
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

function jwt(claims: Record<string, unknown>, o: { key?: KeyObject; header?: Record<string, unknown> } = {}): string {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...o.header });
  const body = b64({ iss: ISSUER, sub: 'user_2abc', exp: NOW / 1000 + 60, nbf: NOW / 1000 - 5, azp: 'https://app.example.test', [SCOPES_CLAIM]: ['chat:read', 'chat:write'], ...claims });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), o.key ?? privateKey).toString('base64url')}`;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const pem = jwtVerifier({ issuer: ISSUER, keys: { kind: 'pem', key: publicKey }, authorizedParties: ['https://app.example.test'], now: () => NOW });

describe('jwtVerifier', () => {
  test('un token válido da el dueño de sub y sus scopes, sin alcance de chats', async () => {
    const s = await pem.verify(bearer(jwt({})));
    expect(isRejection(s) ? s : { owner: s.owner, scopes: [...s.scopes].sort(), chats: s.chats }).toEqual({ owner: 'user_2abc', scopes: ['chat:read', 'chat:write'], chats: undefined });
  });

  test('otro issuer, otra firma, alg distinto de RS256, azp ajeno o scope desconocido: no-session; vencido: expired', async () => {
    const other = rsa().privateKey;
    const hs = (() => { const t = jwt({}).split('.'); return `${b64({ alg: 'HS256', kid: 'k1' })}.${t[1]}.${t[2]}`; })();
    const none = `${b64({ alg: 'none' })}.${jwt({}).split('.')[1]}.`;
    for (const t of [jwt({ iss: 'https://evil.test' }), jwt({}, { key: other }), hs, none, jwt({ azp: 'https://evil.test' }), jwt({ [SCOPES_CLAIM]: ['admin'] }), jwt({ sub: '' })]) {
      expect(await pem.verify(bearer(t))).toEqual({ code: 'no-session' });
    }
    expect(await pem.verify(bearer(jwt({ exp: NOW / 1000 - 10 })))).toEqual({ code: 'expired' });
    expect(await pem.verify({})).toEqual({ code: 'no-session' });
    expect(await pem.verify({ authorization: `Basic ${jwt({})}` })).toEqual({ code: 'no-session' });
  });

  test('un header con crit (extensión crítica desconocida, RFC 7515 §4.1.11) no entra aunque la firma valga', async () => {
    expect(await pem.verify(bearer(jwt({}, { header: { crit: ['b64'], b64: false } })))).toEqual({ code: 'no-session' });
  });

  test("sub 'local' nunca llega al core como dueño", async () => {
    expect(await pem.verify(bearer(jwt({ sub: 'local' })))).toEqual({ code: 'no-session' });
  });

  test('sin el claim de scopes la sesión no tiene ninguno (403 por acción), no todos', async () => {
    const s = await pem.verify(bearer(jwt({ [SCOPES_CLAIM]: undefined })));
    expect(!isRejection(s) && s.scopes.size).toBe(0);
  });

  test('JWKS: un kid nuevo refresca una vez por minuto como mucho; la llave rotada entra en el refresco siguiente', async () => {
    const rotated = rsa();
    let now = NOW;
    let served = [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }];
    const calls: string[] = [];
    const fake = (async (url: string) => { calls.push(url); return Response.json({ keys: served }); }) as unknown as typeof fetch;
    const v = jwtVerifier({ issuer: ISSUER, keys: { kind: 'jwks', url: 'https://idp.example.test/.well-known/jwks.json', fetch: fake }, now: () => now });
    expect(isRejection(await v.verify(bearer(jwt({}))))).toBe(false);
    expect(isRejection(await v.verify(bearer(jwt({}))))).toBe(false);
    served = [...served, { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'k2', alg: 'RS256', use: 'sig' }];
    const k2 = jwt({}, { key: rotated.privateKey, header: { kid: 'k2' } });
    expect(await v.verify(bearer(k2))).toEqual({ code: 'no-session' });
    expect(calls).toEqual(['https://idp.example.test/.well-known/jwks.json']);
    now += 60_000;
    expect(isRejection(await v.verify(bearer(k2)))).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

const jwk = (k: KeyObject, kid: string) => ({ ...k.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
/** JWKS falso: sirve lo que diga `next()` y cuenta las llamadas. */
function fakeJwks(next: () => Response) {
  let calls = 0;
  const fetchJwks = (async () => { calls++; return next(); }) as unknown as typeof fetch;
  return { fetchJwks, calls: () => calls };
}

describe('JWKS (security-reviewer fila 5)', () => {
  test('M1: una llave que el IdP retira deja de valer al pasar la edad máxima aunque nadie mande un kid nuevo', async () => {
    let now = NOW;
    let keys = [jwk(publicKey, 'k1')];
    const j = fakeJwks(() => Response.json({ keys }));
    const v = jwtVerifier({ issuer: ISSUER, keys: { kind: 'jwks', url: 'https://x.test/jwks', fetch: j.fetchJwks }, now: () => now });
    expect(isRejection(await v.verify(bearer(jwt({ exp: NOW / 1000 + 3600 }))))).toBe(false);
    keys = [jwk(rsa().publicKey, 'k9')];
    now += JWKS_MAX_AGE_MS;
    expect(await v.verify(bearer(jwt({ exp: NOW / 1000 + 3600 })))).toEqual({ code: 'no-session' });
  });

  test('M2: un JWKS vacío no borra las llaves buenas, y tras un 5xx se reintenta pronto y se registra el motivo', async () => {
    let now = NOW;
    let next = (): Response => new Response('boom', { status: 503 });
    const errors: string[] = [];
    const j = fakeJwks(() => next());
    const v = jwtVerifier({ issuer: ISSUER, keys: { kind: 'jwks', url: 'https://x.test/jwks', fetch: j.fetchJwks }, now: () => now, onError: (m) => errors.push(m) });
    expect(await v.verify(bearer(jwt({})))).toEqual({ code: 'no-session' });
    expect(errors).toEqual(['jwt: JWKS 503']);
    next = () => Response.json({ keys: [jwk(publicKey, 'k1')] });
    now += JWKS_RETRY_AFTER_ERROR_MS;
    expect(isRejection(await v.verify(bearer(jwt({}))))).toBe(false);
    next = () => Response.json({ keys: [] });
    now += JWKS_MAX_AGE_MS;
    expect(isRejection(await v.verify(bearer(jwt({ exp: now / 1000 + 60 }))))).toBe(false);
    expect(errors.at(-1)).toBe('jwt: JWKS sin llaves RSA de firma válidas');
  });

  test('warm: el arranque falla si el JWKS no trae llaves válidas; con llaves pasa', async () => {
    const bad = jwtVerifier({ issuer: ISSUER, keys: { kind: 'jwks', url: 'https://x.test/jwks', fetch: fakeJwks(() => Response.json({ keys: [] })).fetchJwks } });
    await expect(bad.warm()).rejects.toThrow('JWKS');
    const good = jwtVerifier({ issuer: ISSUER, keys: { kind: 'jwks', url: 'https://x.test/jwks', fetch: fakeJwks(() => Response.json({ keys: [jwk(publicKey, 'k1')] })).fetchJwks } });
    await good.warm();
  });
});

describe('JWKS, segunda revisión', () => {
  test('un cuerpo que pasa el tope se corta al leer, aunque no traiga content-length', async () => {
    const errors: string[] = [];
    const huge = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024)); } });
    const v = jwtVerifier({ issuer: ISSUER, keys: { kind: 'jwks', url: 'https://x.test/jwks', fetch: fakeJwks(() => new Response(huge)).fetchJwks }, onError: (m) => errors.push(m) });
    await expect(v.warm()).rejects.toThrow('JWKS');
    expect(errors).toEqual(['jwt: JWKS demasiado grande']);
  });

  test('con el JWKS caído la caché sirve, pero no pasado el tope duro de edad', async () => {
    let now = NOW;
    let next = (): Response => Response.json({ keys: [jwk(publicKey, 'k1')] });
    const v = jwtVerifier({ issuer: ISSUER, keys: { kind: 'jwks', url: 'https://x.test/jwks', fetch: fakeJwks(() => next()).fetchJwks }, now: () => now, onError: () => {} });
    const fresh = () => jwt({ exp: now / 1000 + 60, nbf: now / 1000 });
    expect(isRejection(await v.verify(bearer(fresh())))).toBe(false);
    next = () => new Response('caído', { status: 503 });
    now += JWKS_MAX_AGE_MS;
    expect(isRejection(await v.verify(bearer(fresh())))).toBe(false);
    now = NOW + JWKS_HARD_MAX_AGE_MS;
    expect(await v.verify(bearer(fresh()))).toEqual({ code: 'no-session' });
  });

  test('con audiencia configurada, un token para otra aud no entra', async () => {
    const v = jwtVerifier({ issuer: ISSUER, keys: { kind: 'pem', key: publicKey }, audience: ['onbrand'], now: () => NOW });
    expect(isRejection(await v.verify(bearer(jwt({ aud: ['otra', 'onbrand'] }))))).toBe(false);
    expect(await v.verify(bearer(jwt({ aud: 'otra' })))).toEqual({ code: 'no-session' });
    expect(await v.verify(bearer(jwt({})))).toEqual({ code: 'no-session' });
  });
});

describe('jwtVerifierFromEnv', () => {
  const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\n/g, '\\n');
  test('sin WT_JWT_ISSUER o sin llave no arranca; una privada, un issuer http o una llave no RSA tampoco', () => {
    expect(() => jwtVerifierFromEnv({ WT_JWT_PUBLIC_KEY: PEM })).toThrow('WT_JWT_ISSUER');
    expect(() => jwtVerifierFromEnv({ WT_JWT_ISSUER: ISSUER })).toThrow('WT_JWT_PUBLIC_KEY');
    expect(() => jwtVerifierFromEnv({ WT_JWT_ISSUER: 'http://idp.example.test', WT_JWT_PUBLIC_KEY: PEM })).toThrow('https');
    expect(() => jwtVerifierFromEnv({ WT_JWT_ISSUER: ISSUER, WT_JWT_PUBLIC_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })).toThrow('privada');
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => jwtVerifierFromEnv({ WT_JWT_ISSUER: ISSUER, WT_JWT_PUBLIC_KEY: ed })).toThrow('RSA');
    expect(() => jwtVerifierFromEnv({ WT_JWT_ISSUER: ISSUER, WT_JWT_JWKS_URL: 'http://x.test/jwks' })).toThrow('https');
  });

  test('L5: sin WT_JWT_AUTHORIZED_PARTIES el arranque avisa que no se comprueba azp', () => {
    const logs: string[] = [];
    jwtVerifierFromEnv({ WT_JWT_ISSUER: ISSUER, WT_JWT_PUBLIC_KEY: PEM }, (m) => logs.push(m));
    expect(logs.join()).toContain('WT_JWT_AUTHORIZED_PARTIES');
    const quiet: string[] = [];
    jwtVerifierFromEnv({ WT_JWT_ISSUER: ISSUER, WT_JWT_PUBLIC_KEY: PEM, WT_JWT_AUTHORIZED_PARTIES: 'https://app.example.test' }, (m) => quiet.push(m));
    expect(quiet).toEqual([]);
  });
});

describe('JWT por HTTP y puente a la VM', () => {
  let tmp: string;
  let server: Server | undefined;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'jwt-')); mkdirSync(join(tmp, 'vault')); mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true }); writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '\n'); });
  afterEach(() => { server?.close(); rmSync(tmp, { recursive: true, force: true }); });

  test('el runtime con el adaptador: token válido pasa; otro issuer, vencido o sub local son 401', async () => {
    const live = jwtVerifier({ issuer: ISSUER, keys: { kind: 'pem', key: publicKey }, now: () => NOW });
    const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose: async () => ({ sections: [] }), build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), session: live });
    server = t.listen(0);
    await new Promise((r) => server!.once('listening', r));
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}/brands`;
    expect((await fetch(at, { headers: bearer(jwt({})) })).status).toBe(200);
    for (const bad of [jwt({ iss: 'https://evil.test' }), jwt({ sub: 'local' })]) expect((await fetch(at, { headers: bearer(bad) })).status).toBe(401);
    const expired = await fetch(at, { headers: bearer(jwt({ exp: NOW / 1000 - 10 })) });
    expect([expired.status, expired.headers.get('www-authenticate')]).toEqual([401, 'Bearer error="invalid_token"']);
  });

  // El orquestador recibe `authenticate` inyectado (este verifier) y firma con issueIdentity hacia la VM, que sigue en 'signed'.
  test('puente: la sesión verificada se firma como x-wt-identity y la VM la acepta con el mismo dueño y scopes', async () => {
    const ed = generateKeyPairSync('ed25519');
    const chat = 'c'.repeat(32);
    const session = await pem.verify(bearer(jwt({})));
    if (isRejection(session)) throw new Error('rechazado');
    const identity = issueIdentity(ed.privateKey, session, chat, 60_000, () => NOW);
    const vm = await signedVerifier(ed.publicKey, chat, () => NOW).verify({ 'x-wt-identity': identity });
    expect(isRejection(vm) ? vm : { owner: vm.owner, scopes: [...vm.scopes].sort() }).toEqual({ owner: 'user_2abc', scopes: ['chat:read', 'chat:write'] });
  });
});

test('WT_JWT_SCOPES_CLAIM cambia el claim de donde salen los scopes', async () => {
  const PEMX = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const v = jwtVerifierFromEnv({ WT_JWT_ISSUER: ISSUER, WT_JWT_PUBLIC_KEY: PEMX, WT_JWT_AUTHORIZED_PARTIES: 'https://app.example.test', WT_JWT_SCOPES_CLAIM: 'perms' }, () => {});
  const t = jwt({ [SCOPES_CLAIM]: undefined, perms: ['spend'], exp: Date.now() / 1000 + 60, nbf: undefined });
  const s = await v.verify(bearer(t));
  expect(isRejection(s) ? s : [...s.scopes]).toEqual(['spend']);
});
