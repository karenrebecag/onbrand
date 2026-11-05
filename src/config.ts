// Seam único de configuración. `core` (default) es el clon limpio: corre con `git clone` + bun + el CLI `claude`,
// sin cuentas ni servicios de terceros. Una distro aporta su perfil por WT_PROFILE_MODULE (src/profile.ts): sus `defaults`
// van sobre los del core y un env explícito siempre gana a ambos, para que una variante no obligue a cambiar código. El proveedor LLM (infer, visión, catálogo de modelos) ya sale de aquí; el vault migra en un PR aparte.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeProfile, type ProfileModule } from './profile';

/** Solo el core se nombra aquí; un perfil de distro entra por WT_PROFILE_MODULE (src/profile.ts) y su nombre es el de su módulo. */
export const PROFILES = ['core'] as const;
export type Profile = string;

export const COMPOSE_PROVIDERS = ['cli', 'gateway'] as const;
export type ComposeProvider = (typeof COMPOSE_PROVIDERS)[number];

/** `profile`: el generador lo aporta el puerto `image` del perfil (src/profile.ts); sin ese puerto el arranque falla. */
export const IMAGE_PROVIDERS = ['none', 'profile', 'gateway'] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

export const ENHANCER_PROVIDERS = COMPOSE_PROVIDERS;
export type EnhancerProvider = ComposeProvider;

/** `profile`: el destino lo aporta el puerto `publish` del perfil; sin ese puerto el arranque falla. */
export const PUBLISH_PROVIDERS = ['local', 'profile'] as const;
export type PublishProvider = (typeof PUBLISH_PROVIDERS)[number];

/** `none` en core: el CLI local no transcribe, así el builder no monta el micrófono. `gateway` sirve whisper por AI Gateway. */
export const TRANSCRIBE_PROVIDERS = ['none', 'gateway'] as const;
export type TranscribeProvider = (typeof TRANSCRIBE_PROVIDERS)[number];

/** Quién dice quién es la persona (docs/spec/identidad-sesion.md §3). `local` = loopback, un solo dueño; `signed` = VM bajo el
 * orquestador, que verifica `x-wt-identity` con la llave pública (deploy-sandbox.md §4); `jwt` = verifier por JWKS/PEM de
 * cualquier IdP (src/adapters/jwt), solo se importa en el cableado (scripts/serve.ts); `profile` = el puerto `session` del perfil. */
export const SESSION_PROVIDERS = ['local', 'signed', 'jwt', 'profile'] as const;
export type SessionProvider = (typeof SESSION_PROVIDERS)[number];

export interface Config {
  readonly profile: Profile;
  readonly composeProvider: ComposeProvider;
  readonly imageProvider: ImageProvider;
  readonly enhancerProvider: EnhancerProvider;
  /** undefined en core: el DS viaja dentro del repo y nada debe leer una ruta de la máquina de Karen. */
  readonly vaultRoot: string | undefined;
  readonly brandsRoot: string;
  /** undefined cuando el perfil lo pide: el origen del deploy no tiene un default sensato y se exige explícito. */
  readonly builderOrigin: string | undefined;
  readonly publishProvider: PublishProvider;
  readonly transcribeProvider: TranscribeProvider;
  readonly sessionProvider: SessionProvider;
  /** El scaffold que se copia en cada ws: el DS base en core (B9 §3); una distro pone el suyo. */
  readonly scaffoldDir: string;
  /** El skill del agente que se pide al registry: `base-agent` en core; una distro pone el de su DS. */
  readonly agentSkillId: string;
}

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

type Env = Readonly<Record<string, string | undefined>>;

