// English templates of the deterministic generator (mirror of templates-es.ts). The brief text is
// used as written; only the surrounding copy switches language.

import { cap, joinList, shortPhrase } from './facts';
import { range, SAMPLE_BRANDS, SAMPLE_PEOPLE, SAMPLE_PRICES, type TemplateCtx, type Templates } from './templates';

export const GENERIC_BENEFITS_EN = [
  'plugs into the tools you already use',
  'learns from your team\'s context',
  'shows results from the first week',
  'scales without adding manual work',
  'keeps the whole team on the same page',
  'leaves every decision measured and traceable',
];

const COMPLEMENTS = [
  'automatically, with no manual work.',
  'with the context of every conversation.',
  'and keeps it measured for your team.',
  'from day one, with no complex setup.',
  'at whatever scale you need.',
  'without changing the tools you already use.',
];

const audienceOr = (ctx: TemplateCtx, dflt: string): string => ctx.f.audience ?? dflt;
const benefitsSentence = (ctx: TemplateCtx, n: number): string => joinList(range(Math.min(n, Math.max(1, ctx.f.benefits.length || 2))).map(ctx.benefit), 'en');

export const TEMPLATES_EN: Templates = {
  navbar: (ctx) => ({
    brand: ctx.f.name,
    links: ['Product', 'How it works', 'Pricing', 'Customers', 'FAQ'].slice(0, ctx.c.navLinks),
    primaryCta: cap(ctx.f.goal),
    secondaryCta: '',
  }),
  hero: (ctx) => {
    const { f } = ctx;
    const withAudience = f.audience && !/\bfor\b/.test(f.descriptor) ? `${cap(f.descriptor)} for ${f.audience}` : undefined;
    return {
      heading: ctx.pick([withAudience ?? cap(f.descriptor), `${f.name}: ${f.descriptor}`, `${cap(f.descriptor)}, without the friction`]),
      description: `${f.name} ${benefitsSentence(ctx, 3)}. ${cap(f.goal)} is the first step.`,
      primaryCta: cap(f.goal),
      secondaryCta: 'See how it works',
    };
  },
  logos: (ctx) => ({
    heading: ctx.pick([`Teams that already trust ${ctx.f.name}`, `${ctx.f.name} already works with teams like yours`]),
  }),
  features: (ctx) => ({
    heading: ctx.pick([`What ${ctx.f.name} does for ${audienceOr(ctx, 'your team')}`, `Everything ${ctx.f.name} takes care of`, `What ${ctx.f.name} does`]),
    description: ctx.f.extras[0] ?? `Every feature in ${ctx.f.name} is built for ${audienceOr(ctx, 'your team')}: less manual work, more results.`,
    items: range(ctx.c.features).map((i) => ({
      title: shortPhrase(ctx.benefit(i)),
      description: `${ctx.f.name} ${ctx.benefit(i)} ${COMPLEMENTS[i % COMPLEMENTS.length]}`,
    })),
  }),
  steps: (ctx) => {
    const titles = ['Connect your channels', `Turn on ${ctx.f.name}`, cap(ctx.benefit(0)), 'Measure and adjust'];
    const descs = [
      'Link the tools your team already works in. It takes minutes, not weeks.',
      `${ctx.f.name} starts working with your real context right away.`,
      `${ctx.f.name} ${ctx.benefit(0)} ${COMPLEMENTS[0]}`,
      'Review what works in the dashboard and adjust without touching code.',
    ];
    return {
      heading: ctx.pick([`How ${ctx.f.name} works`, 'How it works, step by step']),
      steps: range(ctx.c.steps).map((i) => ({ tagline: `Step ${i + 1}`, title: titles[i], description: descs[i] })),
    };
  },
  stats: (ctx) => ({
    heading: ctx.pick([`${ctx.f.name} in numbers`, 'Results you can measure']),
    stats: [
      { label: 'Always on', detail: 'every day, no pauses' },
      { label: 'To get started', detail: 'from the moment you connect' },
      { label: 'More conversions', detail: `when ${ctx.f.name} ${ctx.benefit(0)}` },
      { label: 'Happy teams', detail: 'would recommend it' },
    ].slice(0, ctx.c.stats),
  }),
  testimonials: (ctx) => ({
    heading: ctx.pick([`What ${ctx.f.name} users say`, 'Stories from teams like yours']),
    description: `Teams in ${audienceOr(ctx, 'different industries')} share how ${ctx.f.name} changed their day to day.`,
    items: range(ctx.c.testimonials).map((i) => ({
      quote: `${ctx.f.name} ${ctx.benefit(i)} without us adding headcount. You feel it from the first week.`,
      name: SAMPLE_PEOPLE[i % SAMPLE_PEOPLE.length],
      role: [`Head of ${audienceOr(ctx, 'operations')}`, 'COO', 'Founder'][i % 3],
      company: SAMPLE_BRANDS[i % SAMPLE_BRANDS.length],
    })),
  }),
  pricing: (ctx) => ({
    tagline: 'Plans',
    heading: ctx.pick(['A plan for every stage', 'Clear pricing, no surprises']),
    description: `Switch plans whenever you want. Every plan includes what ${ctx.f.name} needs to ${ctx.benefit(0)}.`,
    plans: [
      { name: 'Basic', monthlyPrice: SAMPLE_PRICES[0], yearlyNote: 'or $190 a year', features: [cap(ctx.benefit(0)), cap(ctx.benefit(1)), 'Email support'], cta: cap(ctx.f.goal) },
      { name: 'Pro', monthlyPrice: SAMPLE_PRICES[1], yearlyNote: 'or $490 a year', features: ['Everything in Basic', cap(ctx.benefit(2)), 'Priority support'], cta: cap(ctx.f.goal) },
    ],
  }),
  faq: (ctx) => ({
    heading: ctx.pick(['Frequently asked questions', 'What people ask us']),
    description: `What people usually ask before they ${ctx.f.goal}.`,
    items: [
      { question: `What is ${ctx.f.name}?`, answer: `${ctx.f.name} is a ${ctx.f.descriptor} that ${benefitsSentence(ctx, 3)}.` },
      { question: 'How does it work?', answer: `It connects to your channels and ${ctx.benefit(0)} automatically; your team only steps in when needed.` },
      { question: `Who is ${ctx.f.name} for?`, answer: `For ${audienceOr(ctx, 'teams that want to grow without adding manual work')}.` },
      { question: 'How do I start?', answer: `${cap(ctx.f.goal)} and we walk through it with your own data on a short call.` },
      { question: 'Do I need technical skills?', answer: `No: ${ctx.f.name} is set up in minutes, no code.` },
      { question: 'Can I cancel anytime?', answer: 'Yes, no lock-in and no fine print.' },
    ].slice(0, ctx.c.faq),
    contact: { heading: 'Still have questions?', description: 'Tell us about your case and we will get back to you.', cta: 'Contact us' },
  }),
  cta: (ctx) => ({
    heading: ctx.pick([`Ready to ${ctx.f.goal}?`, `Start today with ${ctx.f.name}`]),
    description: `${ctx.f.name} ${ctx.benefit(0)} from the first week. ${cap(ctx.f.goal)} and see it with your team.`,
    primaryCta: cap(ctx.f.goal),
    secondaryCta: 'Talk to the team',
    note: 'No commitment.',
  }),
  footer: (ctx) => ({
    brand: ctx.f.name,
    tagline: `${cap(ctx.f.descriptor)}.`,
    columns: [
      { title: 'Product', links: ['Features', 'How it works', 'Pricing', 'Integrations'].slice(0, ctx.c.footerLinks) },
      { title: 'Company', links: ['About', 'Blog', 'Contact', 'Careers'].slice(0, ctx.c.footerLinks) },
      { title: 'Resources', links: ['Guides', 'Docs', 'Support', 'Status'].slice(0, ctx.c.footerLinks) },
    ].slice(0, ctx.c.footerColumns),
    legal: ['Privacy', 'Terms'],
  }),
};
