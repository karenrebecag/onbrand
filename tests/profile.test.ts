import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { REPO_ROOT, resolveConfig } from '../src/config';
import { orchestratorFromEnv, privateKeyFromEnv } from '../src/orchestrator/main';
import { buildAdapters, checkProfile, checkRegistrySource, loadProfile, setActiveProfile } from '../src/profile';

// ADR 0017: WT_PROFILE_MODULE carga un perfil externo con { defaults, adapters(env, role) }; un puerto roto o un módulo que no carga frenan el arranque.
const EJEMPLO = join(REPO_ROOT, 'tests', 'fixtures', 'profile-ejemplo.ts');
afterEach(() => setActiveProfile(undefined));

test('sin WT_PROFILE_MODULE corre el core; WT_PROFILE solo admite core y apunta al módulo', async () => {
  expect(await loadProfile({})).toBeUndefined();
  expect(resolveConfig({}).profile).toBe('core');
  expect(() => resolveConfig({ WT_PROFILE: 'acme' })).toThrow('WT_PROFILE_MODULE');
});

test('el perfil cargado pone sus defaults sobre los del core y el env explícito sigue ganando', async () => {
  await loadProfile({ WT_PROFILE_MODULE: EJEMPLO });
  const c = resolveConfig({});
  expect(c).toMatchObject({ profile: 'ejemplo', imageProvider: 'profile', enhancerProvider: 'gateway', transcribeProvider: 'gateway', publishProvider: 'local', builderOrigin: undefined, brandsRoot: join(REPO_ROOT, '..', 'packs-ejemplo') });
  const over = resolveConfig({ WT_IMAGE_PROVIDER: 'none', WT_BRANDS_ROOT: '/otra', WT_BUILDER_ORIGIN: 'https://b.test', WT_BRANDS_ROOT_X: '' });
  expect(over).toMatchObject({ imageProvider: 'none', brandsRoot: '/otra', builderOrigin: 'https://b.test' });
});

test('un módulo que no carga, que no exporta lo pedido o que trae claves ajenas frena el arranque nombrando la causa', async () => {
  await expect(loadProfile({ WT_PROFILE_MODULE: '/no/existe/perfil.ts' })).rejects.toThrow('WT_PROFILE_MODULE=/no/existe/perfil.ts no carga');
  expect(() => checkProfile({}, 'x')).toThrow('exporta defaults, adapters o ambos');
  expect(() => checkProfile({ defaults: { colorFavorito: 'rojo' } }, 'x')).toThrow('colorFavorito');
  expect(() => checkProfile({ adapters: 3 }, 'x')).toThrow('adapters debe ser una función');
  expect(() => checkProfile({ name: 'core', defaults: {} }, 'x')).toThrow('distinto de "core"');
});

test('un default con un valor fuera del enum falla al resolver', () => {
  const profile = checkProfile({ name: 'malo', defaults: { imageProvider: 'fal' } }, 'x');
  expect(() => resolveConfig({}, undefined, profile)).toThrow('defaults.imageProvider=fal');
});

test('los puertos del perfil se validan: uno desconocido o que no cumple su contrato frena el arranque', async () => {
  const profile = (await loadProfile({ WT_PROFILE_MODULE: EJEMPLO }))!;
  expect(Object.keys(buildAdapters(profile, {}, 'orchestrator')).sort()).toEqual(['authenticate', 'gateway', 'sandbox']);
  expect(Object.keys(buildAdapters(profile, {}, 'runtime')).sort()).toEqual(['facts', 'image', 'publish', 'registry', 'session']);
  const bad = (adapters: unknown) => buildAdapters({ name: 'p', adapters: () => adapters as never }, {}, 'orchestrator');
  expect(() => bad({ blobStore: {} })).toThrow('el puerto "blobStore" no existe');
  expect(() => bad({ sandbox: { ensure: () => undefined } })).toThrow('el puerto "sandbox" no cumple su contrato');
  expect(() => bad({ gateway: { priceOf: () => 0 } })).toThrow('el puerto "gateway" no cumple su contrato');
  expect(() => bad(null as never)).toThrow('debe devolver un objeto de puertos');
});

