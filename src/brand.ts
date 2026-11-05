// Consumidor de un Brand Pack (capa 1, identidad) sobre el contrato del DS (capa 2): orquesta la ESCRITURA de la marca
// en el scaffold generado (src/identity.css, fuentes, data-accent, src/brand.ts) y la COBERTURA del contrato (C1). El
// esquema y el parser del pack viven en brand-pack.ts; la capa de identidad pura en brand-identity.ts; la lista de
// fuentes en brand-fonts.ts. Este módulo es la fachada con IO: re-exporta esos símbolos para no tocar a los importadores.
//
// Layout de un pack (lo único que se lee y se publica al registry):
//   brand.json   obligatorio
//   fonts/**     solo si fonts.import apunta a ./fonts/
//   <logo>       ruta relativa que nombra brand.json.logo (svg|png|webp); se copia a public/brand/logo.<ext>
//   <logoDark>   opcional, el logo para zonas oscuras; se copia a public/brand/logo-dark.<ext>

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { packAaErrors, type ThemeTables } from './brand-aa';
import { deriveTheme, type ThemeParams } from './theme/derive';
import { contractFromCss } from './theme/presets-from-css';
import contractRoles from './theme/contract-roles.json';
import { config } from './config';
import { FACTS_FILE, parseBrandFacts, type BrandFacts } from './brand-facts';
import { checkPackDesign } from './identity-ephemeral';
import { FONT_LIST } from './brand-fonts';
import { brandVariantFiles, variantsCss, type ExtensionPoints } from './brand-components';
import { brandFontsHref, identityCss, isLoadableFont, resolveIdentity } from './brand-identity';
import { ACCENT_TOKENS } from './brand-util';
import { brandModule, contractThemes, contractTokens, logoDarkSrc, logoSrc, parseBrandPack, withThemeParams, type BrandComposition, type BrandPack, type ParseBrandOptions } from './brand-pack';

// Fachada: los importadores siguen pidiendo esquema, parser e identidad a './brand'.
export { PRESET_ACCENTS, BRAND_PACK_KEYS, ACCENT_KEYS, SURFACE_KEYS, FONT_KEYS, BRAND_PACK_V2_KEYS, THEME_KEYS, SEED_KEYS, COLOR_MODES, DENSITIES, LOGO_EXTS, logoIncludesName, logoSrc, logoDarkSrc, brandModule, brandExpectOf, THEME_PARAM_KEYS, withThemeParams, parseBrandPack } from './brand-pack';
export type { ColorMode, PresetAccent, CustomAccent, BrandSurface, BrandFonts, RoleBias, Density, BrandComposition, LogoKind, BrandPack, ParseBrandOptions } from './brand-pack';
export { resolveIdentity, brandFontsHref, identityCss } from './brand-identity';
export type { Identity } from './brand-identity';

/** Donde queda el logo en la página: Vite sirve public/ en la raíz, así que src="/brand/logo.<ext>". */
export const LOGO_PUBLIC_DIR = join('public', 'brand');

/** Lo que pinta el navegador con este pack: el contrato, el preset (data-accent, foundation.css:163-197) y encima la
 * identidad, en claro y en oscuro; y qué tokens fijó la marca. Es la entrada del gate de contraste de applyBrand. */
export function brandAaTables(brand: BrandPack): { tables: ThemeTables; touched: Set<string> } {
  const contract = contractThemes();
  const id = resolveIdentity(brand);
  const decls = (list: string[]): Record<string, string> => Object.fromEntries(list.map((d) => /^(--[a-z0-9-]+):\s*(.*);$/i.exec(d)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]]));
  const preset = typeof brand.accent === 'string' ? deriveTheme({ preset: brand.accent }) : { light: {}, dark: {} };
  const root = decls(id.rootDeclarations);
  const darkOwn = decls(id.darkDeclarations);
  const light = { ...contract.light, ...preset.light, ...root };
  const dark = { ...light, ...contract.dark, ...preset.dark, ...darkOwn };
  // Un preset es del contrato y exacto (decisión de Karen 2026-11-03): orange, green y amber no llegan a 3:1 sobre
  // fondo claro (foundation.css:166-168) y eso es deuda del contrato, no de quien eligió el preset. Cuenta lo que escribe el pack.
  const touched = new Set([...Object.keys(root), ...Object.keys(darkOwn)]);
  return { tables: { light, dark }, touched };
}

