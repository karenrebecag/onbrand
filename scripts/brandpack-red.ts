// Red de migración del brandpack v2 (PR #1). Fija lo que el pack produce HOY para que el rediseño del schema pruebe que
// no movió nada: (a) un snapshot de todo lo que sale de un pack (identidad por bloque, cobertura, DESIGN.md, appearance,
// brand.ts) y (b) el contraste medido en chromium de los pares que una página pinta. Ninguno juzga: registran el estado.
//   bun scripts/brandpack-red.ts --write   reescribe equivalencia.json (solo si el cambio es intencional)
//   bun scripts/brandpack-red.ts --aa      reescribe aa-report.json midiendo en chromium

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandCoverage, brandModule, parseBrandPack, resolveIdentity, type BrandPack } from '../src/brand';
import { AA_PAIRS } from '../src/brand-aa';
import { brandAppearance } from '../src/brand-skill';
import { packDesignFrontmatter } from '../src/identity-ephemeral';

const REPO = join(import.meta.dir, '..');
export const RED_DIR = join(REPO, 'tests', 'fixtures', 'brandpack-v2');
export const EQUIVALENCE_FILE = join(RED_DIR, 'equivalencia.json');
export const AA_FILE = join(RED_DIR, 'aa-report.json');
// El contrato del core (B9 paso 4): la red mide los packs contra el DS que monta un clon.
const FOUNDATION = join(REPO, 'templates', 'base-scaffold', 'src', 'theme', 'tokens.css');

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/** Los dos packs del repo y sintéticos que cubren cada canal del schema, sobre el contrato del core. Los de producción de
 * una distro tienen su propia red, junto a su DS (B9 paso 5). */
export function brandpackRaw(): Record<string, Record<string, unknown>> {
  return {
    'repo-base': json(join(REPO, 'brands', 'brand-pack', 'brand.json')),
    'repo-ejemplo': json(join(REPO, 'brands', 'brand-pack-ejemplo', 'brand.json')),
    'sint-preset': { name: 'Preset', accent: 'blue' },
    'sint-accent-propio': { name: 'Propio', accent: { base: '#1f4d3a', strong: '#163829', subtle: 'rgb(31 77 58 / 0.1)', foreground: '#ffffff' }, surface: { background: '#fbfaf7', foreground: '#14130f' }, tokensDark: { '--background': '#12130f', '--foreground': '#f4f2ec', '--accent': '#7fc8a4', '--accent-foreground': '#0d1a13' } },
    'sint-highlight': { name: 'Highlight', accent: { base: '#0a0a0a', strong: '#000000', subtle: 'rgb(10 10 10 / 0.06)', foreground: '#fafafa' }, surface: { background: '#fafafa', surface: '#ffffff', foreground: '#0a0a0a', textSecondary: '#525252' }, tokens: { '--brand-highlight': '#ff6600' } },
    'sint-forma': { name: 'Forma', accent: 'neutral', tokens: { '--scaling': '1.15', '--radius-factor': '1.6', '--text-5xl': '5.5rem' } },
  } as Record<string, Record<string, unknown>>;
}

export function brandpackCases(raw: Record<string, Record<string, unknown>> = brandpackRaw()): Record<string, BrandPack> {
  return Object.fromEntries(Object.entries(raw).map(([id, r]) => [id, parseBrandPack(r, { skipComponents: true })]));
}

/** Todo lo observable de un pack, como datos: el valor efectivo de cada token por bloque (no el texto del CSS, para que
 * reordenar declaraciones no cuente como cambio), la cobertura, el frontmatter de DESIGN.md, la appearance del skill y
 * el módulo brand.ts. */
export function snapshotOf(brand: BrandPack): Record<string, unknown> {
  const id = resolveIdentity(brand);
  const block = (decls: string[]) => Object.fromEntries(decls.map((d) => { const i = d.indexOf(':'); return [d.slice(0, i), d.slice(i + 1).replace(/;$/, '').trim()]; }));
  const cov = brandCoverage(brand);
  return {
    htmlAttrs: id.htmlAttrs,
    fontImport: id.fontImport ?? null,
    light: block(id.rootDeclarations),
    dark: block(id.darkDeclarations),
    coverage: { defined: [...cov.defined].sort(), inherited: [...cov.inherited].sort(), missing: cov.missing },
    designFrontmatter: packDesignFrontmatter(brand),
    appearance: brandAppearance(brand),
    brandModule: brandModule(brand),
  };
}

