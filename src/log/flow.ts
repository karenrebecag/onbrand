// Log de flujo del pipeline (observabilidad, no cambia nada): ensambla en un solo artefacto ordenado
// las decisiones de cada etapa (plan → marca → router → select → 2-capas → copy → emit), cada una
// mapeada a su contraparte en el flujo de Relume (los extracts de ~/Desktop/relume-extract), para
// poder comparar lado a lado "qué llama y qué crea" nuestra fábrica vs. Relume. Se arma DESPUÉS del
// run leyendo lo que las etapas ya producen; no se inyecta un logger en el pipeline.

import type { BrandComposition, BrandTrace } from '../brand';
import type { GeneratedCopy } from '../copygen/generate';
import type { EmitReport } from '../emit';
import type { LayeredPage } from '../compose-layers';
import type { RouteResult } from '../router';
import type { PageResult } from '../select';
import type { Brief, RoleSpec } from '../types';

export interface FlowStage {
  /** Id de la etapa en nuestra fábrica. */
  stage: string;
  /** Contraparte en el flujo de Relume (nombre del extract), o la nota de por qué no la hay. */
  relume: string;
  /** Una línea legible de qué decidió/creó la etapa. */
  summary: string;
  /** Decisiones estructuradas de la etapa (lo comparable con el extract). */
  detail: unknown;
}

export interface FlowLog {
  brief: { summary: string; goal?: string };
  brand: string;
  /** Qué brand pack se aplicó, su origen y huella: hace el run reproducible (C13). */
  brandPack?: BrandTrace;
  intent?: string;
  stages: FlowStage[];
}

export interface FlowInputs {
  brief: Brief;
  brand: string;
  /** Traza del brand pack aplicado (ruta, origen, hash); ausente en inputs de test antiguos. */
  brandPack?: BrandTrace;
  specs: RoleSpec[];
  rhythm: string;
  composition?: BrandComposition;
  routed?: RouteResult;
  page: PageResult;
  layered: LayeredPage;
  generated?: GeneratedCopy;
  report: EmitReport;
}