test('el perfil recibe el rol y un puerto del otro rol no llega a quien no lo usa', () => {
  const seen: string[] = [];
  const profile = { name: 'p', adapters: (_env: object, role: string) => { seen.push(role); return { authenticate: async () => ({ code: 'no-session' as const }), registry: async () => ({}) }; } };
  const rt = buildAdapters(profile as never, {}, 'runtime');
  expect(Object.keys(rt)).toEqual(['registry']);
  expect(Object.keys(buildAdapters(profile as never, {}, 'orchestrator'))).toEqual(['authenticate']);
  expect(seen).toEqual(['runtime', 'orchestrator']);
});

test('el orquestador no arranca sin los puertos del perfil ni sin una llave Ed25519 válida', async () => {
  const profile = (await loadProfile({ WT_PROFILE_MODULE: EJEMPLO }))!;
  const adapters = buildAdapters(profile, {}, 'orchestrator');
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  expect(() => orchestratorFromEnv({ WT_ORCH_PRIVATE_KEY: pem }, {})).toThrow('no aporta el puerto "gateway"');
  expect(() => orchestratorFromEnv({}, adapters)).toThrow('falta WT_ORCH_PRIVATE_KEY');
  expect(() => orchestratorFromEnv({ WT_ORCH_PRIVATE_KEY: 'no-es-pem' }, adapters)).toThrow('PEM privado válido');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  expect(() => privateKeyFromEnv({ WT_ORCH_PRIVATE_KEY: rsa })).toThrow('debe ser Ed25519');
  expect(() => orchestratorFromEnv({ WT_ORCH_PRIVATE_KEY: pem, PORT: 'abc', WT_BLOB_DIR: '/tmp/x' }, adapters)).toThrow('PORT=abc');
  const boot = orchestratorFromEnv({ WT_ORCH_PRIVATE_KEY: pem, PORT: '5999', WT_BLOB_DIR: join(REPO_ROOT, 'generated', 'orchestrator-blob-test') }, adapters);
  expect(boot.port).toBe(5999);
  // Sin sesión el orquestador responde 401: el perfil de ejemplo exige x-ejemplo-user.
  expect((await boot.fetch(new Request('https://orq.test/chats'))).status).toBe(401);
});

test('los defaults de ruta y origen se validan como texto y URL', () => {
  const bad = (defaults: object) => () => resolveConfig({}, undefined, { name: 'p', defaults: defaults as never });
  expect(bad({ brandsRoot: '' })).toThrow('defaults.brandsRoot');
  expect(bad({ brandsRoot: 3 })).toThrow('defaults.brandsRoot');
  expect(bad({ vaultRoot: 5 })).toThrow('defaults.vaultRoot');
  expect(bad({ builderOrigin: 'no es url' })).toThrow('defaults.builderOrigin');
  expect(bad({ builderOrigin: 'ftp://x.test' })).toThrow('defaults.builderOrigin');
  expect(resolveConfig({}, undefined, { name: 'p', defaults: { builderOrigin: 'https://b.test', vaultRoot: undefined } }).builderOrigin).toBe('https://b.test');
});

test('el orquestador escucha en loopback salvo que el despliegue pida otro host', async () => {
  const profile = (await loadProfile({ WT_PROFILE_MODULE: EJEMPLO }))!;
  const adapters = buildAdapters(profile, {}, 'orchestrator');
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const base = { WT_ORCH_PRIVATE_KEY: pem, WT_BLOB_DIR: join(REPO_ROOT, 'generated', 'orchestrator-blob-test') };
  expect(orchestratorFromEnv(base, adapters).host).toBe('127.0.0.1');
  expect(orchestratorFromEnv({ ...base, WT_ORCH_HOST: '0.0.0.0' }, adapters).host).toBe('0.0.0.0');
});

