import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argbFromRgb, Hct } from '@material/material-color-utilities';
import { AA_PAIRS, CONTRACT_DEBT, packAaErrors, pairRatios } from '../src/brand-aa';
import { brandAaTables, identityCss, parseBrandPack, withThemeParams } from '../src/brand';
import { contrast, parseColor } from '../src/color-contrast';
import { deriveTheme } from '../src/theme/derive';
import { NEUTRAL_TONES_DARK, NEUTRAL_TONES_LIGHT, SEED_VARIANTS, seedTheme, seedTokens } from '../src/theme/seed';
import presets from '../src/theme/presets.json';

// El contrato del core es tokens.css del base (#852); las tablas de seed.ts salen de él (neutral-tones.json, gen-theme-presets).
const css = readFileSync(join(import.meta.dir, '..', 'templates', 'base-scaffold', 'src', 'theme', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const block = (re: RegExp): Record<string, string> =>
  Object.fromEntries([...(new RegExp(`${re.source}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const contract = { light: block(/:root,\s*\[data-theme\]/), dark: block(/\[data-theme="dark"\]/) };
const rgb = (v: string) => parseColor(v) as [number, number, number];
const toneOf = (v: string) => Math.round(Hct.fromInt(argbFromRgb(...(rgb(v).map(Math.round) as [number, number, number]))).tone * 10) / 10;

describe('derivación de semilla', () => {
  test('la tabla de tonos neutros es la del contrato: recalculada desde tokens.css', () => {
    for (const [token, tone] of Object.entries(NEUTRAL_TONES_LIGHT)) expect(toneOf(contract.light[token]), token).toBe(tone);
    for (const [token, tone] of Object.entries(NEUTRAL_TONES_DARK)) expect(toneOf(contract.dark[token]), token).toBe(tone);
  });

  test('una semilla neutra gris reproduce los grises del contrato', () => {
    const { light, dark } = seedTokens({ accent: '#7747ff', neutral: '#808080' });
    for (const [mode, out] of [['light', light], ['dark', dark]] as const) {
      for (const token of Object.keys(mode === 'light' ? NEUTRAL_TONES_LIGHT : NEUTRAL_TONES_DARK)) {
        const [a, b] = [rgb(out[token]), rgb(contract[mode][token])];
        expect(Math.max(...a.map((c, i) => Math.abs(c - b[i]))), `${mode} ${token}: ${out[token]} vs ${contract[mode][token]}`).toBeLessThanOrEqual(2);
      }
    }
  });

  test('emite los mismos tokens que un preset, y la rampa solo con semilla neutra', () => {
    const { violet } = presets as Record<string, Record<'light' | 'dark', Record<string, string>>>;
    const only = seedTokens({ accent: '#0562ef' });
    expect(Object.keys(only.light).sort()).toEqual(Object.keys(violet.light).concat('--accent-foreground').sort());
    expect(Object.keys(only.dark).sort()).toEqual(Object.keys(violet.dark).concat('--accent-foreground').sort());
    const tinted = seedTokens({ accent: '#0562ef', neutral: '#f8f4ee' });
    expect(Object.keys(tinted.light)).toEqual([...Object.keys(only.light), ...Object.keys(NEUTRAL_TONES_LIGHT)]);
    expect(Object.keys(tinted.dark)).toEqual([...Object.keys(only.dark), ...Object.keys(NEUTRAL_TONES_DARK)]);
  });

  test('determinista, con el acento más fuerte hacia el texto y legible sobre su propio color', () => {
    const seed = { accent: '#8c4320', variant: 'fidelity' } as const;
    expect(seedTokens(seed)).toEqual(seedTokens(seed));
    for (const variant of Object.keys(SEED_VARIANTS) as (keyof typeof SEED_VARIANTS)[]) {
      for (const accent of ['#8c4320', '#ffeb3b', '#00bcd4', '#ff6600', '#7747ff']) {
        const { light, dark } = seedTokens({ accent, variant });
        // Material fija on-primary contra primary: el CTA se lee sin corrección en los dos modos.
        expect(contrast(rgb(light['--accent-foreground']), rgb(light['--accent'])), `${accent} ${variant} claro`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(rgb(dark['--accent-foreground']), rgb(dark['--accent'])), `${accent} ${variant} oscuro`).toBeGreaterThanOrEqual(4.5);
        for (const [mode, out, sign] of [['claro', light, -1], ['oscuro', dark, 1]] as const) {
          const [a, st] = [toneOf(out['--accent']), toneOf(out['--accent-strong'])];
          // Hacia el texto salvo que el acento ya esté en el extremo (monochrome oscuro = tono 100).
          expect(Math.abs(st - a), `${accent} ${variant} ${mode}`).toBeGreaterThan(5);
          if (a > 12 && a < 88) expect(Math.sign(st - a), `${accent} ${variant} ${mode}`).toBe(sign);
        }
      }
    }
  });

  test('rechaza lo que no es un hex o una variante conocida', () => {
    expect(() => seedTokens({ accent: 'oklch(50% .2 280)' })).toThrow('debe ser un hex de 6 dígitos');
    expect(() => seedTokens({ accent: '#7747ff', neutral: '#fff' })).toThrow('neutral "#fff"');
    expect(() => seedTokens({ accent: '#7747ff', variant: 'pastel' as never })).toThrow('variant "pastel" no existe');
  });
});

describe('semilla cableada: corrección AA, parser y vista previa', () => {
  const pairsOk = (light: Record<string, string>, dark: Record<string, string>, own: Record<string, string> = {}) => {
    const l = { ...contract.light, ...light, ...own };
    return { light: pairRatios(l), dark: pairRatios({ ...l, ...contract.dark, ...dark, ...own }) };
  };

  // Material ya da on-primary y primary legibles sobre el contrato (spec 2025): sin overrides no hay nada que corregir.
  // La corrección entra cuando la marca fija un fondo exacto que la escala de Material no conoce.
  const darkPage = { '--background': '#2b2b2b', '--surface': '#2b2b2b', '--surface-muted': '#333333', '--foreground': '#fafafa', '--text-secondary': '#d4d4d4' };

  test('lo derivado que no llega a AA se corrige por tono, con el mismo matiz, y lo exacto no se mueve', () => {
    expect(seedTheme({ accent: '#7747ff' }, contract).corrections).toEqual([]);
    const out = seedTheme({ accent: '#7747ff' }, contract, darkPage);
    expect(out.corrections.map((c) => `${c.mode} ${c.token}`)).toEqual(['light --accent', 'light --accent-foreground']);
    const ratios = pairsOk(out.light, out.dark, darkPage);
    for (const { fg, bg, min } of AA_PAIRS.filter((p) => !CONTRACT_DEBT.has(p.fg))) {
      expect(ratios.light[`${fg} / ${bg}`] as number, `claro ${fg}/${bg}`).toBeGreaterThanOrEqual(min);
      expect(ratios.dark[`${fg} / ${bg}`] as number, `oscuro ${fg}/${bg}`).toBeGreaterThanOrEqual(min);
    }
    const fix = out.corrections[0];
    const [a, b] = [fix.from, fix.to].map((h) => Hct.fromInt(argbFromRgb(...rgb(h))).hue);
    expect(Math.abs(a - b)).toBeLessThan(3);
    expect(out.light['--control-on']).toBe(out.light['--accent']);
    // Los overrides cuentan para medir pero no salen de la semilla ni se corrigen.
    for (const t of Object.keys(darkPage)) expect(out.light).not.toHaveProperty(t);
  });

  test('theme.seed en brand.json: aplica con el gate, guarda las correcciones y la vista previa da lo mismo', () => {
    const raw = { name: 'Semilla', theme: { seed: { accent: '#7747ff', neutral: '#f8f4ee' } }, overrides: darkPage };
    const brand = parseBrandPack(raw, { skipComponents: true });
    const preview = deriveTheme({ seed: raw.theme.seed }, darkPage);
    expect(preview.corrections.length).toBeGreaterThan(0);
    expect(brand.corrections).toEqual(preview.corrections);
    expect(typeof brand.accent === 'object' && brand.accent.base).toBe(preview.light['--accent']);
    expect(identityCss(brand)).toContain(`--accent: ${preview.light['--accent']}`);
    const { tables, touched } = brandAaTables(brand);
    expect(packAaErrors(tables, touched)).toEqual([]);

    expect(() => parseBrandPack({ name: 'X', theme: { preset: 'blue', seed: { accent: '#0562ef' } } })).toThrow('theme.preset y theme.seed se contradicen');
    expect(() => parseBrandPack({ name: 'X', theme: { seed: { accent: '#0562ef' } }, overrides: { '--accent': '#111111', '--accent-strong': '#000000', '--accent-subtle': '#eeeeee' } })).toThrow('theme.seed y un --accent');
    expect(() => parseBrandPack({ name: 'X', theme: { seed: { accent: '#0562ef', tono: 1 } } })).toThrow('clave desconocida "tono"');
    expect(() => parseBrandPack({ name: 'X', theme: { seed: { accent: 'blue' } } })).toThrow('debe ser un hex');
    expect(() => deriveTheme({ preset: 'blue', seed: { accent: '#0562ef' } })).toThrow('preset y seed se contradicen');
  });

  test('el panel manda una semilla: desplaza el preset y el acento propio de la marca, y conserva lo demás', () => {
    const pack = { name: 'P', theme: { preset: 'violet', fonts: { display: 'Fraunces' } }, overridesDark: { '--accent': '#a78bff', '--background': '#12130f' } };
    expect(withThemeParams(pack, { theme: { seed: { accent: '#0562ef' } } })).toEqual({ name: 'P', theme: { fonts: { display: 'Fraunces' }, seed: { accent: '#0562ef' } }, overridesDark: { '--background': '#12130f' } });
    const seeded = { name: 'S', theme: { seed: { accent: '#0562ef' } } };
    expect(withThemeParams(seeded, { theme: { preset: 'blue' } }).theme).toEqual({ preset: 'blue' });
  });
});
