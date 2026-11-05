// Plantillas en español del generador determinista. Solo afirman lo que el brief dice (nombre,
// descriptor, beneficios, audiencia, objetivo); el resto son cierres neutros que no inventan hechos
// del producto. Las cifras y los testimonios son de muestra (ver templates.ts).

import { cap, joinList, shortPhrase } from './facts';
import { range, SAMPLE_BRANDS, SAMPLE_PEOPLE, SAMPLE_PRICES, type TemplateCtx, type Templates } from './templates';

export const GENERIC_BENEFITS_ES = [
  'se integra con las herramientas que ya usas',
  'aprende del contexto de tu equipo',
  'muestra resultados desde la primera semana',
  'escala sin sumar trabajo manual',
  'mantiene a todo el equipo en la misma página',
  'deja cada decisión medida y trazable',
];

const COMPLEMENTS = [
  'de forma automática, sin intervención manual.',
  'con el contexto de cada conversación.',
  'y lo deja medido para tu equipo.',
  'desde el primer día, sin configuración compleja.',
  'a la escala que necesites.',
  'sin cambiar las herramientas que ya usas.',
];

const audienceOr = (ctx: TemplateCtx, dflt: string): string => ctx.f.audience ?? dflt;

const benefitsSentence = (ctx: TemplateCtx, n: number): string => joinList(range(Math.min(n, Math.max(1, ctx.f.benefits.length || 2))).map(ctx.benefit), 'es');

