import { useMemo, useState } from 'react'
import { FileIcon } from 'lucide-react'
import { Accordion } from '@/components/arc/accordion/accordion'
import { CodeBlock } from '@/components/arc/code-block/code-block'
import { ResizablePanel, ResizablePanels } from '@/components/arc/resizable-panels/resizable-panels'
import { TreeView, type TreeNode } from '@/components/arc/tree-view/tree-view'
import type { PagePlanMd } from '@engine/page-plan-md'
import type { DiffFile, WorkspaceFile } from '@/lib/run-client'
import { patchLines } from '@/lib/patch'
import styles from './builder.module.css'

const extOf = (path: string) => path.split('.').pop() ?? ''

/** Árbol de carpetas a partir de rutas planas; las carpetas abren y los archivos se seleccionan. */
function toTree(files: WorkspaceFile[]): TreeNode[] {
  type Dir = { children: Map<string, Dir>; files: string[] }
  const root: Dir = { children: new Map(), files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let dir = root
    for (const p of parts.slice(0, -1)) {
      if (!dir.children.has(p)) dir.children.set(p, { children: new Map(), files: [] })
      dir = dir.children.get(p) as Dir
    }
    dir.files.push(f.path)
  }
  const build = (dir: Dir, prefix: string): TreeNode[] => [
    ...[...dir.children].map(([name, sub]) => ({ id: `${prefix}${name}/`, label: name, children: build(sub, `${prefix}${name}/`) })),
    ...dir.files.map((path) => ({ id: path, label: path.split('/').pop() as string, icon: <FileIcon size={14} /> })),
  ]
  return build(root, '')
}

export function CodePane({ files }: { files: WorkspaceFile[] }) {
  const tree = useMemo(() => toTree(files), [files])
  const [selected, setSelected] = useState<WorkspaceFile | null>(files.find((f) => f.path === 'src/App.tsx') ?? null)
  return (
    <ResizablePanels label="Code" className={styles.workspace}>
      <ResizablePanel id="tree" label="Files" defaultSize={28} minSize={18}>
        <div className={styles.treePane}>
          <TreeView nodes={tree} defaultExpandedIds={['src/']} onSelect={(n) => setSelected(files.find((f) => f.path === n.id) ?? selected)} />
        </div>
      </ResizablePanel>
      <ResizablePanel id="file" label="File" defaultSize={72} minSize={30}>
        <div className={styles.pane}>
          {selected ? <CodeBlock key={selected.path} code={selected.content} filename={selected.path} language={extOf(selected.path)} /> : <div className={styles.empty}>Elige un archivo del árbol.</div>}
        </div>
      </ResizablePanel>
    </ResizablePanels>
  )
}

export function DiffPane({ files }: { files: DiffFile[] }) {
  if (!files.length) return <div className={`${styles.workspace} ${styles.empty}`}>El diff aparece cuando termina la corrida.</div>
  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)
  const items = files.map((f) => ({
    title: `${f.path}  +${f.additions} -${f.deletions}`,
    content: (
      <pre className={styles.diffLines}>
        {patchLines(f.patch).map((l, i) => (
          <div key={i} className={styles.diffLine} data-kind={l.kind}>
            <span className={styles.lineNo}>{l.no}</span>
            <span className={styles.lineText}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '} {l.text}</span>
          </div>
        ))}
      </pre>
    ),
  }))
  return (
    <div className={`${styles.workspace} ${styles.pane}`}>
      <p className={styles.diffMeta}>{files.length} files changed <span className={styles.added}>+{additions}</span> <span className={styles.removed}>-{deletions}</span></p>
      <Accordion items={items} defaultOpen={-1} />
    </div>
  )
}

const fieldLabel = (s: string) => (s === 'cta' ? 'CTA' : s.charAt(0).toUpperCase() + s.slice(1))

/** El plan que el agente escribió antes de las secciones, de solo lectura: se edita pidiéndolo en el chat, que es
 * donde el agente lo reescribe primero (ADR 0012). */
export function PlanPane({ plan, pendingImages }: { plan: PagePlanMd | undefined; pendingImages: string[] }) {
  return (
    <div className={`${styles.workspace} ${styles.pane}`}>
      {/* La clave de page-plan.md va sin tilde (la lee el agente); a la persona se le muestra con ella. */}
      {plan?.header.map((line, i) => <p key={i} className={styles.diffMeta}>{line.replace(/^direccion:/, 'Dirección:')}</p>)}
      {pendingImages.length > 0 && (
        <p className={styles.diffMeta}>Imágenes pendientes, con un placeholder gris en la página: {pendingImages.join(', ')}</p>
      )}
      {plan?.sections.map((s) => (
        <section key={s.slug} className={styles.planSection}>
          <h3 className={styles.diffHead}>{s.slug}{s.anchor ? ` · #${s.anchor}` : ''}</h3>
          <dl className={styles.planFields}>
            {Object.entries(s.fields).map(([k, v]) => (
              <div key={k} className={styles.planField}>
                <dt>{fieldLabel(k)}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