/** Tokens del contrato que cada canal cubre cuando está presente (accent/surface/fonts). Los font
 * tokens del contrato (--font-display/--font-body) se resuelven vía --font-geist/--font-inter, que es
 * lo que escribe el canal fonts; aquí se cuentan como cubiertos cuando la marca fija fuentes. */
const ACCENT_CONTRACT = ['--accent', '--accent-strong', '--accent-subtle', '--accent-foreground'];
const SURFACE_CONTRACT = ['--background', '--surface', '--foreground', '--text-secondary'];
const FONT_CONTRACT = ['--font-display', '--font-body'];
// Palancas globales de forma: factores del contrato con default 1 (1 = no escalar). Un pack que no las
// fija deja un default neutro, no una identidad perdida, así que no deben romper C1 como los tokens de
// identidad. Si el pack SÍ las fija (vía tokens) entran a `defined` y cuentan como identidad real.
export const FORM_LEVERS = ['--scaling', '--radius-factor'];
// Derivados del contrato (color-mix de otros tokens): siguen a la marca sin que el pack los fije. Un pack puede
// fijarlos vía tokens, pero no fijarlos no es una fuga de identidad.
export const DERIVED_TOKENS = ['--surface-band', '--brand-highlight'];
// Colores de un tercero (el verde de WhatsApp del CTA de conversión): son iguales para toda marca, así que el contrato
// los fija y no dejarlos en el pack tampoco es una fuga de identidad.
export const THIRD_PARTY_TOKENS = ['--whatsapp', '--whatsapp-foreground', '--button-whatsapp-foreground'];

/** Cobertura del contrato por una marca, separada en identidad efectiva vs herencia declarada:
 * - `defined`: tokens con VALOR de marca (canal accent/surface/fonts o `tokens`) = identidad real (C1b).
 * - `inherited`: tokens declarados en `inherit` (dejados en el default del contrato, con motivo).
 * - `missing`: tokens del contrato sin definir ni heredar (la fuga que C1 cierra).
 * `covered` = defined ∪ inherited. C1 pasa con 0 missing; C1b mide defined/97 como ratchet. */
const CONTRACT_INVARIANTS = Object.entries((contractRoles as { tokens: Record<string, { role: string }> }).tokens).filter(([, e]) => e.role === 'invariant').map(([t]) => t);

export function brandCoverage(brand: BrandPack): { defined: Set<string>; inherited: Set<string>; covered: Set<string>; missing: string[] } {
  const defined = new Set<string>();
  // accent siempre presente (preset o propio): el preset cubre vía [data-accent], el propio vía :root.
  for (const t of ACCENT_CONTRACT) defined.add(t);
  if (brand.surface) for (const t of SURFACE_CONTRACT) defined.add(t);
  if (brand.fonts?.display || brand.fonts?.body) for (const t of FONT_CONTRACT) defined.add(t);
  for (const k of Object.keys(brand.tokens ?? {})) defined.add(k);
  // v2 no declara herencia: lo que no fija queda en el contrato, que clasifica cada token una vez (src/theme/contract-roles.json).
  const inherited = brand.schemaVersion === 2 ? new Set([...contractTokens()].filter((t) => !defined.has(t))) : new Set(Object.keys(brand.inherit ?? {}));
  // covered = identidad (defined) ∪ herencia declarada (inherited) ∪ palancas de forma cubiertas por su
  // default del contrato. Las palancas no inflan `defined` (el ratchet C1b mide solo identidad real).
  // Un token que el contrato clasifica `invariant` (src/theme/contract-roles.json) no es identidad: ninguna marca lo
  // declara, tampoco en v1. Sin esto, cada token nuevo del contrato (la paleta de tonos de Arc) rompía C1 en todo pack v1.
  const covered = new Set([...defined, ...inherited, ...FORM_LEVERS, ...DERIVED_TOKENS, ...THIRD_PARTY_TOKENS, ...CONTRACT_INVARIANTS]);
  const missing = [...contractTokens()].filter((t) => !covered.has(t)).sort();
  return { defined, inherited, covered, missing };
}

