#!/usr/bin/env bun
// Levanta el runtime de corridas en 127.0.0.1.
//   bun scripts/serve.ts [--skill generated/ds-skills/arc] [--root generated/v0-transport] [--port 5300]
//                          [--fixture snapshot-dir,otro-dir | --composer path/to/composer.ts] [--no-build] [--no-preview-check] [--no-auto-repair] [--images] [--product-image-only] [--registry]
// --fixture copia un directorio snapshot (una por corrida, en orden) al workspace del agente: sirve para probar
// transport, git y preview sin LLM ni créditos. --composer carga un módulo que exporte
// createComposer(skillDir): así el loop de orq se enchufa sin copiar su código a esta rama.
// --no-preview-check salta la revisión del preview vivo (errores de runtime y de vite) tras levantarlo.
// --no-auto-repair no lanza el arreglo automático tras una versión con defectos: es una corrida de modelo que nadie
// pidió, y en una QA con tope de gasto tiene que poder apagarse.
// --images activa el paso de imagen de producto si hay proveedor. WT_IMAGE_PROVIDER: 'none' (default core, sin
// imágenes), 'profile' (el puerto image del perfil) o 'gateway' (FLUX 3 klein por AI Gateway).
// --product-image-only con --images: solo la imagen de producto del T1, sin las de sección (una imagen por página).
// --registry (perfil con puerto registry) fija el índice publicado en el Blob por corrida; en core el registry es siempre el de registry/.
// --facts <url> (o WT_FACTS_URL) lee los hechos de la marca de un proxy /v1 antes de cada turno; si no responde, la
// corrida falla en transport:facts en vez de inventar. Ej.: --facts https://facts.example.com

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { workspaceBrandDir } from '../src/brand';
import { composeAgent, config } from '../src/config';
import { buildAdapters, checkRegistrySource, loadProfile } from '../src/profile';
import { assertNoKeyWithProxy } from '../src/runtime/gateway-auth';
import { REPO_ROOT, VAULT_ROOT } from '../src/catalog/load';
import type { IconLibrary } from '../src/ds-skill-icons';
import { Connectors, connectorsFromEnv } from '../src/runtime/connectors';
import { connectorsRemote } from '../src/runtime/connectors-remote';
import { parsePreviewUrls, PreviewPool, previewEnv } from '../src/runtime/preview';
import { runPreviewCheck } from '../src/runtime/preview-check';
import type { Allowlist } from '../src/runtime/runner';
import { fileRegistry } from '../src/runtime/registry-file';
import { Runtime, type Composer } from '../src/runtime/server';
import { localPublish } from '../src/runtime/publish';
import type { JsonSchema } from '../src/runtime/verify';
import { imageProvider, imagesEnabled } from '../src/runtime/image-step';
import { transcribeProvider } from '../src/runtime/transcribe';
import { allowList, gatewayModels } from '../src/runtime/gateway-models';
import { MIN_SECRET_BYTES } from '../src/runtime/preview-token';
import { parsePublicKeyPem } from '../src/runtime/public-key';
import { layoutPolicyOf } from '../src/runtime/skill';
import { factsSourceLabel } from '../src/brand-facts-source';
import { setEventSink } from '../src/runtime/events';
import { killChildren } from '../src/runtime/children';
import { signedVerifierFromEnv } from '../src/runtime/signed-verifier';
import { jwtVerifierFromEnv } from '../src/adapters/jwt/verifier';
import type { SessionVerifier } from '../src/runtime/session';
import { scaffoldMismatch } from '../src/skill-registry';