export const TEMPLATES_ES: Templates = {
  navbar: (ctx) => ({
    brand: ctx.f.name,
    links: ['Producto', 'Cómo funciona', 'Precios', 'Clientes', 'Preguntas'].slice(0, ctx.c.navLinks),
    primaryCta: cap(ctx.f.goal),
    secondaryCta: '',
  }),
  hero: (ctx) => {
    const { f } = ctx;
    const withAudience = f.audience && !/\bpara\b/.test(f.descriptor) ? `${cap(f.descriptor)} para ${f.audience}` : undefined;
    return {
      heading: ctx.pick([withAudience ?? cap(f.descriptor), `${f.name}: ${f.descriptor}`, `${cap(f.descriptor)}, sin fricción`]),
      description: `${f.name} ${benefitsSentence(ctx, 3)}. ${cap(f.goal)} es el primer paso.`,
      primaryCta: cap(f.goal),
      secondaryCta: 'Ver cómo funciona',
    };
  },
  logos: (ctx) => ({
    heading: ctx.pick([`Equipos que ya confían en ${ctx.f.name}`, `${ctx.f.name} ya trabaja con equipos como el tuyo`]),
  }),
  features: (ctx) => ({
    heading: ctx.pick([`Lo que ${ctx.f.name} hace por ${audienceOr(ctx, 'tu equipo')}`, `Todo lo que ${ctx.f.name} resuelve`, `Qué hace ${ctx.f.name}`]),
    description: ctx.f.extras[0] ?? `Cada función de ${ctx.f.name} está pensada para ${audienceOr(ctx, 'tu equipo')}: menos tareas manuales, más resultados.`,
    items: range(ctx.c.features).map((i) => ({
      title: shortPhrase(ctx.benefit(i)),
      description: `${ctx.f.name} ${ctx.benefit(i)} ${COMPLEMENTS[i % COMPLEMENTS.length]}`,
    })),
  }),
  steps: (ctx) => {
    const titles = ['Conecta tus canales', `Activa ${ctx.f.name}`, cap(ctx.benefit(0)), 'Mide y ajusta'];
    const descs = [
      'Enlaza las herramientas donde ya trabaja tu equipo. Toma minutos, no semanas.',
      `${ctx.f.name} empieza a trabajar con tu contexto real desde el primer momento.`,
      `${ctx.f.name} ${ctx.benefit(0)} ${COMPLEMENTS[0]}`,
      'Revisa qué funciona en el panel y ajusta sin tocar código.',
    ];
    return {
      heading: ctx.pick([`Cómo funciona ${ctx.f.name}`, 'Así funciona, paso a paso']),
      steps: range(ctx.c.steps).map((i) => ({ tagline: `Paso ${i + 1}`, title: titles[i], description: descs[i] })),
    };
  },
  stats: (ctx) => ({
    heading: ctx.pick([`${ctx.f.name} en números`, 'Resultados que se miden']),
    stats: [
      { label: 'Atención continua', detail: 'todos los días, sin pausas' },
      { label: 'Para empezar', detail: 'desde que conectas tu cuenta' },
      { label: 'Más conversiones', detail: `cuando ${ctx.f.name} ${ctx.benefit(0)}` },
      { label: 'Equipos satisfechos', detail: 'que lo recomendarían' },
    ].slice(0, ctx.c.stats),
  }),
  testimonials: (ctx) => ({
    heading: ctx.pick([`Lo que dicen quienes usan ${ctx.f.name}`, 'Historias de equipos como el tuyo']),
    description: `Equipos de ${audienceOr(ctx, 'distintos sectores')} cuentan cómo ${ctx.f.name} cambió su día a día.`,
    items: range(ctx.c.testimonials).map((i) => ({
      quote: `${ctx.f.name} ${ctx.benefit(i)} sin que sumemos gente al equipo. Se nota desde la primera semana.`,
      name: SAMPLE_PEOPLE[i % SAMPLE_PEOPLE.length],
      role: [`Líder de ${audienceOr(ctx, 'operaciones')}`, 'Directora de operaciones', 'Fundador'][i % 3],
      company: SAMPLE_BRANDS[i % SAMPLE_BRANDS.length],
    })),
  }),
  pricing: (ctx) => ({
    tagline: 'Planes',
    heading: ctx.pick(['Un plan para cada etapa', 'Precios claros, sin sorpresas']),
    description: `Cambia de plan cuando quieras. Todos incluyen lo esencial para que ${ctx.f.name} ${ctx.benefit(0)}.`,
    plans: [
      { name: 'Básico', monthlyPrice: SAMPLE_PRICES[0], yearlyNote: 'o $190 al año', features: [cap(ctx.benefit(0)), cap(ctx.benefit(1)), 'Soporte por correo'], cta: cap(ctx.f.goal) },
      { name: 'Pro', monthlyPrice: SAMPLE_PRICES[1], yearlyNote: 'o $490 al año', features: ['Todo lo de Básico', cap(ctx.benefit(2)), 'Soporte prioritario'], cta: cap(ctx.f.goal) },
    ],
  }),
  faq: (ctx) => ({
    heading: ctx.pick(['Preguntas frecuentes', 'Lo que suelen preguntarnos']),
    description: `Lo que suelen preguntar antes de ${ctx.f.goal}.`,
    items: [
      { question: `¿Qué es ${ctx.f.name}?`, answer: `${ctx.f.name} es un ${ctx.f.descriptor} que ${benefitsSentence(ctx, 3)}.` },
      { question: '¿Cómo funciona?', answer: `Se conecta a tus canales y ${ctx.benefit(0)} de forma automática; tu equipo solo interviene cuando hace falta.` },
      { question: `¿Para quién es ${ctx.f.name}?`, answer: `Para ${audienceOr(ctx, 'equipos que quieren crecer sin sumar trabajo manual')}.` },
      { question: '¿Cómo empiezo?', answer: `${cap(ctx.f.goal)} y en una llamada corta lo vemos con tus propios datos.` },
      { question: '¿Necesito conocimientos técnicos?', answer: `No: ${ctx.f.name} se configura en minutos, sin código.` },
      { question: '¿Puedo cancelar cuando quiera?', answer: 'Sí, sin permanencia ni letra pequeña.' },
    ].slice(0, ctx.c.faq),
    contact: { heading: '¿Todavía tienes dudas?', description: 'Cuéntanos tu caso y te respondemos.', cta: 'Contactar' },
  }),
  cta: (ctx) => ({
    heading: ctx.pick([`¿Listo para ${ctx.f.goal}?`, `Empieza hoy con ${ctx.f.name}`]),
    description: `${ctx.f.name} ${ctx.benefit(0)} desde la primera semana. ${cap(ctx.f.goal)} y compruébalo con tu equipo.`,
    primaryCta: cap(ctx.f.goal),
    secondaryCta: 'Hablar con el equipo',
    note: 'Sin compromiso.',
  }),
  footer: (ctx) => ({
    brand: ctx.f.name,
    tagline: `${cap(ctx.f.descriptor)}.`,
    columns: [
      { title: 'Producto', links: ['Funciones', 'Cómo funciona', 'Precios', 'Integraciones'].slice(0, ctx.c.footerLinks) },
      { title: 'Empresa', links: ['Sobre nosotros', 'Blog', 'Contacto', 'Empleo'].slice(0, ctx.c.footerLinks) },
      { title: 'Recursos', links: ['Guías', 'Documentación', 'Soporte', 'Estado'].slice(0, ctx.c.footerLinks) },
    ].slice(0, ctx.c.footerColumns),
    legal: ['Privacidad', 'Términos'],
  }),
};
