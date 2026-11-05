import { expect, test } from 'bun:test';
import { deriveTheme } from '../src/theme/derive';
import { installThemeBridge, parseThemeMessage, STYLE_ID, themeCss } from '../templates/base-scaffold/src/wt-theme-bridge';

const BUILDER = 'http://localhost:5350';

test('el tema solo cuenta desde el builder, con la forma exacta y sin valores que cierren la regla', () => {
  const theme = { light: { '--accent': '#7747ff' }, dark: { '--accent': '#a78bff' } };
  expect(parseThemeMessage({ type: 'wt:theme', theme }, BUILDER, BUILDER)).toEqual(theme);
  expect(parseThemeMessage({ type: 'wt:theme', theme: null }, BUILDER, BUILDER)).toBeNull();
  expect(parseThemeMessage({ type: 'wt:theme', theme }, 'https://evil.example', BUILDER)).toBeUndefined();
  expect(parseThemeMessage({ type: 'wt:generating', theme }, BUILDER, BUILDER)).toBeUndefined();
  expect(parseThemeMessage({ type: 'wt:theme', theme: { ...theme, light: { '--accent': 'red; } body { display: none' } } }, BUILDER, BUILDER)).toBeUndefined();
  expect(parseThemeMessage({ type: 'wt:theme', theme: { ...theme, light: { accent: 'red' } } }, BUILDER, BUILDER)).toBeUndefined();
  expect(parseThemeMessage({ type: 'wt:theme', theme: { ...theme, colorMode: 'sepia' } }, BUILDER, BUILDER)).toBeUndefined();
  // El contrato con el builder: lo que emite deriveTheme pasa tal cual.
  const derived = deriveTheme({ preset: 'violet', colorMode: 'dark', roundness: 1.5 });
  expect(parseThemeMessage({ type: 'wt:theme', theme: derived }, BUILDER, BUILDER)).toEqual({ light: derived.light, dark: derived.dark, colorMode: 'dark' });
});

function fakePage(attrs: Record<string, string>) {
  const html = { attrs: { ...attrs }, getAttribute: (n: string) => html.attrs[n] ?? null, setAttribute: (n: string, v: string) => { html.attrs[n] = v; }, removeAttribute: (n: string) => { delete html.attrs[n]; } };
  const styles: { id: string; textContent: string | null; remove(): void }[] = [];
  let listener: ((e: { data: unknown; origin: string }) => void) | undefined;
  const win = {
    parent: {},
    document: {
      documentElement: html,
      head: { appendChild: (s: (typeof styles)[number]) => styles.push(s) },
      getElementById: (id: string) => styles.find((s) => s.id === id) ?? null,
      createElement: () => { const s = { id: '', textContent: null as string | null, remove: () => { styles.splice(styles.indexOf(s), 1); } }; return s; },
    },
    addEventListener: (_: 'message', l: typeof listener) => { listener = l; },
    removeEventListener: () => { listener = undefined; },
  };
  return { win, html, styles, send: (data: unknown, origin = BUILDER) => listener?.({ data, origin }) };
}

test('la vista previa pinta las variables derivadas encima de la identidad y Descartar deja la página como estaba', () => {
  const page = fakePage({ 'data-accent': 'orange', 'data-theme': 'light' });
  const stop = installThemeBridge(page.win as unknown as Window, BUILDER);
  const theme = deriveTheme({ preset: 'violet', colorMode: 'dark' });

  page.send({ type: 'wt:theme', theme });
  expect(page.styles).toHaveLength(1);
  expect(page.styles[0].id).toBe(STYLE_ID);
  expect(page.styles[0].textContent).toBe(themeCss(theme));
  expect(page.styles[0].textContent).toContain('--accent: #7747ff;');
  // Las reglas [data-accent="orange"] de foundation.css repintarían el acento viejo en las zonas oscuras.
  expect(page.html.attrs).toEqual({ 'data-theme': 'dark' });

  page.send({ type: 'wt:theme', theme: deriveTheme({ preset: 'blue' }) });
  expect(page.styles).toHaveLength(1);
  expect(page.styles[0].textContent).toContain('--accent: #0562ef;');

  page.send({ type: 'wt:theme', theme: null });
  expect(page.styles).toHaveLength(0);
  expect(page.html.attrs).toEqual({ 'data-accent': 'orange', 'data-theme': 'light' });

  page.send({ type: 'wt:theme', theme }, 'https://evil.example');
  expect(page.styles).toHaveLength(0);
  stop();
});
