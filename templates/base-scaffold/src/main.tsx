import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
// Los puentes con el builder no se instalan aquí: los inyecta el transport desde el scaffold actual (wt-bridges.ts).

createRoot(document.getElementById('root')!, {
  // El boundary por sección (WtSection en App.tsx) ya reporta el error con el archivo de la sección; el log por
  // defecto de React lo repetiría sin atribución. Los demás boundaries se siguen reportando.
  onCaughtError(error, info) {
    if (!(info.errorBoundary?.constructor as { wtSection?: boolean } | undefined)?.wtSection) console.error(error, info.componentStack)
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
