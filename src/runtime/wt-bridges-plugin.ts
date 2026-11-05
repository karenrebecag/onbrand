// Puentes del preview servidos desde el scaffold actual y no desde el workspace (hallazgo Q3 de QA: prepareWorkspace sale
// si el ws ya es repo, así que un chat anterior a un puente nuevo nunca lo recibía). El vite del ws corre con el config del
// transport (preview-vite.config.ts), que le suma este plugin:
//   - inyecta `wt-bridges.ts` del scaffold antes del script de la página;
//   - los imports `./wt-*` del ws (bridges, hmr-recover, wt-source) resuelven al archivo del scaffold, así hay una sola
//     instancia de cada uno (wt-source guarda el mapa inverso que lee select-bridge);
//   - desde src/main.tsx, que en un ws viejo sigue importando e instalando sus puentes, las funciones `install*` son no-op:
//     el único que instala es el script inyectado, sin listeners dobles.
// El árbol y el git del ws no se tocan.
// Con `inject: false` (build de publish, P3 nota B) no se inyecta nada y main.tsx de un ws viejo sigue yendo al stub: sin
// el plugin, ese main.tsx empaquetaría su copia de los puentes en el sitio publicado.
// Sin `import 'vite'`: el transport no tiene vite instalado; el plugin solo usa la forma de los hooks.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const BRIDGES_ENTRY_URL = '/@wt-bridges';
const STUB_PREFIX = '\0wt-bridge-stub:';

/** Archivo del scaffold → las funciones que main.tsx instalaba de él. Solo agregar, nunca quitar ni renombrar (A11): un
 *  main.tsx viejo las sigue importando por nombre, y una que falte en el stub rompe el build de ese ws. */
export const BRIDGE_INSTALLS: Readonly<Record<string, readonly string[]>> = {
  'wt-error-bridge': ['installErrorBridge'],
  'wt-size-bridge': ['installSizeBridge'],
  'wt-reveal-bridge': ['installRevealBridge'],
  'wt-select-bridge': ['installSelectBridge'],
  'wt-theme-bridge': ['installThemeBridge'],
  'wt-hmr-recover': ['installHmrRecover'],
};
// wt-source no se instala: lo usan el runtime jsx del ws y select-bridge, y tienen que ver el mismo módulo.
const SHARED = new Set([...Object.keys(BRIDGE_INSTALLS), 'wt-source']);
const SPEC = /^(?:\.\.?\/)+(wt-[a-z-]+)(?:\.tsx?)?$/;

interface HtmlTag { tag: string; attrs: Record<string, string>; injectTo: 'head-prepend' }
export interface BridgesPlugin {
  name: string;
  enforce: 'pre';
  config: () => { server: { fs: { allow: string[] } } };
  resolveId: (id: string, importer?: string) => string | null;
  load: (id: string) => string | null;
  transformIndexHtml: { order: 'pre'; handler: () => HtmlTag[] };
}

/** Modo de vite del build de publish (`vite build --mode publish`): el dist sale sin puentes. */
export const PUBLISH_MODE = 'publish';

/** `root`: el workspace (raíz de vite). `bridgesDir`: el src del scaffold con los puentes actuales. `inject`: false en el
 *  build de publish. */
export function wtBridgesPlugin(root: string, bridgesDir: string, { inject = true }: { readonly inject?: boolean } = {}): BridgesPlugin {
  const ws = resolve(root);
  const src = join(ws, 'src');
  const fileOf = (name: string): string | undefined => ['.ts', '.tsx'].map((ext) => join(bridgesDir, `${name}${ext}`)).find(existsSync);
  // Un módulo del scaffold con su nombre: una ruta absoluta al ws/src (la del runtime jsx) o un relativo desde el ws/src.
  const nameOf = (id: string, importer?: string): string | undefined => {
    const abs = /^(.*)\/(wt-[a-z-]+)\.tsx?$/.exec(id);
    if (abs && resolve(abs[1]!) === src) return SHARED.has(abs[2]!) ? abs[2] : undefined;
    const rel = SPEC.exec(id);
    if (!rel || !importer || !resolve(importer).startsWith(`${src}/`)) return undefined;
    return SHARED.has(rel[1]!) && resolve(importer, '..', id).replace(/\.tsx?$/, '') === join(src, rel[1]!) ? rel[1] : undefined;
  };
  return {
    name: 'wt-bridges',
    enforce: 'pre',
    // Fijar fs.allow apaga el default de vite (la raíz del workspace): va la raíz y el scaffold.
    config: () => ({ server: { fs: { allow: [ws, bridgesDir] } } }),
    resolveId(id, importer) {
      if (id === BRIDGES_ENTRY_URL) return fileOf('wt-bridges') ?? null;
      const name = nameOf(id, importer);
      if (!name) return null;
      if (importer && resolve(importer) === join(src, 'main.tsx') && BRIDGE_INSTALLS[name]) return `${STUB_PREFIX}${name}`;
      return fileOf(name) ?? null;
    },
    load(id) {
      if (!id.startsWith(STUB_PREFIX)) return null;
      const name = id.slice(STUB_PREFIX.length);
      const real = fileOf(name);
      // Las exportaciones locales tapan a las de `export *`: constantes y tipos siguen siendo los del puente actual.
      return [...(real ? [`export * from ${JSON.stringify(real)};`] : []), ...(BRIDGE_INSTALLS[name] ?? []).map((fn) => `export function ${fn}() { return () => {}; }`)].join('\n');
    },
    // 'pre': el tag entra al HTML antes de que el build lo procese, así el entry se empaqueta en el dist (en 'post' quedaba
    // un <script src="/@wt-bridges"> suelto que el estático no sirve).
    transformIndexHtml: { order: 'pre', handler: () => (inject ? [{ tag: 'script', attrs: { type: 'module', src: BRIDGES_ENTRY_URL }, injectTo: 'head-prepend' }] : []) },
  };
}
