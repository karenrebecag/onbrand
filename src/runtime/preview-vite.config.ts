// Config de vite del transport para el preview y el build de versión (`vite --config <este archivo>`, cwd = workspace):
// carga el vite.config.ts del workspace tal cual y le suma el plugin wt-bridges, que sirve los puentes del scaffold actual.
// El vite.config del ws es una copia del scaffold de cuando se creó el chat: un plugin puesto ahí no llegaría a los viejos.
// Vite sale del node_modules del ws (el transport no lo instala): el mismo con que corre el comando.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PUBLISH_MODE, wtBridgesPlugin } from './wt-bridges-plugin';
import { wtDepsRestartPlugin } from './wt-deps-restart-plugin';
import { wtHmrDeletePlugin } from './wt-hmr-delete-plugin';

/** El src con los puentes; WT_BRIDGES_DIR lo cambia (tests, un scaffold fuera del repo). Sale del scaffold base y no del
 *  `scaffoldDir` del perfil: los puentes son del core y una distro con su propio scaffold los recibe igual (B9 paso 1). */
export const bridgesDir = (): string => process.env.WT_BRIDGES_DIR ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'templates', 'base-scaffold', 'src');

export default async (env: { command: 'build' | 'serve'; mode: string }) => {
  const root = process.cwd();
  const vite = (await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('vite')).href)) as {
    loadConfigFromFile: (env: unknown, file: string, root: string) => Promise<{ config: Record<string, unknown> } | null>;
    mergeConfig: (a: Record<string, unknown>, b: Record<string, unknown>) => Record<string, unknown>;
  };
  const loaded = await vite.loadConfigFromFile(env, join(root, 'vite.config.ts'), root);
  return vite.mergeConfig(loaded?.config ?? {}, { root, plugins: [wtBridgesPlugin(root, bridgesDir(), { inject: env.mode !== PUBLISH_MODE }), wtHmrDeletePlugin(), wtDepsRestartPlugin()] });
};
