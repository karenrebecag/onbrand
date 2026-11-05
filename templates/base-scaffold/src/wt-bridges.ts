// Los puentes del preview con el builder (errores, tamaño, revelado, selección, tema, recarga tras HMR). No los importa
// main.tsx: el plugin wt-bridges del transport (src/runtime/wt-bridges-plugin.ts) inyecta este módulo del scaffold actual antes
// del de la página, así un workspace creado con puentes viejos recibe los de hoy sin tocar su árbol ni su git.
import { installErrorBridge } from './wt-error-bridge'
import { installSizeBridge } from './wt-size-bridge'
import { installRevealBridge } from './wt-reveal-bridge'
import { installSelectBridge } from './wt-select-bridge'
import { installHmrRecover } from './wt-hmr-recover'
import { installThemeBridge } from './wt-theme-bridge'

// Antes de montar: un error del primer render también tiene que llegar al builder (el script va antes que main.tsx).
installErrorBridge(window, import.meta.env.VITE_WT_BUILDER_ORIGIN, import.meta.hot)
installSizeBridge(window, import.meta.env.VITE_WT_BUILDER_ORIGIN)
installRevealBridge(window, import.meta.env.VITE_WT_BUILDER_ORIGIN)
installSelectBridge(window, import.meta.env.VITE_WT_BUILDER_ORIGIN)
installThemeBridge(window, import.meta.env.VITE_WT_BUILDER_ORIGIN)
installHmrRecover(import.meta.hot, () => window.location.reload())