/** Falla EXPLÍCITO si la marca deja tokens del contrato sin definir ni declarar en `inherit`: es la
 * fuga que el informe 'Flujo de datos' documenta (60 variables heredando el default sin que nadie lo
 * dijera). Cerrar el contrato obliga a decidir cada token. */
export function assertBrandCoverage(brand: BrandPack): void {
  const { missing } = brandCoverage(brand);
  if (missing.length) {
    throw new Error(`brand pack "${brand.name}": ${missing.length} tokens del contrato sin definir ni heredar (declara cada uno en tokens o en inherit con motivo): ${missing.join(', ')}`);
  }
}

// El link lleva su marca para que aplicar otra marca lo reemplace o lo quite, y no se acumulen los de marcas anteriores.
const BRAND_FONTS_LINK = /[ \t]*<link\b[^>]*\bdata-brand-fonts\b[^>]*>\n?/g;

function withBrandFonts(html: string, href: string | null): string {
  const clean = html.replace(BRAND_FONTS_LINK, '');
  if (!href) return clean;
  return clean.replace(/<\/head>/i, `    <link rel="stylesheet" data-brand-fonts href="${href}" />\n  </head>`);
}

/** Un pack ya validado entero: lo que applyBrand escribe, el panel resume y el prompt cita. */
export interface LoadedBrandPack { brand: BrandPack; facts?: BrandFacts; design?: string }

/** Lee y valida un pack completo (brand.json, logos, facts.json y DESIGN.md) sin escribir nada. Cada error nombra el
 * archivo del pack: quien edita brands/ tiene que saber cuál arreglar, y una marca rota no sale como página neutra. */
export function loadBrandPack(dir: string, opts: ParseBrandOptions = {}): LoadedBrandPack {
  const { errors, loaded } = inspectBrandPack(dir, opts);
  if (!loaded) throw new Error(errors.join('\n'));
  return loaded;
}

/** Todos los errores del pack, no solo el primero: lo que check-brand le muestra a quien arma una marca. [] = válido. */
export function brandPackErrors(dir: string, opts: ParseBrandOptions = {}): string[] {
  return inspectBrandPack(dir, opts).errors;
}

