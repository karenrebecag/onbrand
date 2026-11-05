import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = import.meta.dirname
// En un Vercel Sandbox el transport pasa los dominios publicados: sin esto vite responde 403 a un Host que no conoce.
// Sin clientPort a propósito: el cliente de vite arma el socket con el host y el puerto de la página
// (node_modules/vite/dist/client/client.mjs:940), así que el dominio público queda en wss://<dominio> y el preview-check,
// que entra por 127.0.0.1:<puerto>, en ese puerto. clientPort: 443 mandaba al preview-check a ws://127.0.0.1:443
// (staging V4: dos console y un pageerror falsos que abrían el runtime-repair).
const allowedHosts = process.env.WT_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? []

// Marcador de origen del editor (S6), como lovable-tagger@1.3.5 (dist/index.js:10-17, enforce 'pre' en :181): el
// react/jsx-dev-runtime que importa cada .tsx pasa por src/wt-source.ts. Un plugin 'pre' resuelve antes que el pre-bundle
// de optimizeDeps (vite 8.3.4 node.js:34007-34040; vite:pre-alias solo toca ids con alias, :25939-25965), y el import del
// runtime real desde el módulo virtual no se reescribe. Solo en serve: el build no lleva Symbol ni mapa.
const SOURCE_RUNTIME = '\0wt-source/jsx-dev-runtime'
export function wtSourcePlugin(base: string): Plugin {
  return {
    name: 'wt-source',
    apply: 'serve',
    enforce: 'pre',
    resolveId(id, importer) {
      return id === 'react/jsx-dev-runtime' && importer !== SOURCE_RUNTIME ? SOURCE_RUNTIME : null
    },
    load(id) {
      if (id !== SOURCE_RUNTIME) return null
      return [
        "import * as R from 'react/jsx-dev-runtime'",
        `import { createJsxDEV } from ${JSON.stringify(path.resolve(base, 'src/wt-source.ts'))}`,
        'export const Fragment = R.Fragment',
        `export const jsxDEV = createJsxDEV(R.jsxDEV, R.Fragment, ${JSON.stringify(base)}, typeof window === 'undefined' ? undefined : window)`,
      ].join('\n')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [wtSourcePlugin(root), react()],
  // Sin overlay de errores, como el sandbox de Lovable (@lovable.dev/vite-tanstack-config 2.27.0 dist/index.js:1680-1688,
  // hmr.overlay false): un error de compilación a mitad del turno taparía el preview que se va armando sección por sección;
  // el builder sigue viendo los de runtime por wt-error-bridge y los del server en el log de vite que lee preview-check.
  // cors:false (security-reviewer H1): el preview es same-origin (`<ws>.localhost:<previewPort>` por el proxy). Sin esto
  // vite 8.3.4 refleja Access-Control-Allow-Origin a cualquier origen localhost/127.0.0.1 (defaultAllowedOrigins), así que
  // una página de un ws podía fetch('http://127.0.0.1:<otro-puerto>/src/App.tsx') y leer el código y el token de HMR de
  // otro ws. Nada del preview necesita ACAO.
  // watch.ignored (QA, generación limpia): sin esto vite vigila `.wt/` y saveDist, al escribir `.wt/dist/<commit>` en
  // settled, dispara un full-reload que remonta los dos iframes a mitad del asentado ("[vite] (client) page reload
  // .wt/dist/.../index.html", contexto nuevo + ráfaga de 502/500 + 0 secciones ~0,4 s). Se suma a los ignores por defecto
  // de vite (node_modules/vite 8.3.4 dist/node/chunks/node.js:16836-16842, `...arraify(ignoredList)`). `.wt/` no es código
  // de la página: es la skill y el snapshot de dist, nada que deba disparar HMR.
  server: { cors: false, hmr: { overlay: false }, watch: { ignored: ['**/.wt/**'] }, ...(allowedHosts.length ? { allowedHosts } : {}) },
  resolve: {
    alias: {
      // Una sección escrita para Next importa next/image: va a un <img> plano.
      'next/image': path.resolve(root, 'src/shims/next-image.tsx'),
      '@': path.resolve(root, 'src'),
    },
    // Como Lovable (@lovable.dev/vite-tanstack-config 2.27.0, dist/index.js:1656-1673): una sola instancia de React.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  // Núcleo de React como Lovable (misma cita). Las deps que la página importa recién al montar van también, como pide
  // vite (8.3.4 dist/node/chunks/node.js:35777-35782): descubiertas tarde, re-optimiza y recarga (:35952-35965) y el
  // iframe mezcla chunks de dos React hasta el reload ("Invalid hook call", QA, chats 57f08261 y 5d5ef9c0).
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    ignoreOutdatedRequests: true,
  },
})
