// Cargador de perfil externo (ADR 0017): `WT_PROFILE_MODULE` apunta a un módulo que exporta `{ defaults, adapters(env) }`. El core no
// conoce ningún perfil por nombre; una distro (repo aparte) aporta el suyo. Sin la variable corre el core, sin cuentas ni servicios.
// Aquí solo se carga y se valida; quien arranca (serve.ts, el orquestador) pasa los adaptadores a cada puerto.

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BlobClient } from './orchestrator/chat-index';
import type { OrchestratorAppDeps } from './orchestrator/app';
import type { Catalog, ConnectorsPort } from './orchestrator/routes';
import type { SandboxProvider } from './orchestrator/sandbox';
import type { RuntimeOptions } from './runtime/shared';
import type { PublishProvider } from './runtime/publish';
import type { RegistrySource } from './runtime/registry-source';
import type { SessionVerifier } from './runtime/session';
import type { AssetRule, FactsSource } from './brand-facts-source';
import type { Config } from './config';

/** Los puertos que un perfil puede enchufar. Todos opcionales: lo que no trae, lo cubre el core. */
export interface ProfileAdapters {
  /** Quién es la persona detrás de un request del orquestador (Clerk u otro). */
  readonly authenticate?: OrchestratorAppDeps['authenticate'];
  readonly sandbox?: SandboxProvider;
  readonly blob?: BlobClient;
  /** Precio, credencial y upstream del proxy de Gateway. */
  readonly gateway?: OrchestratorAppDeps['gateway'];
  /** Fuente de hechos de la marca (`serve --facts <base>`): construye las opciones del transport. */
  readonly facts?: (base: string) => { factsSources: Record<string, FactsSource>; factsAssets: readonly AssetRule[] };
  /** Registry del DS que sustituye al de `registry/` en disco (`serve --registry`); recibe el pin de la versión. */
  readonly registry?: (pin?: string) => Promise<RegistrySource>;
  /** Modelos de texto e imagen que ofrece el builder (`/models`, `/image-models`); el orquestador los sirve sin despertar una VM. */
  readonly catalog?: Catalog;
  /** Cuentas de apps del dueño (Pipedream u otro), atendidas por el orquestador: la credencial no entra en la VM. */
  readonly connectors?: ConnectorsPort;
  /** Destino del publish (`publishProvider: 'profile'`). */
  readonly publish?: PublishProvider;
  /** Generador de imágenes del paso de imagen (`imageProvider: 'profile'`). */
  readonly image?: NonNullable<RuntimeOptions['imageService']> & { readonly models: NonNullable<RuntimeOptions['imageModels']> };
  /** Quién es la persona detrás de un request de la VM (`sessionProvider: 'profile'`). */
  readonly session?: SessionVerifier;
}

/** Lo que exporta el módulo del perfil. `defaults` es parcial sobre la configuración del core; el env siempre gana. */
export interface ProfileModule {
  readonly name?: string;
  readonly defaults?: Partial<Omit<Config, 'profile'>>;
  /** `role` dice quién pregunta: la VM del chat ('runtime') o el orquestador. Construye solo los puertos de ese rol: el código de
   * un puerto del orquestador no debe correr dentro de la VM, que comparte proceso con el código que escribe el agente. */
  readonly adapters?: (env: Readonly<Record<string, string | undefined>>, role: ProfileRole) => ProfileAdapters;
}

export type ProfileRole = 'runtime' | 'orchestrator';
/** Qué proceso usa cada puerto. */
export const PORT_ROLE: Readonly<Record<keyof ProfileAdapters, ProfileRole>> = {
  authenticate: 'orchestrator', sandbox: 'orchestrator', blob: 'orchestrator', gateway: 'orchestrator', catalog: 'orchestrator', connectors: 'orchestrator',
  facts: 'runtime', registry: 'runtime', publish: 'runtime', image: 'runtime', session: 'runtime',
};

let active: ProfileModule | undefined;
export const activeProfile = (): ProfileModule | undefined => active;
/** Solo para tests y para el arranque que ya cargó el módulo. */
export function setActiveProfile(profile: ProfileModule | undefined): void { active = profile; }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasFns = (v: unknown, names: readonly string[]): boolean => isObject(v) && names.every((n) => typeof v[n] === 'function');
const DEFAULT_KEYS: readonly string[] = ['composeProvider', 'imageProvider', 'enhancerProvider', 'vaultRoot', 'brandsRoot', 'builderOrigin', 'publishProvider', 'transcribeProvider', 'sessionProvider', 'scaffoldDir', 'agentSkillId'];

