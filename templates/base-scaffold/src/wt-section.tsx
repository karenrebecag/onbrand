import { Component, type ReactNode } from 'react'

// Una sección que tira en render desmontaría la página entera (React sin boundary). Con uno por sección queda vacía
// pero montada (data-wt-error) y el error nombra su archivo, que es como preview.runtime la atribuye. Es el mismo
// boundary que la ruta JSON emite dentro de App.tsx (src/runtime/runner.ts SECTION_BOUNDARY); aquí vive aparte porque el
// App del agente solo exporta componentes y así sigue siendo frontera de React Refresh.
export class WtSection extends Component<{ slug: string; children: ReactNode }, { failed: boolean }> {
  // main.tsx lo reconoce por esto (no por el nombre, que el build minifica) para no duplicar el log.
  static wtSection = true
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error(`/src/sections/${this.props.slug}.tsx: ${error instanceof Error ? error.message : String(error)}`)
  }
  render() {
    return this.state.failed ? <div data-wt-slug={this.props.slug} data-wt-error="" hidden /> : this.props.children
  }
}
