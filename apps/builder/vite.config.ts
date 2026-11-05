import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { realpathSync } from 'node:fs'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

export default defineConfig({
  plugins: [react()],
  // El transport (Arq) corre aparte; el proxy evita CORS. VITE_RUN_API=/api activa el modo en vivo.
  server: {
    // node_modules puede ser un enlace a otra carpeta (un worktree que comparte la instalación): sin esto vite niega
    // las fuentes de @fontsource con 403 y el builder se ve con la tipografía de respaldo.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), realpathSync(fileURLToPath(new URL('./node_modules', import.meta.url)))] },
    proxy: { '/api': { target: process.env.WT_TRANSPORT_URL ?? 'http://127.0.0.1:5300', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // El builder consume el contrato del motor directo del repo, no una copia.
      '@engine': fileURLToPath(new URL('../../src', import.meta.url)),
    },
  },
})