export const snapshotAll = (cases: Record<string, BrandPack> = brandpackCases()): Record<string, Record<string, unknown>> =>
  Object.fromEntries(Object.entries(cases).map(([id, b]) => [id, snapshotOf(b)]));

// Los pares viven en src/brand-aa.ts (el gate de applyBrand); la red mide los mismos en chromium.
export { AA_PAIRS };

export type AaReport = Record<string, Record<'light' | 'dark', Record<string, number>>>;

/** La hoja tal como la ve la página: contrato + identity.css del pack, sin el @import de fuentes (no cambia colores). */
function pageHtml(brand: BrandPack, theme: 'light' | 'dark'): string {
  const id = resolveIdentity(brand);
  const identity = [
    id.rootDeclarations.length ? `:root,\n[data-theme] {\n  ${id.rootDeclarations.join('\n  ')}\n}` : '',
    id.darkDeclarations.length ? `[data-theme="dark"] {\n  ${id.darkDeclarations.join('\n  ')}\n}` : '',
  ].join('\n');
  const attrs = Object.entries({ ...id.htmlAttrs, 'data-theme': theme }).map(([k, v]) => `${k}="${v}"`).join(' ');
  const cells = AA_PAIRS.map((p, i) => `<div id="c${i}" style="color: var(${p.fg}); background-color: var(${p.bg})">x</div>`).join('');
  return `<!doctype html><html ${attrs}><head><style>${readFileSync(FOUNDATION, 'utf8')}</style><style>${identity}</style></head><body style="background: var(--background)">${cells}</body></html>`;
}

/** Corre en la página: compone cada color sobre el fondo real con un canvas (resuelve oklch, color-mix y alpha igual que
 * el navegador) y devuelve la razón WCAG. Un fondo translúcido se compone sobre --background. */
function measureInPage(n: number): number[] {
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })!;
  const paint = (...colors: string[]): [number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    for (const c of colors) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const lum = (rgb: number[]) => { const l = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
  const page = getComputedStyle(document.body).backgroundColor;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = getComputedStyle(document.getElementById(`c${i}`)!);
    const bg = paint('#ffffff', page, s.backgroundColor);
    const fg = paint('#ffffff', page, s.backgroundColor, s.color);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    out.push(Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100);
  }
  return out;
}

export async function measureAA(cases: Record<string, BrandPack> = brandpackCases()): Promise<AaReport> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const report: AaReport = {};
    for (const [id, brand] of Object.entries(cases)) {
      report[id] = { light: {}, dark: {} };
      for (const theme of ['light', 'dark'] as const) {
        await page.setContent(pageHtml(brand, theme));
        const ratios = await page.evaluate(measureInPage, AA_PAIRS.length);
        AA_PAIRS.forEach((p, i) => { report[id][theme][`${p.fg} / ${p.bg}`] = ratios[i]; });
      }
    }
    return report;
  } finally {
    await browser.close();
  }
}

/** Pares bajo su umbral: lo que el reporte dice del estado actual, sin cambiar el comportamiento de nadie. */
export function belowThreshold(report: AaReport): string[] {
  const min = Object.fromEntries(AA_PAIRS.map((p) => [`${p.fg} / ${p.bg}`, p.min]));
  return Object.entries(report).flatMap(([id, themes]) => Object.entries(themes).flatMap(([theme, pairs]) =>
    Object.entries(pairs).filter(([pair, r]) => r < min[pair]).map(([pair, r]) => `${id} ${theme}: ${pair} ${r}:1 (mín ${min[pair]})`)));
}

if (import.meta.main) {
  if (process.argv.includes('--write')) writeFileSync(EQUIVALENCE_FILE, `${JSON.stringify(snapshotAll(), null, 2)}\n`);
  if (process.argv.includes('--aa')) {
    const report = await measureAA();
    writeFileSync(AA_FILE, `${JSON.stringify(report, null, 2)}\n`);
    const low = belowThreshold(report);
    process.stdout.write(`${low.length} pares bajo umbral\n${low.join('\n')}\n`);
  }
}
