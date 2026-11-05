// Página compuesta por el transformer (brief: SaaS de gestión de proyectos, agendar demo).
// Marco: Navbar 13 + Footer 1. Contenido (≤3 strips): Header 19 · Layout 237 · CTA 40.
// Los componentes son los REALES de Relume, sin modificar.
import { Navbar13 } from './sections/Navbar13';
import { Header19 } from './sections/Header19';
import { Layout237 } from './sections/Layout237';
import { Cta40 } from './sections/Cta40';
import { Footer1 } from './sections/Footer1';

export default function App() {
  return (
    <div>
      <Navbar13 />
      <main className="pt-24">
        <Header19 />
        <Layout237 />
        <Cta40 />
      </main>
      <Footer1 />
    </div>
  );
}