// --help antes de cualquier efecto: sin esto el bin instalado levantaba el runtime y abría puertos al pedir ayuda.
if (process.argv.includes('--help')) {
  console.log(`Uso: onbrand-serve [opciones]
Levanta el runtime de corridas en 127.0.0.1.

  --port <n>              puerto del transport (5300)
  --root <dir>            dónde guarda chats y workspaces (generated/v0-transport)
  --skill <dir>           skill del agente; por defecto, el que publica registry/
  --fixture <dir,...>     copia un snapshot por corrida al workspace, sin modelo ni créditos
  --composer <mod>        módulo que exporta createComposer(skillDir)
  --brand <ref>           brand pack de cada workspace (o WT_BRAND_PACK)
  --facts <url>           hechos de la marca desde un proxy /v1 (o WT_FACTS_URL)
  --builder-origin <url>  origen del builder que puede escribir
  --preview-port <n>      puerto de los previews
  --preview-origin <url>  origen público de los previews
  --publish-dir <dir>     destino de publicar en local
  --registry              con perfil: fija el índice publicado por corrida
  --images                genera imágenes si hay proveedor (WT_IMAGE_PROVIDER)
  --product-image-only    con --images: solo la imagen de producto del primer turno
  --no-build              no compila cada versión
  --no-preview-check      no revisa el preview vivo tras levantarlo
  --no-auto-repair        no lanza el arreglo automático tras una versión con defectos
  --no-suggest            sin sugerencias de siguientes pasos al cerrar el turno
  --help                  muestra esta ayuda`);
  process.exit(0);
}

// Import dinámico: sin trazas (Spotlight local u OTLP remoto) el SDK de OTel ni se carga.
let stopTelemetry: (() => Promise<void>) | undefined;
if (process.env.WT_SPOTLIGHT === '1' || process.env.WT_OTLP_URL) {
  const tel = await import('../src/runtime/telemetry');
  tel.startTelemetry();
  setEventSink(tel.traceEvent);
  stopTelemetry = tel.stopTelemetry;
  const dest = [process.env.WT_SPOTLIGHT === '1' ? `spotlight ${process.env.WT_SPOTLIGHT_URL || 'http://127.0.0.1:8969'}` : '', process.env.WT_OTLP_URL ? `otlp ${process.env.WT_OTLP_URL}` : ''].filter(Boolean).join(' + ');
  console.log(`trazas OTel: ${dest}`);
}

