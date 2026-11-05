import { Component, type ReactNode } from 'react';
import S0 from './sections/01-features';

class WtSection extends Component<{ slug: string; children: ReactNode }, { failed: boolean }> {
  // main.tsx lo reconoce por esto (no por el nombre, que el build minifica) para no duplicar el log.
  static wtSection = true;
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`/src/sections/${this.props.slug}.tsx: ${error instanceof Error ? error.message : String(error)}`);
  }
  render() {
    return this.state.failed ? <div data-wt-slug={this.props.slug} data-wt-error="" hidden /> : this.props.children;
  }
}

export default function App() {
  return (
    <>
      <main>
        <WtSection slug="01-features"><S0 /></WtSection>
      </main>
    </>
  );
}
