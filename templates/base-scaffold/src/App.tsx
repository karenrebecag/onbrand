// Página de muestra del scaffold base: compone los 11 bloques para ver el DS de una vez. En un ws la reemplaza el starter
// del skill; aquí sirve para que `bun run build` tipe y compile todos los bloques.
import { Cta } from './components/blocks/cta';
import { Faq } from './components/blocks/faq';
import { Features } from './components/blocks/features';
import { Footer } from './components/blocks/footer';
import { Hero } from './components/blocks/hero';
import { Logos } from './components/blocks/logos';
import { Navbar } from './components/blocks/navbar';
import { Pricing } from './components/blocks/pricing';
import { Stats } from './components/blocks/stats';
import { Steps } from './components/blocks/steps';
import { Testimonials } from './components/blocks/testimonials';

export default function App() {
  return (
    <main>
      <Navbar brand="Acme" links={[{ label: 'Producto', href: '#features' }, { label: 'Precios', href: '#pricing' }, { label: 'Preguntas', href: '#faq' }]} action={{ label: 'Empezar', href: '#cta' }} />
      <Hero eyebrow="Nuevo" title="Un DS neutro que alcanza" subtitle="Layout, tipografía, botones y secciones genéricas." actions={[{ label: 'Empezar', href: '#cta' }, { label: 'Ver más', href: '#features' }]} />
      <Logos title="Lo usan" logos={[{ name: 'Norte' }, { name: 'Faro' }, { name: 'Vela' }, { name: 'Brújula' }]} />
      <Features title="Qué trae" items={[{ icon: 'check', title: 'Tokens', body: 'Un contrato que cualquier marca repinta.' }, { icon: 'star', title: 'Átomos', body: 'Diez componentes sin dependencias.' }, { icon: 'arrow-right', title: 'Bloques', body: 'Once secciones como molde.' }]} />
      <Stats items={[{ value: '10', label: 'átomos' }, { value: '11', label: 'bloques' }, { value: '0', label: 'deps extra' }]} />
      <Steps title="Cómo funciona" items={[{ title: 'Elige', body: 'El agente lee el skill.' }, { title: 'Compone', body: 'Escribe cada sección.' }, { title: 'Publica', body: 'La página sale lista.' }]} />
      <Testimonials items={[{ quote: 'Alcanzó para la primera página.', name: 'Ana Pérez', role: 'Diseño' }, { quote: 'Sin instalar nada más.', name: 'Luis Gómez', role: 'Ingeniería' }]} />
      <Pricing title="Precios" plans={[{ name: 'Libre', price: '$0', features: ['Core', 'DS base'], action: { label: 'Clonar', href: '#' } }, { name: 'Distro', price: 'A medida', features: ['DS propio', 'Servicios'], action: { label: 'Hablar', href: '#', variant: 'secondary' } }]} />
      <Faq title="Preguntas" items={[{ title: '¿Tiene motion?', content: 'No: una distro lo trae por su registry.' }, { title: '¿Puedo usar mi marca?', content: 'Sí, con un brand pack.' }]} />
      <Cta title="Empieza hoy" subtitle="Un clon limpio genera una página." actions={[{ label: 'Empezar', href: '#' }]} />
      <Footer brand="Acme" columns={[{ title: 'Producto', links: [{ label: 'Precios', href: '#pricing' }] }, { title: 'Ayuda', links: [{ label: 'Preguntas', href: '#faq' }] }]} legal="Página de muestra." />
    </main>
  );
}