/** Arma el log de flujo a partir de lo que ya produjo cada etapa del run. */
export function buildFlow(inp: FlowInputs): FlowLog {
  const stages: FlowStage[] = [];

  // Plan: brief -> roles + spec por rol. Relume: el sitemap/esquemas que derivan la página del brief.
  stages.push({
    stage: 'plan',
    relume: 'brief-to-homepage-3 / page-schemes-1',
    summary: `${inp.specs.length} roles planificados (ritmo ${inp.rhythm}): ${inp.specs.map((s) => s.role).join(', ')}`,
    detail: {
      rhythm: inp.rhythm,
      roles: inp.specs.map((s) => ({ role: s.role, category: s.category, desiredTags: s.desiredTags, undesiredTags: s.undesiredTags ?? [] })),
    },
  });

  // Marca: sesgo determinista de identidad/composición. Relume: brief -> theme/color/font/ui.
  if (inp.composition) {
    stages.push({
      stage: 'brand',
      relume: 'brief-to-theme-and-color-2 / brief-to-font-family-2 / brief-to-ui-styling-1',
      summary: `marca ${inp.brand}: densidad ${inp.composition.density ?? '—'}, ${Object.keys(inp.composition.roles ?? {}).length} roles sesgados`,
      detail: inp.composition,
    });
  }

  // Router: shortlist por intención + exclusiones + rescate de marca. Relume: elección de componente.
  if (inp.routed) {
    stages.push({
      stage: 'route',
      relume: 'section-component-1',
      summary: `intención ${inp.routed.intent.intent}; shortlist por rol con exclusiones y rescate de marca`,
      detail: Object.fromEntries(Object.entries(inp.routed.trace).map(([role, t]) => [role, {
        shortlisted: t.shortlisted.map((s) => ({ slug: s.slug, score: s.score })),
        excluded: t.excluded.map((e) => ({ slug: e.slug, rule: e.rule })),
        unbound: t.unbound,
        ...(t.bindingFallback ? { bindingFallback: true } : {}),
        rescued: t.rescued.map((r) => ({ slug: r.slug, score: r.score })),
        dropped: t.dropped.map((d) => ({ slug: d.slug, score: d.score })),
      }])),
    });
  }

  // Select: pick por strip (score + razones) + cohesión. Relume: scoring de componente + text-count.
  stages.push({
    stage: 'select',
    relume: 'section-component-1 (scoring) / section-text-count-1',
    summary: `${inp.page.strips.length} strips elegidos (perfil ${inp.rhythm}${inp.page.profile !== inp.rhythm ? ` → ${inp.page.profile}` : ''}); cohesión: ${inp.page.cohesionReasons.join('; ') || '—'}`,
    detail: {
      requested: inp.rhythm,
      profile: inp.page.profile,
      effective: inp.page.effective,
      cohesionReasons: inp.page.cohesionReasons,
      strips: inp.page.strips.map((s) => ({ role: s.role, pick: s.pick.slug, score: s.score, reasons: s.reasons })),
    },
  });

  // Dos capas (ADR 0001): propio de la fábrica, sin equivalente en Relume (que no envuelve en shells).
  if (inp.layered.layers.length) {
    stages.push({
      stage: 'compose-layers',
      relume: '(sin equivalente: 2 capas layout Relume + inner Arc, ADR 0001)',
      summary: `${inp.layered.layers.length} capas resueltas (layout envuelve inner)`,
      detail: inp.layered.layers.map((l) => ({ role: l.role, layout: l.layout.slug, inner: l.inner.slug })),
    });
  }

  // Copy: el inputJson es la réplica del objeto `q` de page-content-1 (comparación directa).
  if (inp.generated) {
    stages.push({
      stage: 'page-content',
      relume: 'page-content-1',
      summary: `copy generado por ${inp.generated.generator}; input en forma page-content-1 (${inp.generated.input.sections.length} secciones)`,
      detail: inp.generated.input,
    });
    stages.push({
      stage: 'text-fit',
      relume: 'text-fit-1',
      summary: 'cada campo fiteado al presupuesto del bloque (jq de sus Defaults), con holgura en titulares',
      detail: { note: 'el presupuesto por campo viaja en page-content.input text fields[].max length' },
    });
  }

  // Emit: render final de los bloques elegidos. Propio (Relume renderiza en su editor).
  stages.push({
    stage: 'emit',
    relume: '(render propio)',
    summary: `${inp.report.blocks.length} bloques emitidos${inp.report.omittedRoles.length ? `; roles omitidos: ${inp.report.omittedRoles.join(', ')}` : ''}${inp.report.demoVisible.length ? `; demo visible: ${inp.report.demoVisible.map((d) => `${d.slug}[${d.props.join(', ')}]`).join(', ')}` : ''}`,
    detail: {
      blocks: inp.report.blocks.map((b) => ({ role: b.role, slug: b.slug, export: b.export, ...(b.inner ? { inner: b.inner.slug } : {}) })),
      omittedRoles: inp.report.omittedRoles,
      omitted: inp.report.omitted,
      demoVisible: inp.report.demoVisible,
    },
  });

  return {
    brief: { summary: inp.brief.summary, ...(inp.brief.goal ? { goal: inp.brief.goal } : {}) },
    brand: inp.brand,
    ...(inp.brandPack ? { brandPack: inp.brandPack } : {}),
    ...(inp.routed ? { intent: inp.routed.intent.intent } : {}),
    stages,
  };
}

/** Versión legible (Markdown) del log: una sección por etapa con su contraparte Relume. */
export function renderFlowMd(log: FlowLog): string {
  const lines: string[] = [
    `# Flujo del run — ${log.brief.summary}`,
    '',
    `Marca: ${log.brand}${log.intent ? ` · Intención: ${log.intent}` : ''}`,
    '',
    'Cada etapa con su contraparte en el flujo de Relume (`~/Desktop/relume-extract`) para comparar.',
    '',
  ];
  for (const [i, s] of log.stages.entries()) {
    lines.push(`## ${i + 1}. ${s.stage}`);
    lines.push(`Relume: \`${s.relume}\``);
    lines.push('');
    lines.push(s.summary);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