function inspectBrandPack(dir: string, opts: ParseBrandOptions): { errors: string[]; loaded?: LoadedBrandPack } {
  const errors: string[] = [];
  const add = (file: string, e: unknown) => {
    const msg = (e instanceof Error ? e.message : String(e)).replace(/^(brand pack|facts\.json|DESIGN\.md): /, '');
    errors.push(`${basename(dir)}/${file}: ${msg}`);
  };
  const json = (file: string): { ok: true; value: unknown } | { ok: false } => {
    try { return { ok: true, value: JSON.parse(readFileSync(join(dir, file), 'utf8')) }; } catch (e) { add(file, e instanceof SyntaxError ? `JSON inválido (${e.message})` : e); return { ok: false }; }
  };
  let brand: BrandPack | undefined;
  if (!existsSync(join(dir, 'brand.json'))) add('brand.json', 'no existe');
  else {
    const raw = json('brand.json');
    if (raw.ok) try { brand = parseBrandPack(raw.value, opts); } catch (e) { add('brand.json', e); }
  }
  // Un logo declarado que no está es una marca rota: la página saldría con el monograma sin que nadie lo dijera.
  for (const logo of [brand?.logo, brand?.logoDark]) if (logo && !existsSync(join(dir, logo))) add('brand.json', `declara logo "${logo}" pero no existe en ${dir}`);
  // Una familia que nadie carga cae a sans en silencio: o es de las que applyBrand enlaza, o el pack trae su CSS.
  for (const role of ['display', 'body'] as const) {
    const family = brand?.fonts?.[role];
    if (family && !brand?.fonts?.import && !isLoadableFont(family)) add('brand.json', `fonts.${role} "${family}" no es una fuente que se pueda cargar sin más; usa una de ${FONT_LIST.map((f) => f.family).join(', ')} o trae su CSS en fonts.import`);
  }
  let facts: BrandFacts | undefined;
  if (existsSync(join(dir, FACTS_FILE))) {
    const raw = json(FACTS_FILE);
    if (raw.ok) try { facts = parseBrandFacts(raw.value); } catch (e) { add(FACTS_FILE, e); }
  }
  let design: string | undefined;
  if (existsSync(join(dir, 'DESIGN.md'))) {
    design = readFileSync(join(dir, 'DESIGN.md'), 'utf8');
    // La prosa que contradice a los tokens llegaría al agente diciendo otra cosa que la hoja que se aplica. Sin un
    // brand.json válido no hay contra qué compararla: ese error ya está arriba.
    const drift = brand ? checkPackDesign(brand, design).map((e) => e.replace(/^DESIGN\.md: /, '')) : [];
    if (drift.length) add('DESIGN.md', `no coincide con brand.json:\n${drift.join('\n')}`);
  }
  if (errors.length || !brand) return { errors };
  return { errors, loaded: { brand, ...(facts ? { facts } : {}), ...(design !== undefined ? { design } : {}) } };
}

/** Inyecta la identidad de `brandDir` en el scaffold ya copiado en `outDir`: escribe src/identity.css,
 * copia las fuentes de marca y ajusta data-accent en index.html. El accent custom NO debe llevar
 * data-accent (el selector :root[data-accent] del contrato le ganaría por especificidad). */
/** `keepIdentity`: follow-up sobre una página que ya tiene la marca. v0 y Lovable no tienen tema que el cliente vuelva a
 * aplicar (solo el toggle claro/oscuro: deob/v0-design-mode/deobfuscated.js:47852, Lovable app-lazy-shared-CKknmzHJ
 * .deob.js:57257-57262); el `globals.css`/`styles.css` que editó un turno es la identidad de los siguientes. Aquí
 * identity.css, DESIGN.md y el data-accent de index.html son esa identidad: no se pisan con el pack. */
