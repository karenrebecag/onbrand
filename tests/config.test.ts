import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { composeAgent, REPO_ROOT, resolveConfig } from '../src/config';

const HOME = '/home/x';

test('sin env, el perfil core no depende de ningún servicio ni de la máquina de Karen', () => {
  expect(resolveConfig({}, HOME)).toEqual({
    profile: 'core',
    composeProvider: 'cli',
    imageProvider: 'none',
    enhancerProvider: 'cli',
    vaultRoot: undefined,
    brandsRoot: join(REPO_ROOT, 'brands'),
    builderOrigin: 'http://localhost:5173',
    publishProvider: 'local',
    transcribeProvider: 'none',
    sessionProvider: 'local',
    scaffoldDir: join(REPO_ROOT, 'templates', 'base-scaffold'),
    agentSkillId: 'base-agent',
  });
});

// Los defaults de un perfil externo, su precedencia frente al env y el enum de WT_PROFILE viven en tests/profile.test.ts.
test('un env explícito gana al default del core; vacío cuenta como ausente', () => {
  const c = resolveConfig({ WT_COMPOSE_PROVIDER: 'gateway', WT_VAULT_ROOT: '/v', WT_BUILDER_ORIGIN: 'https://b.example', WT_BRANDS_ROOT: '' }, HOME);
  expect(c.composeProvider).toBe('gateway');
  expect(c.vaultRoot).toBe('/v');
  expect(c.builderOrigin).toBe('https://b.example');
  expect(c.brandsRoot).toBe(join(REPO_ROOT, 'brands'));
});

test('WT_IMAGE_PROVIDER=cli ya no existe: el generador de una distro entra por el puerto image', () => {
  expect(() => resolveConfig({ WT_IMAGE_PROVIDER: 'cli' }, HOME)).toThrow('WT_IMAGE_PROVIDER=cli');
});

test('un valor fuera del enum falla al resolver, nombrando la variable', () => {
  expect(() => resolveConfig({ WT_PROFILE: 'prod' }, HOME)).toThrow('WT_PROFILE=prod');
  expect(() => resolveConfig({ WT_IMAGE_PROVIDER: 'fal' }, HOME)).toThrow('WT_IMAGE_PROVIDER=fal');
});

// B9 paso 4: el id del skill arma rutas del registry (skills/<id>@<sha>.json) y del workspace; un id con / o .. no pasa.
test('WT_AGENT_SKILL solo acepta un id de skill; WT_SCAFFOLD_DIR y el skill de una distro ganan al del core', () => {
  for (const bad of ['../arc', 'a/b', 'Arc-Agent', 'x'.repeat(65)]) expect(() => resolveConfig({ WT_AGENT_SKILL: bad }, HOME)).toThrow('WT_AGENT_SKILL');
  const c = resolveConfig({ WT_AGENT_SKILL: 'arc-agent', WT_SCAFFOLD_DIR: '/s' }, HOME);
  expect([c.agentSkillId, c.scaffoldDir]).toEqual(['arc-agent', '/s']);
});

test('la config resuelta es inmutable', () => {
  expect(Object.isFrozen(resolveConfig({}, HOME))).toBe(true);
});

// C5 (decisión 5 de Karen, 2026-11-05): el agente es el único camino de compose. --fixture/--composer escriben archivos
// como el agente y corren por él; --runner/WT_COMPOSE_AGENT=0 los rechaza serve.ts con exit 2 (no se eligen aquí).
test('el agente es el único camino: composeAgent siempre es true', () => {
  expect(composeAgent([], {})).toBe(true);
  expect(composeAgent(['--fixture', 'snap'], {})).toBe(true);
  expect(composeAgent(['--composer', 'c.ts'], {})).toBe(true);
  expect(composeAgent(['--runner'], {})).toBe(true);
  expect(composeAgent([], { WT_COMPOSE_AGENT: '0' })).toBe(true);
});

test('el proveedor LLM de los call sites sale del seam: WT_COMPOSE_PROVIDER gana al perfil en los dos sentidos', async () => {
  const { agentDescribe } = await import('../src/runtime/server');
  const prev = { provider: process.env.WT_COMPOSE_PROVIDER };
  try {
    process.env.WT_COMPOSE_PROVIDER = 'gateway';
    await expect(agentDescribe()([], 'q', 1000)).rejects.toThrow('no está disponible');
    process.env.WT_COMPOSE_PROVIDER = 'cli';
    expect(resolveConfig(process.env, HOME).composeProvider).toBe('cli');
  } finally {
    for (const [k, v] of [['WT_COMPOSE_PROVIDER', prev.provider]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