/** Valida la forma del módulo; lanza nombrando qué falta. No valida los valores de `defaults` (los comprueba resolveConfig con los enums). */
export function checkProfile(mod: unknown, source: string): ProfileModule {
  if (!isObject(mod)) throw new Error(`perfil ${source}: el módulo no exporta nada`);
  const { name, defaults, adapters } = mod;
  if (name !== undefined && (typeof name !== 'string' || name === '' || name === 'core')) throw new Error(`perfil ${source}: name debe ser un texto distinto de "core"`);
  if (defaults !== undefined) {
    if (!isObject(defaults)) throw new Error(`perfil ${source}: defaults debe ser un objeto`);
    const unknown = Object.keys(defaults).filter((k) => !DEFAULT_KEYS.includes(k));
    if (unknown.length) throw new Error(`perfil ${source}: defaults trae claves que la configuración no tiene: ${unknown.join(', ')}`);
  }
  if (adapters !== undefined && typeof adapters !== 'function') throw new Error(`perfil ${source}: adapters debe ser una función (env, role) => puertos`);
  if (defaults === undefined && adapters === undefined) throw new Error(`perfil ${source}: exporta defaults, adapters o ambos`);
  return { ...(name === undefined ? {} : { name: name as string }), ...(defaults === undefined ? {} : { defaults: defaults as ProfileModule['defaults'] }), ...(adapters === undefined ? {} : { adapters: adapters as ProfileModule['adapters'] }) };
}

/** Construye los puertos del perfil y comprueba que cada uno cumple su contrato; un puerto roto o desconocido frena el arranque. */
export function buildAdapters(profile: ProfileModule | undefined, env: Readonly<Record<string, string | undefined>>, role: ProfileRole): ProfileAdapters {
  if (!profile?.adapters) return {};
  const a: unknown = profile.adapters(env, role);
  const who = `perfil ${profile.name ?? 'externo'}`;
  if (!isObject(a)) throw new Error(`${who}: adapters(env) debe devolver un objeto de puertos`);
  const checks: Record<string, (v: unknown) => boolean> = {
    authenticate: (v) => typeof v === 'function',
    sandbox: (v) => hasFns(v, ['ensure', 'keepAlive', 'snapshot', 'stop']),
    blob: (v) => hasFns(v, ['read', 'create', 'replace', 'list']),
    gateway: (v) => hasFns(v, ['priceOf', 'credential', 'upstream', 'waitUntil']),
    facts: (v) => typeof v === 'function',
    registry: (v) => typeof v === 'function',
    catalog: (v) => isObject(v) && [v.models, v.imageModels].every((l) => Array.isArray(l) && l.every((m) => isObject(m) && ['id', 'name', 'provider'].every((k) => typeof m[k] === 'string'))),
    connectors: (v) => hasFns(v, ['apps', 'accounts', 'connect', 'disconnect']) && ['mcp', 'forward'].every((n) => (v as Record<string, unknown>)[n] === undefined || typeof (v as Record<string, unknown>)[n] === 'function'),
    publish: (v) => hasFns(v, ['publish']),
    image: (v) => hasFns(v, ['gen']) && Array.isArray((v as { models?: unknown }).models),
    session: (v) => hasFns(v, ['verify']),
  };
  for (const [port, value] of Object.entries(a)) {
    const check = checks[port];
    if (!check) throw new Error(`${who}: el puerto "${port}" no existe (puertos: ${Object.keys(checks).join(', ')})`);
    if (value !== undefined && !check(value)) throw new Error(`${who}: el puerto "${port}" no cumple su contrato`);
  }
  // Un puerto del otro rol se descarta aunque el perfil lo haya construido: no llega a quien no lo usa.
  return Object.fromEntries(Object.entries(a).filter(([port]) => PORT_ROLE[port as keyof ProfileAdapters] === role)) as ProfileAdapters;
}

/** El registry que devuelve el puerto `registry`: se comprueba al abrirlo, porque el puerto es una función y su contrato está en lo que resuelve. */
export function checkRegistrySource(v: unknown, who = 'perfil'): RegistrySource {
  if (!isObject(v) || typeof v.pin !== 'string' || !hasFns(v, ['loadIndex', 'getItem', 'makeSchemaStore'])) {
    throw new Error(`${who}: el puerto "registry" debe resolver un RegistrySource (pin, loadIndex, getItem, makeSchemaStore)`);
  }
  return v as unknown as RegistrySource;
}

/** Carga WT_PROFILE_MODULE (ruta de archivo o paquete) y lo deja activo. Sin la variable no hace nada. Lanza si no carga o no cumple. */
export async function loadProfile(env: Readonly<Record<string, string | undefined>>): Promise<ProfileModule | undefined> {
  const spec = env.WT_PROFILE_MODULE?.trim();
  if (!spec) { active = undefined; return undefined; }
  const target = spec.startsWith('.') || isAbsolute(spec) ? pathToFileURL(resolve(spec)).href : spec;
  let mod: unknown;
  try { mod = await import(target); } catch (e) { throw new Error(`WT_PROFILE_MODULE=${spec} no carga: ${e instanceof Error ? e.message : String(e)}`); }
  active = checkProfile(mod, spec);
  return active;
}