test('el registry del perfil se comprueba como un RegistrySource y los puertos nuevos tienen contrato', async () => {
  const profile = (await loadProfile({ WT_PROFILE_MODULE: EJEMPLO }))!;
  const reg = await buildAdapters(profile, {}, 'runtime').registry!();
  expect(checkRegistrySource(reg).pin).toBe('ejemplo');
  expect(() => checkRegistrySource({ ejemplo: true })).toThrow('RegistrySource');
  const bad = (adapters: unknown) => buildAdapters({ name: 'p', adapters: () => adapters as never }, {}, 'runtime');
  expect(() => bad({ publish: {} })).toThrow('el puerto "publish" no cumple su contrato');
  expect(() => bad({ image: { gen: () => undefined } })).toThrow('el puerto "image" no cumple su contrato');
  expect(() => bad({ session: {} })).toThrow('el puerto "session" no cumple su contrato');
  expect(() => bad({ gateway: { priceOf: () => 0, credential: async () => 'x', waitUntil: () => undefined } })).toThrow('el puerto "gateway" no cumple su contrato');
});

test('sin perfil el orquestador usa un IdP por JWT y la VM local; el gateway sigue siendo del perfil', async () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const env = { WT_ORCH_PRIVATE_KEY: pem, WT_JWT_ISSUER: 'https://idp.example.test', WT_JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(), WT_BLOB_DIR: join(REPO_ROOT, 'generated', 'orchestrator-blob-test') };
  const gateway = { priceOf: () => 0, credential: async () => 'Bearer x', waitUntil: () => undefined, upstream: async () => new Response('{}') };
  expect(() => orchestratorFromEnv(env, {})).toThrow('no aporta el puerto "gateway"');
  const boot = orchestratorFromEnv(env, { gateway });
  await boot.warm();
  const res = await boot.fetch(new Request('https://orq.test/chats'));
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
  expect(() => orchestratorFromEnv({ ...env, WT_JWT_ISSUER: '' }, { gateway })).toThrow('WT_JWT_ISSUER');
  expect(() => orchestratorFromEnv({ ...env, WT_ORCH_HOST: '0.0.0.0' }, { gateway })).toThrow('la VM local solo sirve en loopback');
});

test('un authenticate del perfil que devuelve el dueño local o vacío se rechaza como falta de sesión', async () => {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const gateway = { priceOf: () => 0, credential: async () => 'Bearer x', waitUntil: () => undefined, upstream: async () => new Response('{}') };
  for (const owner of ['local', '']) {
    const boot = orchestratorFromEnv({ WT_ORCH_PRIVATE_KEY: pem, WT_BLOB_DIR: join(REPO_ROOT, 'generated', 'orchestrator-blob-test') }, { gateway, authenticate: async () => ({ owner, scopes: new Set(['chat:read'] as const) }), sandbox: buildAdapters((await loadProfile({ WT_PROFILE_MODULE: EJEMPLO }))!, {}, 'orchestrator').sandbox! });
    expect((await boot.fetch(new Request('https://orq.test/chats'))).status).toBe(401);
  }
});