export function applyBrand(outDir: string, brandDir: string, opts: Pick<ParseBrandOptions, 'extensionPoints' | 'pin'> & { keepIdentity?: boolean } = {}): BrandPack {
  // Todo el pack se valida antes de la primera escritura: un error a medias dejaría la hoja nueva con el DESIGN.md viejo.
  const { brand } = loadBrandPack(brandDir, opts);
  // Antes de escribir: una marca con CTA o texto ilegible no se aplica (invariante AA 4.5:1 claro y oscuro). Hasta aquí
  // solo se medía la identidad que declaraba el agente; la del pack pasaba sin medir (identity-ephemeral.ts checkIdentity).
  const { tables, touched } = brandAaTables(brand);
  const aa = packAaErrors(tables, touched);
  if (aa.length) throw new Error(`brand pack ${brand.name}: contraste insuficiente\n${aa.map((e) => `- ${e}`).join('\n')}`);
  const id = resolveIdentity(brand);

  // La cabecera dice de dónde salió la hoja: sin ella, una marca solo preset (hoja vacía) no se distingue de "sin
  // marca", y el agente declararía su propia identidad encima del pack (identity-ephemeral.ts PACK_MARKER).
  const keep = opts.keepIdentity === true && existsSync(join(outDir, 'src', 'identity.css'));
  if (!keep) writeFileSync(join(outDir, 'src', 'identity.css'), `/* brand-pack: ${brand.name.replace(/\*\/|[\r\n]/g, '')} */\n${identityCss(brand)}${variantsCss(brand.components)}`);

  const fontsSrc = join(brandDir, 'fonts');
  if (brand.fonts?.import?.includes('/fonts/') && existsSync(fontsSrc)) {
    cpSync(fontsSrc, join(outDir, 'src', 'fonts'), { recursive: true });
  }

  for (const [file, src] of [[brand.logo, logoSrc(brand)], [brand.logoDark, logoDarkSrc(brand)]] as const) {
    if (!file || !src) continue;
    const logoFile = join(brandDir, file);
    mkdirSync(join(outDir, LOGO_PUBLIC_DIR), { recursive: true });
    copyFileSync(logoFile, join(outDir, 'public', src));
  }
  writeFileSync(join(outDir, 'src', 'brand.ts'), brandModule(brand));
  // El DESIGN.md del pack (ya validado por loadBrandPack) va a la raíz del workspace: el agente lo lee como la marca y no escribe otro.
  // Sin DESIGN.md en el pack, el que hubiera en el workspace es de la identidad anterior y contradiría esta hoja.
  if (!keep) {
    if (existsSync(join(brandDir, 'DESIGN.md'))) copyFileSync(join(brandDir, 'DESIGN.md'), join(outDir, 'DESIGN.md'));
    else rmSync(join(outDir, 'DESIGN.md'), { force: true });
  }

  const htmlPath = join(outDir, 'index.html');
  if (!keep && existsSync(htmlPath)) {
    const html = readFileSync(htmlPath, 'utf8');
    const accent = id.htmlAttrs['data-accent'];
    const withAccent = accent
      ? html.replace(/\sdata-accent="[^"]*"/, '') .replace(/<html\b([^>]*)>/, `<html$1 data-accent="${accent}">`)
      : html.replace(/\sdata-accent="[^"]*"/, '');
    // colorMode es el modo por defecto de la página; las zonas data-theme siguen eligiendo el suyo.
    const next = withBrandFonts(brand.colorMode ? setHtmlTheme(withAccent, brand.colorMode) : withAccent, brandFontsHref(brand));
    if (next !== html) writeFileSync(htmlPath, next);
  }

  return brand;
}

/** Tipos de las variantes de marca en la carpeta de cada componente. Va después de traer los items del registry: cada
 * item trae su <componente>.brand.ts en never y lo pisaría. Solo los componentes ya presentes en el workspace. */
export function writeBrandVariants(outDir: string, points: ExtensionPoints, brand: BrandPack | undefined): string[] {
  return brandVariantFiles(points, brand?.components)
    .filter((f) => existsSync(join(outDir, f.path, '..')))
    .map((f) => {
      writeFileSync(join(outDir, f.path), f.content);
      return f.path;
    });
}

// La capa del panel Tema en una página sin pack: va al final de identity.css, después de lo que declaró el agente,
// para ganarle por orden con los mismos selectores (identityCss) sin reescribir esa identidad.
const PANEL_START = '/* panel-tema */';
const PANEL_END = '/* /panel-tema */';

/** "Aplicar" del panel Tema en una página sin pack (el default en core): la identidad es la que declaró el agente en
 * identity.css y DESIGN.md, y no hay marca con qué fusionar (QA vivo 2026-11-03, re-sistema/onbrand/vivo/casos/
 * apply-theme-run D1). Se escribe solo lo que cambia el valor efectivo, en una capa propia que se reemplaza en cada
 * aplicar; identity.css del agente, DESIGN.md y src/brand.ts no se tocan. Mismo gate AA que applyBrand. Devuelve los
 * tokens escritos. */
