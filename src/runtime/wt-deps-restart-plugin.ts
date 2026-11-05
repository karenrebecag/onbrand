// Ex HACK #7 (run-checks.ts installDeps): tras un install con una dep nueva, el vite vivo del ws seguía con "Failed to
// resolve import" 60 s después y tras recargar (QA, montaje real; #758). Vite cachea el fallo de resolución del import y
// no mira node_modules: ni invalidar el módulo ni vaciar packageCache lo resuelven; server.restart() sí (vite 8.3.4,
// medido sobre el caso de #758). installDeps escribe node_modules/.wt-installed con el hash de package.json + lockfile al
// terminar bien: cuando ese hash cambia con el server vivo, el plugin reinicia el server en el mismo proceso y puerto, y el
// cliente HMR recarga al reconectar. Un install que no cambia deps no reescribe la marca (installDeps sale antes).
// Va en el config del runtime (preview-vite.config.ts), no en el del ws: así llega también a los chats viejos (A11).
// Sin `import 'vite'`: el transport no tiene vite instalado; solo se usa la forma del hook.
import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { join } from 'node:path';

/** Marca de install completo en node_modules (run-checks installDeps); shared.ts la reexporta. */
export const INSTALLED_MARK = '.wt-installed';

interface RestartableServer {
  readonly config: { readonly root: string };
  restart: () => Promise<void>;
  close: () => Promise<void>;
}
export interface DepsRestartPlugin {
  name: string;
  apply: 'serve';
  configureServer: (server: RestartableServer) => void;
}

// Sondeo y no fs.watch: node_modules se crea y se reemplaza entero en un install y un watcher de carpeta se queda colgado
// del inodo viejo. Medio segundo basta frente a lo que tarda un install.
export const MARK_POLL_MS = 500;

const read = (file: string): string => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

export function wtDepsRestartPlugin(pollMs: number = MARK_POLL_MS): DepsRestartPlugin {
  return {
    name: 'wt-deps-restart',
    apply: 'serve',
    configureServer(server) {
      const mark = join(server.config.root, 'node_modules', INSTALLED_MARK);
      // El hash con que arrancó este server: restart() vuelve a llamar a configureServer y relee el vigente, sin bucle.
      let seen = read(mark);
      let restarting = false;
      const onChange = (): void => {
        const now = read(mark);
        // Vacío = installDeps borró la marca antes de instalar: todavía no hay node_modules nuevo que ver.
        if (!now || now === seen || restarting) return;
        seen = now;
        restarting = true;
        unwatchFile(mark, onChange);
        void server.restart().catch(() => { restarting = false; watchFile(mark, { interval: pollMs }, onChange); });
      };
      watchFile(mark, { interval: pollMs }, onChange);
      // restart() y el apagado cierran este server: sin esto cada reinicio dejaría un sondeo vivo del server viejo.
      const close = server.close.bind(server);
      server.close = async () => { unwatchFile(mark, onChange); return close(); };
    },
  };
}
