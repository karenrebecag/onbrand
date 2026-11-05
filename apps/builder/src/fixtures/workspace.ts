// Archivos de un workspace ya generado (generated/nimbus-waitlist) para el Code y el Diff del
// prototipo. Cuando el motor emita, esto sale de los `write` del log y de los archivos del workspace.
import app from './workspace/App.tsx.txt?raw'
import cta13 from './workspace/cta-13.tsx.txt?raw'
import cta13Css from './workspace/cta-13.module.css.txt?raw'
import indexCss from './workspace/index.css.txt?raw'
// page.json real del composer en dos pasos (features de Nimbus), con provenance; no es el de esta página.
import pageJson from './workspace/page.json.txt?raw'

export interface WorkspaceFile {
  path: string
  content: string
}

export const workspaceFiles: WorkspaceFile[] = [
  { path: 'src/App.tsx', content: app },
  { path: 'src/index.css', content: indexCss },
  { path: 'src/components/relume/cta-13/cta-13.tsx', content: cta13 },
  { path: 'src/components/relume/cta-13/cta-13.module.css', content: cta13Css },
  { path: 'page.json', content: pageJson },
]
