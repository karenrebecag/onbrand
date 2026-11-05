import { Features } from '@/components/blocks/features';

export default function FeaturesSection() {
  return (
    <Features
      id="features"
      slug="01-features"
      title={'Un copiloto que trabaja con tu equipo de producto'}
      items={[
        { icon: 'check', title: 'Documentos que se escriben contigo', body: 'Nimbus redacta PRDs, notas de lanzamiento y resúmenes de investigación a partir de tus fuentes, y tú los editas en vivo.' },
        { icon: 'star', title: 'Pregunta lo que necesites', body: 'Abre el menú de comandos y pide un resumen de feedback, un borrador de roadmap o el estado de un lanzamiento.' },
        { icon: 'arrow-right', title: 'Métricas sin esperar al analista', body: 'Cruza adopción, retención y tickets en una sola vista, sin esperar al análisis.' },
      ]}
    />
  );
}
