// Vista previa del panel Tema: el builder manda la salida de deriveTheme (src/theme/derive.ts) y la página la pinta
// al instante, sin versión ni build (specs/panel-tema-params.md:55). El iframe es de otro origen, así que el panel no
// puede tocar el CSS; lo hace este puente. Mismo contrato que los demás: solo el origen fijo que llega por env.

export const WT_THEME_MESSAGE = 'wt:theme';
export type ThemeMode = 'light' | 'dark';
export type TokenMap = Record<string, string>;
export interface ThemePreview { light: TokenMap; dark: TokenMap; colorMode?: ThemeMode }
/** `theme: null` quita la vista previa y la página vuelve a su identidad (Descartar). */
export interface ThemeMessage { type: typeof WT_THEME_MESSAGE; theme: ThemePreview | null }

export const STYLE_ID = 'wt-theme-preview';

// El mismo guard que derive.ts:32-33: el valor termina dentro de una regla, así que no puede cerrarla ni colar
// @import/url(). El builder es de confianza, pero el mensaje cruza un límite de origen.
const UNSAFE_TOKEN_VALUE = /[;{}@<]|\/\*|\*\/|url\(|expression\(/i;
const TOKEN_NAME = /^--[a-z0-9-]+$/;

function tokenMap(v: unknown): TokenMap | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: TokenMap = {};
  for (const [k, val] of Object.entries(v)) {
    if (!TOKEN_NAME.test(k) || typeof val !== 'string' || !val.trim() || UNSAFE_TOKEN_VALUE.test(val)) return null;
    out[k] = val.trim();
  }
  return out;
}

/** El mensaje viene de afuera de la página: solo el del builder y con la forma exacta. undefined = no es para mí. */
export function parseThemeMessage(data: unknown, eventOrigin: string, builderOrigin: string): ThemePreview | null | undefined {
  if (eventOrigin !== builderOrigin || typeof data !== 'object' || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (d.type !== WT_THEME_MESSAGE) return undefined;
  if (d.theme === null) return null;
  if (typeof d.theme !== 'object' || d.theme === undefined) return undefined;
  const t = d.theme as Record<string, unknown>;
  const light = tokenMap(t.light);
  const dark = tokenMap(t.dark);
  if (!light || !dark) return undefined;
  if (t.colorMode !== undefined && t.colorMode !== 'light' && t.colorMode !== 'dark') return undefined;
  return { light, dark, ...(t.colorMode ? { colorMode: t.colorMode as ThemeMode } : {}) };
}

const block = (selector: string, tokens: TokenMap): string =>
  Object.keys(tokens).length ? `${selector} {\n${Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}` : '';

/** La hoja de la vista previa. Los mismos selectores que identity.css (brand.ts identityCss) duplicados: así gana a
 * identity.css y a los bloques de modo de foundation.css (:5-6, :115) sin depender del orden en que vite inyecta los
 * estilos. deriveTheme ya resolvió el modo oscuro como claro + oscuro (derive.ts:85-91). */
export function themeCss(theme: ThemePreview): string {
  return [block(':root:root,\n[data-theme][data-theme]', theme.light), block('[data-theme="dark"][data-theme="dark"]', theme.dark)].filter(Boolean).join('\n') + '\n';
}

/** Instala el puente y devuelve cómo quitarlo. Inerte si no hay origen o si la página no está dentro de un iframe. */
export function installThemeBridge(win: Window, origin: string | undefined): () => void {
  if (!origin || win.parent === win) return () => {};
  const html = win.document.documentElement;
  // Lo que la página tenía antes de la primera vista previa, para que Descartar la deje igual.
  let saved: { accent: string | null; theme: string | null } | null = null;
  const restore = (): void => {
    win.document.getElementById(STYLE_ID)?.remove();
    if (!saved) return;
    for (const [attr, value] of [['data-accent', saved.accent], ['data-theme', saved.theme]] as const) {
      if (value === null) html.removeAttribute(attr);
      else html.setAttribute(attr, value);
    }
    saved = null;
  };
  const apply = (theme: ThemePreview): void => {
    saved ??= { accent: html.getAttribute('data-accent'), theme: html.getAttribute('data-theme') };
    // deriveTheme trae los tokens del preset escritos; las reglas [data-accent] de foundation.css (:163-177) llevan
    // más especificidad en las zonas oscuras y repintarían el acento viejo.
    html.removeAttribute('data-accent');
    if (theme.colorMode) html.setAttribute('data-theme', theme.colorMode);
    let style = win.document.getElementById(STYLE_ID);
    if (!style) {
      style = win.document.createElement('style');
      style.id = STYLE_ID;
      win.document.head.appendChild(style);
    }
    style.textContent = themeCss(theme);
  };
  const onMessage = (event: MessageEvent): void => {
    const theme = parseThemeMessage(event.data, event.origin, origin);
    if (theme === undefined) return;
    if (theme === null) restore();
    else apply(theme);
  };
  win.addEventListener('message', onMessage);
  return () => {
    win.removeEventListener('message', onMessage);
    restore();
  };
}
