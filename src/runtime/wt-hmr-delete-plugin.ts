// Borrar un módulo que su importador ya dejó de importar no es un cambio que el preview tenga que aplicar (QA u3 sobre
// #723). Quitar una sección escribe App.tsx sin el import y borra el archivo en el mismo tick. Vite manda el update de
// App y también uno del archivo borrado: su nodo sigue en el grafo, porque el cliente todavía no volvió a pedir App y
// vite no podó. El cliente pide el módulo, recibe 404 y el builder lo ve como wt:runtime-error ("Failed to reload").
// Diferir el borrado no lo arregla: vite manda el update del borrado incluso después del prune. Lo que lo arregla es no
// mandarlo cuando ningún importador lo sigue importando en disco. Si un importador todavía lo importa, el error es real
// y el update sale como siempre.
// Lo mismo al volver a crear ese archivo (duplicar → quitar → duplicar): su nodo podado sigue en el grafo sin importadores
// y vite manda un update suyo antes que el de App. El primer duplicado no lo manda, y QA vio full-reload solo en el
// segundo; sin ese update los dos mandan lo mismo. Solo en src/sections/: un entry tampoco tiene importadores y su
// update al crearse sí importa.
// Va en el config del runtime (preview-vite.config.ts), no en el del ws: así llega también a los chats viejos (A11).
// Sin `import 'vite'`: el transport no tiene vite instalado; el plugin solo usa la forma del hook (vite 8.3.4
// HotUpdateOptions, index.d.ts:1346).
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

interface ModuleNode { readonly file: string | null; readonly importers: ReadonlySet<ModuleNode> }
interface HotUpdateOptions { readonly type: 'create' | 'update' | 'delete'; readonly file: string; readonly modules: readonly ModuleNode[] }
export interface HmrDeletePlugin {
  name: string;
  hotUpdate: (opts: HotUpdateOptions) => ModuleNode[] | undefined;
}

const SECTION_FILE = /\/src\/sections\/[^/]+$/;
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ¿El importador, tal como está ahora en disco, sigue importando el archivo? Por el nombre sin extensión dentro del
 *  especificador (`'./sections/08-faq-2'`, con o sin `.tsx`): `08-faq` no coincide con `08-faq-2`. */
export function stillImports(importer: string, deleted: string): boolean {
  if (!existsSync(importer)) return false;
  const name = escRe(basename(deleted).replace(/\.[cm]?[jt]sx?$/, ''));
  return new RegExp(`['"][^'"\\n]*/${name}(?:\\.[cm]?[jt]sx?)?['"]`).test(readFileSync(importer, 'utf8'));
}

export function wtHmrDeletePlugin(): HmrDeletePlugin {
  return {
    name: 'wt-hmr-delete',
    hotUpdate(opts) {
      if (opts.type === 'delete') {
        const orphan = opts.modules.every((m) => [...m.importers].every((i) => !i.file || !stillImports(i.file, opts.file)));
        return orphan ? [] : undefined;
      }
      if (opts.type === 'create' && SECTION_FILE.test(opts.file) && opts.modules.every((m) => m.importers.size === 0)) return [];
      return undefined;
    },
  };
}