export function applyThemeToIdentity(outDir: string, params: unknown): string[] {
  withThemeParams({ name: 'Tema' }, params);
  const p = params as { theme?: ThemeParams & { fonts?: { import?: string } }; overrides?: Record<string, string>; overridesDark?: Record<string, string> };
  const theme = p.theme ?? {};
  // Un @import tiene que ir al principio de la hoja, antes que lo del agente: sin pack no hay dónde ponerlo.
  if (theme.fonts?.import) throw new Error('applyTheme: theme.fonts.import necesita un pack de marca');
  const file = join(outDir, 'src', 'identity.css');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const at = current.indexOf(PANEL_START);
  const agentCss = at >= 0 ? current.slice(0, at) : current;
  const agent = contractFromCss(agentCss);
  const contract = contractThemes();
  const own = { ...(p.overrides ?? {}) };
  const ownDark = { ...(p.overridesDark ?? {}) };
  const derived = deriveTheme(theme, own, ownDark);
  // deriveTheme pone el preset neutral cuando no hay preset ni semilla; aquí el acento del agente tiene que quedar, y un
  // preset nombrado lo pinta data-accent (foundation.css:163-177), no la capa.
  const presetKeys = new Set([...Object.keys(deriveTheme({}).light), ...Object.keys(deriveTheme({}).dark)]);
  const fromPreset = (t: string): boolean => !theme.seed && presetKeys.has(t) && !(t in own) && !(t in ownDark);
  const htmlPath = join(outDir, 'index.html');
  const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : '';
  const accentAttr = theme.seed || ACCENT_TOKENS.some((t) => t in own) ? undefined : theme.preset ?? /\sdata-accent="([^"]*)"/.exec(html)?.[1];
  const preset = accentAttr ? deriveTheme({ preset: accentAttr }) : { light: {}, dark: {} };
  // El valor que la página ya pinta sin la capa: contrato, preset por atributo y lo que declaró el agente.
  const effLight = { ...contract.light, ...preset.light, ...agent.light };
  const effDark = { ...contract.light, ...contract.dark, ...preset.light, ...preset.dark, ...agent.light, ...agent.dark };
  const light = Object.fromEntries(Object.entries(derived.light).filter(([t, v]) => !fromPreset(t) && effLight[t] !== v));
  // La capa clara también rige en zonas oscuras ([data-theme]); lo oscuro solo hace falta donde difiere de eso.
  const darkBase = { ...effDark, ...light };
  const dark = Object.fromEntries(Object.entries(derived.dark).filter(([t, v]) => !fromPreset(t) && darkBase[t] !== v));

  const touched = new Set([...Object.keys(light), ...Object.keys(dark), ...(theme.preset ? Object.keys({ ...preset.light, ...preset.dark }) : [])]);
  const tables = { light: { ...effLight, ...light }, dark: { ...darkBase, ...dark } };
  const aa = packAaErrors(tables, touched);
  if (aa.length) throw new Error(`applyTheme: contraste insuficiente\n${aa.map((e) => `- ${e}`).join('\n')}`);

  const decls = (m: Record<string, string>) => Object.entries(m).map(([t, v]) => `  ${t}: ${v};`).join('\n');
  const layer = [Object.keys(light).length ? `:root,\n[data-theme] {\n${decls(light)}\n}` : '', Object.keys(dark).length ? `[data-theme="dark"] {\n${decls(dark)}\n}` : ''].filter(Boolean).join('\n');
  const next = layer ? `${agentCss}${agentCss && !agentCss.endsWith('\n') ? '\n' : ''}${PANEL_START}\n${layer}\n${PANEL_END}\n` : agentCss;
  if (next !== current) writeFileSync(file, next);

  if (html) {
    let out = html;
    if (theme.preset) out = out.replace(/\sdata-accent="[^"]*"/, '').replace(/<html\b([^>]*)>/, `<html$1 data-accent="${theme.preset}">`);
    else if (!accentAttr) out = out.replace(/\sdata-accent="[^"]*"/, '');
    if (theme.colorMode) out = setHtmlTheme(out, theme.colorMode);
    if (out !== html) writeFileSync(htmlPath, out);
  }
  return [...new Set([...Object.keys(light), ...Object.keys(dark)])];
}

/** Escribe `data-theme` en el <html> del scaffold emitido (default light). Es el escritor que faltaba:
 * el tema se decidía en el template y no lo fijaba la app desde el brief. Puro sobre el string HTML. */