const CORE_DEFAULTS: Config = {
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
};

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === '') return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name}=${value} no es válido; usa ${allowed.join(' | ')}`);
}

const nonEmpty = (v: string | undefined): string | undefined => (v ? v : undefined);

// El id del skill arma rutas del registry (skills/<id>@<sha>.json) y del workspace: solo slug, sin / ni ..
export const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
function skillId(name: string, v: string | undefined): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (!SKILL_ID.test(v)) throw new Error(`${name}=${v} no es válido; un id de skill es [a-z0-9-], hasta 64`);
  return v;
}

/** Los defaults del perfil externo sobre los del core, con los mismos enums que el env: un valor inválido falla al resolver. */
function text(name: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v === '') throw new Error(`defaults.${name} debe ser un texto no vacío`);
  return v;
}
function origin(v: unknown): string | undefined {
  const t = text('builderOrigin', v);
  if (t === undefined) return undefined;
  try { const u = new URL(t); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocolo'); } catch { throw new Error(`defaults.builderOrigin=${t} debe ser una URL http(s)`); }
  return t;
}

function baseOf(profile: ProfileModule | undefined): Config {
  const d = profile?.defaults;
  if (!d) return CORE_DEFAULTS;
  return {
    ...CORE_DEFAULTS,
    profile: profile?.name ?? 'externo',
    ...(d.composeProvider === undefined ? {} : { composeProvider: oneOf('defaults.composeProvider', d.composeProvider, COMPOSE_PROVIDERS)! }),
    ...(d.imageProvider === undefined ? {} : { imageProvider: oneOf('defaults.imageProvider', d.imageProvider, IMAGE_PROVIDERS)! }),
    ...(d.enhancerProvider === undefined ? {} : { enhancerProvider: oneOf('defaults.enhancerProvider', d.enhancerProvider, ENHANCER_PROVIDERS)! }),
    ...(d.publishProvider === undefined ? {} : { publishProvider: oneOf('defaults.publishProvider', d.publishProvider, PUBLISH_PROVIDERS)! }),
    ...(d.transcribeProvider === undefined ? {} : { transcribeProvider: oneOf('defaults.transcribeProvider', d.transcribeProvider, TRANSCRIBE_PROVIDERS)! }),
    ...(d.sessionProvider === undefined ? {} : { sessionProvider: oneOf('defaults.sessionProvider', d.sessionProvider, SESSION_PROVIDERS)! }),
    ...('vaultRoot' in d ? { vaultRoot: text('vaultRoot', d.vaultRoot) } : {}),
    ...(d.brandsRoot === undefined ? {} : { brandsRoot: text('brandsRoot', d.brandsRoot)! }),
    ...('builderOrigin' in d ? { builderOrigin: origin(d.builderOrigin) } : {}),
    ...(d.scaffoldDir === undefined ? {} : { scaffoldDir: text('scaffoldDir', d.scaffoldDir)! }),
    ...(d.agentSkillId === undefined ? {} : { agentSkillId: skillId('defaults.agentSkillId', text('agentSkillId', d.agentSkillId))! }),
  };
}

/** Pura: mismo env y mismo perfil, misma config. Un valor inválido falla al arrancar, no a mitad de un turno. */
export function resolveConfig(env: Env, _home: string = homedir(), profile: ProfileModule | undefined = activeProfile()): Config {
  // El perfil de una distro ya no se elige por nombre aquí: WT_PROFILE solo admite 'core' y apunta a WT_PROFILE_MODULE para lo demás.
  if (env.WT_PROFILE !== undefined && env.WT_PROFILE !== '' && env.WT_PROFILE !== 'core') {
    throw new Error(`WT_PROFILE=${env.WT_PROFILE} no es válido; el core solo conoce core. Un perfil de distro se carga con WT_PROFILE_MODULE=<ruta o paquete>`);
  }
  const base = baseOf(profile);
  return Object.freeze({
    profile: base.profile,
    composeProvider: oneOf('WT_COMPOSE_PROVIDER', env.WT_COMPOSE_PROVIDER, COMPOSE_PROVIDERS) ?? base.composeProvider,
    imageProvider: oneOf('WT_IMAGE_PROVIDER', env.WT_IMAGE_PROVIDER, IMAGE_PROVIDERS) ?? base.imageProvider,
    enhancerProvider: oneOf('WT_ENHANCER_PROVIDER', env.WT_ENHANCER_PROVIDER, ENHANCER_PROVIDERS) ?? base.enhancerProvider,
    vaultRoot: nonEmpty(env.WT_VAULT_ROOT) ?? base.vaultRoot,
    brandsRoot: nonEmpty(env.WT_BRANDS_ROOT) ?? base.brandsRoot,
    builderOrigin: nonEmpty(env.WT_BUILDER_ORIGIN) ?? base.builderOrigin,
    publishProvider: oneOf('WT_PUBLISH_PROVIDER', env.WT_PUBLISH_PROVIDER, PUBLISH_PROVIDERS) ?? base.publishProvider,
    transcribeProvider: oneOf('WT_TRANSCRIBE_PROVIDER', env.WT_TRANSCRIBE_PROVIDER, TRANSCRIBE_PROVIDERS) ?? base.transcribeProvider,
    sessionProvider: oneOf('WT_SESSION_PROVIDER', env.WT_SESSION_PROVIDER, SESSION_PROVIDERS) ?? base.sessionProvider,
    scaffoldDir: nonEmpty(env.WT_SCAFFOLD_DIR) ?? base.scaffoldDir,
    agentSkillId: skillId('WT_AGENT_SKILL', env.WT_AGENT_SKILL) ?? base.agentSkillId,
  });
}

/** El agente es el único camino de compose (C5, decisión 5 de Karen 2026-11-05: se retiró el runner). --fixture y
 * --composer escriben archivos como el agente y corren por este camino. --runner/WT_COMPOSE_AGENT=0 ya no eligen el runner:
 * serve.ts los rechaza con exit 2 antes de llegar aquí (hasta el PR de flags, que los borra). */
export function composeAgent(_args: readonly string[], _env: Env): boolean {
  return true;
}

/** Config del proceso. Se lee en cada llamada, sin cache: los tests y los scripts cambian el env en caliente. */
export const config = (): Config => resolveConfig(process.env);