test('el prefijo del Blob sale solo de WT_BLOB_PREFIX (default wt/), no del nombre del perfil', async () => {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const written: string[] = [];
  const blob = {
    read: async () => undefined,
    create: async (p: string) => { written.push(p); return { etag: 'e1' }; },
    replace: async (p: string) => { written.push(p); return { etag: 'e2' }; },
    list: async () => [],
  };
  const adapters = { gateway: { priceOf: () => 0, credential: async () => 'Bearer x', waitUntil: () => undefined, upstream: async () => new Response('{}') }, blob, sandbox: buildAdapters((await loadProfile({ WT_PROFILE_MODULE: EJEMPLO }))!, {}, 'orchestrator').sandbox!, authenticate: async () => ({ owner: 'u', scopes: new Set(['chat:write'] as const) }) };
  const create = async (env: Record<string, string>) => {
    written.length = 0;
    const boot = orchestratorFromEnv({ WT_ORCH_PRIVATE_KEY: pem, ...env }, adapters);
    await boot.fetch(new Request('https://orq.test/chats', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    return written.slice();
  };
  expect((await create({})).every((p) => p.startsWith('wt/'))).toBe(true);
  const custom = await create({ WT_BLOB_PREFIX: 'qa/uno/' });
  expect(custom.length).toBeGreaterThan(0);
  expect(custom.every((p) => p.startsWith('qa/uno/'))).toBe(true);
});

test('el catálogo del perfil es un puerto del orquestador y sale por /models; WT_ORCH_STREAM_MAX_MS se valida', async () => {
  const { streamMaxFromEnv, DEFAULT_STREAM_MAX_MS } = await import('../src/orchestrator/main');
  expect(streamMaxFromEnv({})).toBe(DEFAULT_STREAM_MAX_MS);
  expect(streamMaxFromEnv({ WT_ORCH_STREAM_MAX_MS: '5000' })).toBe(5000);
  for (const bad of ['abc', '10', '1.5', '-1']) expect(() => streamMaxFromEnv({ WT_ORCH_STREAM_MAX_MS: bad }), bad).toThrow('WT_ORCH_STREAM_MAX_MS');
  const profile = { name: 'p', adapters: () => ({ catalog: { models: [{ id: 'a', name: 'A', provider: 'p' }], imageModels: [] } }) };
  expect(Object.keys(buildAdapters(profile as never, {}, 'orchestrator'))).toEqual(['catalog']);
  expect(Object.keys(buildAdapters(profile as never, {}, 'runtime'))).toEqual([]);
  expect(() => buildAdapters({ name: 'p', adapters: () => ({ catalog: { models: 3 } }) as never }, {}, 'orchestrator')).toThrow('el puerto "catalog" no cumple su contrato');
  expect(() => buildAdapters({ name: 'p', adapters: () => ({ catalog: { models: [{ id: 'a' }], imageModels: [] } }) as never }, {}, 'orchestrator')).toThrow('el puerto "catalog" no cumple su contrato');
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const gateway = { priceOf: () => 0, credential: async () => 'Bearer x', waitUntil: () => undefined, upstream: async () => new Response('{}') };
  const boot = orchestratorFromEnv({ WT_ORCH_PRIVATE_KEY: pem, WT_BLOB_DIR: join(REPO_ROOT, 'generated', 'orchestrator-blob-test') }, { gateway, catalog: { models: [{ id: 'a', name: 'A', provider: 'p' }], imageModels: [] }, authenticate: async () => ({ owner: 'u', scopes: new Set(['chat:read'] as const) }), sandbox: buildAdapters((await loadProfile({ WT_PROFILE_MODULE: EJEMPLO }))!, {}, 'orchestrator').sandbox! });
  expect(await (await boot.fetch(new Request('https://orq.test/models'))).json()).toMatchObject({ models: [{ id: 'a' }] });
});

test('puerto connectors: es del orquestador, exige sus cuatro funciones y la VM no lo recibe', () => {
  const port = { apps: async () => ({}), accounts: async () => ({}), connect: async () => ({}), disconnect: async () => true };
  const profile = { name: 'p', adapters: () => ({ connectors: port }) };
  expect(Object.keys(buildAdapters(profile as never, {}, 'orchestrator'))).toEqual(['connectors']);
  expect(buildAdapters(profile as never, {}, 'runtime')).toEqual({});
  expect(() => buildAdapters({ name: 'p', adapters: () => ({ connectors: { apps: async () => ({}) } }) as never }, {}, 'orchestrator')).toThrow('el puerto "connectors" no cumple su contrato');
});