export function setHtmlTheme(html: string, theme: 'light' | 'dark'): string {
  return /\sdata-theme="[^"]*"/.test(html)
    ? html.replace(/\sdata-theme="[^"]*"/, ` data-theme="${theme}"`)
    : html.replace(/<html\b([^>]*)>/, `<html$1 data-theme="${theme}">`);
}

/** Fija `data-theme` en index.html de `outDir` desde el brief (default light). */
export function applyTheme(outDir: string, theme: 'light' | 'dark'): void {
  const htmlPath = join(outDir, 'index.html');
  if (!existsSync(htmlPath)) return;
  const html = readFileSync(htmlPath, 'utf8');
  const next = setHtmlTheme(html, theme);
  if (next !== html) writeFileSync(htmlPath, next);
}

/** Brand pack activo: `ref` (Brief.brand) si viene, luego WT_BRAND_PACK, luego el base agnóstico. */
export function activeBrandDir(ref?: string): string {
  return ref ?? process.env.WT_BRAND_PACK ?? fallbackBaseDir();
}

/** De dónde salió la marca y su huella: lo que flow.json registra para poder reproducir QUÉ marca se
 * aplicó (C13). Hoy la salida no lo registra, así que un run no es reproducible. */
export interface BrandTrace {
  /** Directorio del brand pack resuelto. */
  path: string;
  /** Precedencia que ganó: el brief, la variable de entorno, o el base agnóstico. */
  origin: 'brief' | 'env' | 'fallback';
  /** sha256 del brand.json aplicado; null si la marca activa no tiene brand.json (base vacío). */
  sha256: string | null;
  /** Nombres del contrato Arc (foundation.css) contra los que se mide la cobertura de marca (C1). */
  contractTokens: number;
}

/** Resuelve el brand pack activo con su procedencia y huella. Precedencia: Brief.brand > WT_BRAND_PACK
 * > base. Falla EXPLÍCITO si el brief nombra una marca cuyo brand.json no existe, en vez de caer en
 * silencio al pack neutro (la pérdida de marca que el informe 'Flujo de datos' documenta). */
export function resolveBrandTrace(ref?: string): BrandTrace {
  const origin: BrandTrace['origin'] = ref ? 'brief' : process.env.WT_BRAND_PACK ? 'env' : 'fallback';
  const path = activeBrandDir(ref);
  const file = join(path, 'brand.json');
  if (origin === 'brief' && !existsSync(file)) {
    throw new Error(`brand: el brief nombra "${ref}" pero no existe su brand.json (${file})`);
  }
  // Cierra el contrato en la carga (C1): si la marca con brand.json deja tokens sin definir ni heredar,
  // falla aquí en vez de emitir una página con 60 variables en su default sin que nadie lo dijera.
  if (existsSync(file)) assertBrandCoverage(parseBrandPack(JSON.parse(readFileSync(file, 'utf8')), { skipComponents: true }));
  const sha256 = existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
  return { path, origin, sha256, contractTokens: contractTokens().size };
}

/** Brand pack que el camino v0 aplica al crear el workspace: `ref` (--brand), luego WT_BRAND_PACK, luego
 * el base. undefined si la marca resuelta no trae brand.json (base ausente): la página queda neutra. */
export function workspaceBrandDir(ref?: string): string | undefined {
  const trace = resolveBrandTrace(ref);
  return trace.sha256 ? trace.path : undefined;
}

/** Lee el bloque composition del brand pack activo para que el planner lo use antes del emit.
 * undefined si no hay brand.json, si no parsea, o si la marca no declara composition. */
export function loadBrandComposition(ref?: string): BrandComposition | undefined {
  const file = join(activeBrandDir(ref), 'brand.json');
  if (!existsSync(file)) return undefined;
  return parseBrandPack(JSON.parse(readFileSync(file, 'utf8')), { skipComponents: true }).composition;
}

function fallbackBaseDir(): string {
  // El perfil decide la carpeta: core trae el base en brands/ y una distro trae los suyos junto a su repo.
  return join(config().brandsRoot, 'brand-pack');
}