// El perfil de una distro (WT_PROFILE_MODULE) se carga antes de leer config(): sus defaults entran a la configuración y sus
// puertos a las ramas de abajo. Sin él corre el core. Un módulo que no carga o un puerto roto frena el arranque.
let profileAdapters: ReturnType<typeof buildAdapters>;
try { profileAdapters = buildAdapters(await loadProfile(process.env), process.env, 'runtime'); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// C5 (decisión 5 de Karen, 2026-11-05): se retiró el runner. --runner/WT_COMPOSE_AGENT=0 ya no eligen otro camino; se
// rechazan aquí para no correr el agente con gasto cuando quien los pasa cree que corre el runner (igual que un perfil sin puerto).
if (args.includes('--runner') || process.env.WT_COMPOSE_AGENT === '0') {
  console.error('el runner se retiró (C5): compón con el agente (sin --runner), o prueba sin crédito con --fixture <dir> o --composer <mod>');
  process.exit(2);
}
// El render-gate del transporte se borró (#854): --no-render-check ya no apaga nada y hoy se ignora en silencio. Se rechaza
// para que quien lo pasa sepa que el gate ya no existe, en vez de creer que lo apagó (igual que --runner).
if (args.includes('--no-render-check')) {
  console.error('--no-render-check se retiró (#854): el render-gate del transporte ya no corre; quita el flag del comando');
  process.exit(2);
}
// El agente escribe la página sobre el skill (C5): --fixture/--composer también corren por este camino.
const AGENT = composeAgent(args, process.env);
const REGISTRY_DIR = join(REPO_ROOT, 'registry');
// El skill del agente es el que publica el registry que se monta, en el mismo pin que el DS: registry/ en core, o el puerto
// registry del perfil (la distro responde así por su terna). Con --skill se usa ese directorio. serve.ts no arma el skill
// de ningún DS: armarlo aquí leería el vault, que un clon no tiene, y ataría el core a las herramientas de Arc (B9 paso 5).
const skillFlag = flag('--skill');
const skillSource = profileAdapters.registry ? 'el registry del perfil' : 'registry/';
const registrySkill = skillFlag
  ? undefined
  : await (profileAdapters.registry ? profileAdapters.registry().then((r) => checkRegistrySource(r)) : fileRegistry(REGISTRY_DIR)).then((r) => r.skillPack?.(config().agentSkillId));
if (!skillFlag && !registrySkill) {
  console.error(`${skillSource} no publica el skill ${config().agentSkillId}: ${profileAdapters.registry ? 'el perfil tiene que publicarlo, o pasa --skill <dir>' : 'bun scripts/build-base-registry.ts lo genera'}`);
  process.exit(2);
}
const skillDir = registrySkill ?? resolve(REPO_ROOT, skillFlag!);
// Con WT_SCAFFOLD_DIR de un DS y el skill de otro, el ws copiaría un DS y el agente leería el catálogo del otro sin error.
// Se mide sobre el skill que va a usar el agente, venga de registry/, del perfil o de --skill.
const mismatch = scaffoldMismatch(skillDir, config().agentSkillId, config().scaffoldDir);
if (mismatch) { console.error(mismatch); process.exit(2); }
const allow = JSON.parse(readFileSync(join(skillDir, 'allowlist.json'), 'utf8')) as Allowlist;
const iconsPath = join(skillDir, 'icons.json');
const icons = existsSync(iconsPath) ? (JSON.parse(readFileSync(iconsPath, 'utf8')) as IconLibrary) : undefined;
const schemas = (slug: string): JsonSchema | null => {
  const rel = allow[slug]?.schema;
  const abs = rel ? join(REPO_ROOT, rel) : '';
  return abs && existsSync(abs) ? (JSON.parse(readFileSync(abs, 'utf8')) as JsonSchema) : null;
};

/** Rutas relativas (POSIX) de todos los archivos bajo `root`, para la lista de `agent.files`. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      const child = join(abs, name);
      if (statSync(child).isDirectory()) walk(child);
      else out.push(relative(root, child).split('\\').join('/'));
    }
  };
  walk(root);
  return out;
}

/** --fixture ahora toma un directorio snapshot (la salida verbatim del render viejo) por corrida: lo copia tal cual al
 * workspace del agente y lo reporta como `agent.files`, sin runner ni LLM. Así transport/git/preview se prueban sin crédito
 * y por el mismo camino que el agente (C5, decisión 5 de Karen 2026-11-05: se retiró el render sin agente). */
function fixtureComposer(dirs: string[]): Composer {
  let next = 0;
  return async (req, log) => {
    const src = dirs[Math.min(next++, dirs.length - 1)];
    const dir = req.workspace?.dir;
    if (!dir) throw new Error('--fixture necesita el workspace del agente: corre sin --runner');
    log.emit({ type: 'step.start', stepId: 'fixture:compose', kind: 'action', label: 'Composing page' });
    cpSync(src, dir, { recursive: true });
    const files = filesUnder(src);
    log.emit({ type: 'step.end', stepId: 'fixture:compose', label: 'Composed page', status: 'ok', detail: { kind: 'action', name: 'compose', summary: `${src} (${req.prompt})` } });
    return { sections: [], agent: { files, summary: `fixture ${src}`, missing: [], suggestions: [] } };
  };
}

/** Commit del checkout que corre: va a page.json.agent.trace para saber con qué server se generó cada versión. */
function serverCommit(): string {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : process.env.WT_SERVER_COMMIT ?? 'unknown';
}

async function loadComposer(): Promise<Composer> {
  const fixture = flag('--fixture');
  if (fixture) return fixtureComposer(fixture.split(',').map((p) => resolve(p)));
  const mod = flag('--composer');
  if (AGENT && !mod) {
    const { createAgentComposer } = await import('../src/runtime/agent-composer');
    const { createInfer } = await import('../src/runtime/infer');
    // Una llamada de haiku por turno para los siguientes pasos (OK de Karen, 2026-10-29); --no-suggest la apaga.
    const suggest = args.includes('--no-suggest') ? undefined : createInfer({ model: process.env.WT_SUGGEST_MODEL ?? 'haiku' });
    return createAgentComposer(skillDir, { serverCommit: serverCommit(), ...(config().imageProvider === 'profile' ? { imageGen: (m: string) => profileAdapters.image!.gen(m) } : {}), ...(suggest ? { suggest } : {}), ...(args.includes('--product-image-only') ? { imageOnly: true } : {}) });
  }
  if (!mod) {
    console.error('falta --fixture o --composer');
    process.exit(2);
  }
  const { createComposer } = (await import(resolve(mod))) as { createComposer?: (skillDir: string) => Composer };
  if (typeof createComposer !== 'function') {
    console.error(`${mod} no exporta createComposer(skillDir)`);
    process.exit(2);
  }
  return createComposer(skillDir);
}

const starterDir = join(skillDir, 'assets', 'starter');
// La alineación de cabecera es política del DS (como layout.sectionHeaderAlign del v0.json de v0), no del plan.
const layout = layoutPolicyOf(join(skillDir, 'v0.json'), icons);
// --builder-origin: origen del builder al que el preview manda sus errores de runtime (postMessage, #278). El default sale
// del perfil (config.ts): core = http://localhost:5173 (el dev server del builder) para que un clon limpio no reciba 403;
// un perfil puede dejarlo undefined (el origen del deploy se exige explícito). La bandera y WT_BUILDER_ORIGIN (dentro de config) ganan.
const builderOrigin = flag('--builder-origin') ?? config().builderOrigin;
// Despliegue en un Vercel Sandbox (deploy-ec.md): host de escucha, puertos publicados y el secreto del rewrite /api.
const host = process.env.WT_HOST ?? '127.0.0.1';
const originSecret = process.env.WT_ORIGIN_SECRET;
// Fuera de loopback sin secreto, cualquiera con la url del Sandbox lanzaría corridas con la key de Gateway.
if (host !== '127.0.0.1' && (!originSecret || originSecret.length < 32)) {
  console.error('WT_HOST fuera de loopback exige WT_ORIGIN_SECRET de al menos 32 caracteres');
  process.exit(2);
}
// Spec deploy-sandbox §1: con el proxy del orquestador no hay llave del Gateway en la VM; si sobra una, no se arranca.
try { assertNoKeyWithProxy(); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
// Un proveedor 'profile' sin su puerto no puede degradar en silencio a otro camino: se frena aquí, antes de abrir nada.
for (const [provider, port, value] of [['WT_PUBLISH_PROVIDER', 'publish', profileAdapters.publish], ['WT_IMAGE_PROVIDER', 'image', profileAdapters.image]] as const) {
  const key = provider === 'WT_PUBLISH_PROVIDER' ? config().publishProvider : config().imageProvider;
  if (key === 'profile' && !value) { console.error(`${provider}=profile exige que el perfil aporte el puerto ${port} (WT_PROFILE_MODULE)`); process.exit(2); }
}
// Spec identidad §3: el secreto de origen prueba el rewrite, no a la persona. Con sessionProvider 'local' (hasta que
// el perfil cablee su adaptador, fase 5) un deploy con secreto no arranca en vez de quedar abierto a quien pase el rewrite.
if (originSecret && config().sessionProvider === 'local') {
  console.error('WT_ORIGIN_SECRET exige un proveedor de identidad (WT_SESSION_PROVIDER distinto de local); sin él el deploy no arranca');
  process.exit(2);
}
// Bajo el orquestador (deploy-sandbox.md §4) la identidad llega firmada: sin llave pública o sin chat no hay verifier y no se arranca.
let sessionVerifier: SessionVerifier | undefined;
if (config().sessionProvider === 'signed') {
  try { sessionVerifier = signedVerifierFromEnv(process.env); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
}
// Identidad del perfil (sessionProvider 'profile'): su verifier entra tal cual y el runtime lo envuelve con providerVerifier.
if (config().sessionProvider === 'profile') {
  if (!profileAdapters.session) { console.error("WT_SESSION_PROVIDER=profile exige que el perfil aporte el puerto session (WT_PROFILE_MODULE)"); process.exit(2); }
  sessionVerifier = profileAdapters.session;
}
// Runtime expuesto directo con un IdP (fase 5): el adaptador vive fuera de src/runtime y solo se carga aquí. warm: sin llaves
// al arrancar no hay login posible; mejor no arrancar que servir 401 a todos sin pista.
if (config().sessionProvider === 'jwt') {
  try { const jwt = jwtVerifierFromEnv(process.env); await jwt.warm(); sessionVerifier = jwt; } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
}
// Gate del preview (docs/notas/deploy-builder.md "Gate del preview"): explícito, sin derivar de WT_ORIGIN_SECRET. Corto no
// arranca: preview-token.ts lanzaría en el primer latido, con el deploy ya arriba.
const previewSecret = process.env.WT_PREVIEW_SECRET ? Buffer.from(process.env.WT_PREVIEW_SECRET, 'utf8') : undefined;
if (previewSecret && previewSecret.length < MIN_SECRET_BYTES) {
  console.error(`WT_PREVIEW_SECRET necesita al menos ${MIN_SECRET_BYTES} bytes`);
  process.exit(2);
}
// Modo asimétrico (deploy-sandbox §4): bajo el orquestador la VM verifica el token con esta pública Ed25519 y no firma.
const previewPublicKey = process.env.WT_PREVIEW_PUBLIC_KEY?.trim()
  ? (() => { try { return parsePublicKeyPem(process.env.WT_PREVIEW_PUBLIC_KEY, 'WT_PREVIEW_PUBLIC_KEY'); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); } })()
  : undefined;
// Pública XOR secreto: HMAC en local o Ed25519 bajo el orquestador, nunca ambas (dejaría dos caminos de confianza).
if (previewSecret && previewPublicKey) {
  console.error('WT_PREVIEW_SECRET y WT_PREVIEW_PUBLIC_KEY son excluyentes: HMAC en local o Ed25519 bajo el orquestador, no ambas');
  process.exit(2);
}
// Fuera de loopback un listener sin gate deja el preview abierto a quien tenga la url del Sandbox (security-reviewer LOW).
if (host !== '127.0.0.1' && !previewSecret && !previewPublicKey) {
  console.error('WT_HOST fuera de loopback exige un gate de preview: WT_PREVIEW_SECRET (local) o WT_PREVIEW_PUBLIC_KEY (orquestador)');
  process.exit(2);
}
// Con 'signed' (VM bajo el orquestador) el gate del preview es obligatorio y asimétrico: el secreto HMAC no entra en la
// VM, así que sin la pública el listener queda sin gate para quien tenga la url (security-reviewer).
if (config().sessionProvider === 'signed' && !previewPublicKey) {
  console.error('WT_SESSION_PROVIDER=signed exige WT_PREVIEW_PUBLIC_KEY: el gate del preview no puede quedar apagado ni en HMAC bajo el orquestador');
  process.exit(2);
}
const previewNet = { ...(host !== '127.0.0.1' ? { host } : {}), ...(process.env.WT_PREVIEW_URLS ? parsePreviewUrls(process.env.WT_PREVIEW_URLS) : {}) };
// vite rechaza un Host que no conoce: los dominios publicados del Sandbox van a server.allowedHosts del scaffold.
const allowedHosts = previewNet.ports?.map((p) => new URL(previewNet.publicUrl!(p)).hostname) ?? [];
const previews = new PreviewPool(5310, 60_000, { ...previewEnv(builderOrigin), ...(allowedHosts.length ? { WT_ALLOWED_HOSTS: allowedHosts.join(',') } : {}) }, undefined, undefined, previewNet);
const maxRunning = process.env.WT_MAX_RUNNING ? Number(process.env.WT_MAX_RUNNING) : undefined;
if (maxRunning !== undefined && !(Number.isInteger(maxRunning) && maxRunning > 0)) {
  console.error('WT_MAX_RUNNING debe ser un entero positivo');
  process.exit(2);
}
// La base sin /v1: el adaptador arma /v1/<colección>.
const factsBase = (() => { const b = flag('--facts') ?? process.env.WT_FACTS_URL; return b ? b.replace(/\/v1\/?$/, '') : undefined; })();
// La fuente de hechos es del perfil: en core --facts no tiene a qué conectarse, y seguir sin ella sería servir páginas
// sin los hechos que se pidieron.
const facts = factsBase ? (() => {
  if (!profileAdapters.facts) {
    console.error('--facts necesita la fuente de hechos de un perfil: WT_PROFILE_MODULE=<módulo que aporte el puerto facts>');
    process.exit(2);
  }
  return profileAdapters.facts(factsBase);
})() : undefined;
// El runner valida y trae el código del mismo índice del que compone el composer. En core es el registry del repo,
// siempre: sin él un clon importa componentes que solo existen en el vault. Con un perfil que aporte `registry`, --registry
// fija el suyo (pedirlo desde el mismo main: si no, los bloques salen de un índice viejo); sin él, el vault local.
const registry = !profileAdapters.registry
  ? (() => {
    if (args.includes('--registry')) { console.error('--registry es el registry de un perfil: WT_PROFILE_MODULE=<módulo que aporte el puerto registry>'); process.exit(2); }
    if (!existsSync(join(REGISTRY_DIR, 'latest.json'))) { console.error(`falta el registry del DS en ${REGISTRY_DIR}: bun scripts/build-base-registry.ts lo genera`); process.exit(2); }
    return (pin?: string) => fileRegistry(REGISTRY_DIR, pin);
  })()
  : args.includes('--registry') ? async (pin?: string) => checkRegistrySource(await profileAdapters.registry!(pin)) : undefined;
const transportPort = Number(flag('--port') ?? process.env.WT_TRANSPORT_PORT ?? 5300);
// Puerto del listener de la url estable (R5.5): cada ws vive en su propio origen `<ws>.<host>:<previewPort>`, cross a la API
// y al builder, para que la página generada no alcance /runs ni /approvals ni otro ws. Default = API + 1 (local). En un
// Sandbox el operador lo publica y pone su puerto y dominio (WT_PREVIEW_PORT / WT_PREVIEW_ORIGIN; el host no puede ser una
// IP: el subdominio por ws la necesita con nombre), sin chocar con los de vite.
const previewPort = Number(flag('--preview-port') ?? process.env.WT_PREVIEW_PORT ?? transportPort + 1);
if (!(Number.isInteger(previewPort) && previewPort > 0 && previewPort !== transportPort)) {
  console.error('--preview-port debe ser un entero positivo distinto del puerto de la API');
  process.exit(2);
}
// localhost (no 127.0.0.1): el origen por ws es `<ws>.localhost:<previewPort>` (R5.5) y una IP no admite subdominio. El
// navegador resuelve cualquier `*.localhost` a loopback sin DNS.
const previewOrigin = flag('--preview-origin') ?? process.env.WT_PREVIEW_ORIGIN ?? `http://localhost:${previewPort}`;
const transport = new Runtime({
  ...(args.includes('--product-image-only') ? { imagesPerRun: 1 } : {}),
  root: resolve(REPO_ROOT, flag('--root') ?? 'generated/v0-transport'),
  // Zona de la fecha de la memoria de marca; sin WT_TZ, UTC del proceso (ver RuntimeOptions.timezone). El default de
  // producto y su documentación los decide Karen.
  ...(process.env.WT_TZ ? { timezone: process.env.WT_TZ } : {}),
  allow,
  icons,
  schemas,
  ...(layout ? { layout } : {}),
  compose: await loadComposer(),
  ...(AGENT ? { agent: true } : {}),
  previews,
  previewPort,
  previewOrigin,
  ...(previewSecret ? { previewSecret } : {}),
  ...(previewPublicKey ? { previewPublicKey } : {}),
  ...(builderOrigin ? { builderOrigin } : {}),
  ...(args.includes('--no-preview-check') ? {} : { previewCheck: runPreviewCheck }),
  build: !args.includes('--no-build'),
  ...(args.includes('--no-auto-repair') ? { autoRepair: false } : {}),
  // Sin las PIPEDREAM_* en el entorno, /connectors/* da 404 y el builder muestra "no conectado".
  ...(() => { const cfg = connectorsFromEnv(); if (cfg) return { connectors: new Connectors(cfg) };
    // Sin credencial local pero con orquestador (la VM del deploy): las apps salen por él.
    const remote = connectorsRemote(process.env);
    return remote ? { connectorsRemote: remote } : {};
  })(),
  // Con el agente por Gateway, el selector y la validación de `model` salen del catálogo vivo acotado por WT_MODELS;
  // en local (sesión de Claude Code) el builder usa su lista y el transport acepta cualquier id.
  ...(config().composeProvider === 'gateway' ? { models: await gatewayModels(allowList(process.env.WT_MODELS, ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5']), 'language') } : {}),
  imageModels: !imagesEnabled(imageProvider(), args.includes('--images')) ? [] : imageProvider() === 'gateway' ? await gatewayModels(allowList(process.env.WT_IMAGE_MODELS, ['bfl/flux-3-image-klein']), 'image') : profileAdapters.image?.models ?? [],
  // Dictado: el core no transcribe (sin micrófono en el builder); una distro enchufa whisper por AI Gateway.
  ...(() => { const t = transcribeProvider(); return t ? { transcribe: t } : {}; })(),
  scaffoldDir: config().scaffoldDir,
  starterDir: existsSync(starterDir) ? starterDir : undefined,
  ...(() => { const b = workspaceBrandDir(flag('--brand')); return b ? { brandDir: b } : {}; })(),
  vaultRoot: VAULT_ROOT,
  // page.brand sin --registry: la carpeta de packs del perfil (WT_BRANDS_ROOT la cambia).
  brandsRoot: config().brandsRoot,
  ...(registry ? { registry } : {}),
  ...(facts ?? {}),
  ...(maxRunning ? { maxRunning } : {}),
  ...(process.env.WT_RUNS_DISABLED === '1' ? { runsDisabled: true } : {}),
  ...(sessionVerifier ? { session: sessionVerifier } : {}),
  ...(originSecret ? { trust: { secret: originSecret, ...(builderOrigin ? { origin: builderOrigin } : {}) } } : {}),
  // Core: export local del sitio a una carpeta (sin cuenta, sin Vercel). La variante enchufa su destino hosted aquí.
  ...(config().publishProvider === 'local' ? { publish: localPublish(resolve(REPO_ROOT, flag('--publish-dir') ?? process.env.WT_PUBLISH_DIR ?? 'generated/v0-publish')) } : {}),
  ...(config().publishProvider === 'profile' ? { publish: profileAdapters.publish! } : {}),
  ...(config().imageProvider === 'profile' ? { imageService: profileAdapters.image! } : {}),
});
// Junto a los ndjson de cada turno, que el Runtime ya creó: el arnés (S0) cruza las dos fuentes.
previews.logDir = resolve(REPO_ROOT, flag('--root') ?? 'generated/v0-transport', 'logs');
transport.listen(transportPort, host);
console.log(`transport en http://${host}:${transportPort}${originSecret ? ' (exige x-origin-secret)' : ''}; preview en ${previewOrigin}`);
// Sin --builder-origin el chequeo de Origin rechaza toda escritura del builder con 403 (transport.ts checkOrigin). Un aviso
// al arrancar ahorra el diagnóstico: el síntoma (403 en cada run) no dice que falta esta bandera.
if (!builderOrigin) console.warn('aviso: sin --builder-origin (ni WT_BUILDER_ORIGIN) el builder recibirá 403 en cada escritura con Origin');
// Sin esta línea solo `ps` decía si los hechos venían del proxy o del pack (QA gen7).
console.log(facts && factsBase ? `hechos: ${Object.keys(facts.factsSources).join(', ')} <- ${factsSourceLabel(factsBase)}` : 'hechos: solo los del brand pack (sin --facts)');
// Antes de salir corta las corridas en curso: sin esto el CLI del agente (y su AutoFix) seguía vivo tras matar el server.
// Una segunda señal sale en el acto, por si el cierre se cuelga.
let stopping = false;
const stop = (code: number) => {
  if (stopping) process.exit(code || 1);
  stopping = true;
  // Después de cortar las corridas, los hijos que quedan (CLI que ignoró el SIGTERM, tsc, visión, infer, preview-check)
  // reciben SIGTERM y, pasada la gracia, SIGKILL: el exit ya no gana a un timer unref (auditoría #12).
  // stopTelemetry vacía el buffer del BatchSpanProcessor (OTLP remoto) antes del exit: sin esto, un SIGTERM se lleva las
  // trazas de las corridas cortadas, que son las que más importan en deploy (Arq 2026-11-03).
  void transport.shutdown().then(() => killChildren()).then(() => stopTelemetry?.()).finally(() => { previews.stopAll(); process.exit(code); });
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => stop(0));
// Red, no recuperación: desde f691017 las tools del agente corren en este proceso, y una excepción fuera de una promesa
// (bench a77b6e3: TypeError en el timer de browse) lo mataba sin cortar las corridas, con los CLI y chromium huérfanos.
// No se sigue sirviendo con un estado que nadie sabe cómo quedó: se loguea, se cortan las corridas y se sale con 1.
for (const ev of ['uncaughtException', 'unhandledRejection'] as const) process.on(ev, (e: unknown) => {
  console.error(`transport: ${ev}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  stop(1);
});
