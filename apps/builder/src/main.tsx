import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './components/arc/foundation.css'
import App from './App.tsx'

// Solo en dev con VITE_SPOTLIGHT=1: trazas del builder (fetch a /api, carga) a la UI local de Sentry; sin DSN.
if (import.meta.env.DEV && import.meta.env.VITE_SPOTLIGHT === '1') {
  const Sentry = await import('@sentry/react')
  Sentry.init({
    integrations: [Sentry.browserTracingIntegration(), Sentry.spotlightBrowserIntegration()],
    tracesSampleRate: 1,
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
