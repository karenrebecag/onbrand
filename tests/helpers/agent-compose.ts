// Compose estilo-agente para los tests de transporte. El runner se retiró (C5): ya no hay un camino que convierta un
// PageModel en TSX, así que los tests que antes devolvían una página "pelada" ahora escriben los archivos en el workspace
// como lo hace el agente y los reportan en agent.files. Un archivo por sección (NN-rol.tsx) + App.tsx, con el mismo
// nombre que usaba buildWorkspace, para que las aserciones de contenido y de snapshot sigan valiendo. El cuerpo de cada
// sección rinde su texto visible como JSX, de modo que las ediciones directas (textEdit, patch-ai) lo encuentren tal
// cual lo encontraban sobre el TSX del runner.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentPageInfo } from '../../src/runtime/agent-composer';
import { projectDocument } from '../../src/runtime/page-doc';
import { remountApp } from '../../src/runtime/run-cycle-mount';
import type { PageModel, RunnerSection } from '../../src/runtime/runner';
import type { ComposeRequest } from '../../src/runtime/server';

// Claves cuyos valores string son código (clases, rutas, ids, variantes), no texto visible: el mismo conjunto que
// text-edit.ts salta, más las estructurales del modelo. No se rinden como texto editable.
const CODE_KEYS = new Set([
  'className', 'class', 'href', 'src', 'id', 'key', 'to', 'slug', 'icon', 'variant', 'size', 'type', 'name', 'as',
  'rel', 'target', 'tone', 'color', 'style', 'component', 'role', '$slot', 'brand',
]);

const fileBase = (index: number, role: string): string =>
  `${String(index + 1).padStart(2, '0')}-${role.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section'}`;

/** Recoge el texto visible de un nodo del árbol (props fuera de CODE_KEYS), en orden de aparición. */
function visibleText(node: unknown, into: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) visibleText(n, into);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (CODE_KEYS.has(k)) continue;
    if (typeof v === 'string') { if (v.trim()) into.push(v); continue; }
    visibleText(v, into);
  }
}

function sectionSource(rel: string, section: RunnerSection): string {
  const texts: string[] = [];
  visibleText(section.children ?? [], texts);
  visibleText(section.parts ?? [], texts);
  // El texto va como literal en una expresión JSX (`{"..."}`), no como texto JSX plano: así una edición directa sobre él
  // no es "typeSafe" y pasa por tsc, igual que sobre el TSX que rendía el runner (un texto plano saltaría el typecheck).
  const body = texts.length ? texts.map((t) => `      <span>{${JSON.stringify(t)}}</span>`).join('\n') : '      <span />';
  return `// ${rel}\nexport default function Section() {\n  return (\n    <section>\n${body}\n    </section>\n  );\n}\n`;
}

/** Rutas que el agente "escribió": App.tsx + una por sección, como el runner las nombraba. */
export function filesFor(page: Pick<PageModel, 'sections'>): string[] {
  return ['src/App.tsx', ...page.sections.map((s, i) => `src/sections/${fileBase(i, s.role)}.tsx`)];
}

/** Escribe los archivos de `page` en el workspace del agente y devuelve la página con su `agent`. `extra` fija
 * campos de AgentPageInfo (failed, sessionId, files propios, summary, question, …) como haría un turno real. */
export function writeAgentPage(req: ComposeRequest, page: PageModel, extra: Partial<AgentPageInfo> = {}): PageModel {
  const dir = req.workspace?.dir;
  if (!dir) throw new Error('writeAgentPage necesita agent:true en el Runtime (req.workspace)');
  const files = extra.files ?? page.agent?.files ?? filesFor(page);
  const sectionFiles = files.filter((f) => f.startsWith('src/sections/'));
  // El agente reescribe la página: una sección que ya no está se borra del workspace (lo que buildWorkspace hacía solo).
  // Un turno que no escribió nada (files:[], p. ej. una pregunta o un arreglo sin cambios) no toca el árbol del padre.
  const sectionsDir = join(dir, 'src', 'sections');
  if (files.length && existsSync(sectionsDir)) for (const f of readdirSync(sectionsDir)) {
    const rel = `src/sections/${f}`;
    if (f.endsWith('.tsx') && !sectionFiles.includes(rel)) rmSync(join(dir, rel));
  }
  for (const rel of files) {
    if (rel === 'src/App.tsx') continue; // App.tsx lo monta el sistema (remountApp) desde las secciones, no el agente.
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    const sectionIndex = sectionFiles.indexOf(rel);
    const content = sectionIndex >= 0 && page.sections[sectionIndex] ? sectionSource(rel, page.sections[sectionIndex]!) : `// ${rel}\n`;
    writeFileSync(join(dir, rel), content);
  }
  // App.tsx con `<WtSection slug>` por sección, como lo rehace el sistema a medida que el agente escribe (run-cycle-mount).
  if (files.length) remountApp(dir, true);
  // En la ruta del agente el index.html lo escribe el agente (lang/title/description), y el transport lee de ahí el
  // contrato de página; el double lo proyecta desde page.page cuando la página lo trae (page-doc.projectDocument).
  const index = join(dir, 'index.html');
  if (page.page && existsSync(index)) writeFileSync(index, projectDocument(readFileSync(index, 'utf8'), page.page));
  return { ...page, agent: { files, summary: '', missing: [], suggestions: [], ...page.agent, ...extra } };
}

/** Composer de una sola página (el caso común `compose = async () => PAGE`). Para lógica por request
 * (empujar `req`, fallar, colgar) usa `writeAgentPage(req, page, extra)` dentro de tu propio composer. */
export function agentCompose(page: PageModel, extra: Partial<AgentPageInfo> = {}): (req: ComposeRequest) => Promise<PageModel> {
  return async (req) => writeAgentPage(req, page, extra);
}
