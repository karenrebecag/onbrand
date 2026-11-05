// Experimento: plan de página offline (src/exp/page-plan.ts).
//   bun scripts/exp-page-plan.ts --briefs <dir> --names a,b --out <dir> [--n 3] [--roles hero,logos,features,stats,cta]
// Por negocio y repetición llama una vez al modelo, valida el plan, lo guarda en <out>/<negocio>-plan-<n>.json
// y al final escribe <out>/REPORT.md con (a) separación por rol y (b) patrón elegido por la regla.
// Con --summarize no llama al modelo: resume lo que ya hay en <out>.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_ROOT } from '../src/catalog/load';
import { rolePatterns } from '../src/ds-layout-guides';
import { cliInfer } from '../src/exp/cli-infer';
import { PLAN_SYSTEM, parsePagePlan, patternForIntent, planUserJson, renderPlanSummary, summarizePlans, type PagePlan, type PlanRun } from '../src/exp/page-plan';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (!v) throw new Error(`falta ${name}`);
  return v;
};

const outDir = flag('--out');
const n = Number(flag('--n', '3'));
mkdirSync(outDir, { recursive: true });

if (!args.includes('--summarize')) {
  const briefsDir = flag('--briefs');
  const names = flag('--names').split(',');
  const infer = cliInfer();
  for (const name of names) {
    const brief = JSON.parse(readFileSync(join(briefsDir, `${name}.json`), 'utf8')) as { summary: string; goal?: string; tone?: string; sections?: string[] };
    const roles = (flag('--roles', brief.sections?.join(',') ?? 'hero,features,cta')).split(',');
    for (let rep = 1; rep <= n; rep++) {
      const target = join(outDir, `${name}-plan-${rep}.json`);
      if (existsSync(target)) continue;
      const t0 = Date.now();
      const raw = await infer(PLAN_SYSTEM, planUserJson({ summary: brief.summary, ...(brief.goal ? { goal: brief.goal } : {}), ...(brief.tone ? { tone: brief.tone } : {}) }, roles));
      const { plan, errors } = parsePagePlan(raw, roles, roles); // experimento: lista cerrada, como --role-set
      if (!plan) {
        writeFileSync(join(outDir, `${name}-plan-${rep}.invalid.json`), JSON.stringify({ errors, raw }, null, 2));
        console.log(`${name} #${rep}: INVÁLIDO (${errors.join('; ')})`);
        continue;
      }
      writeFileSync(target, JSON.stringify(plan, null, 2));
      console.log(`${name} #${rep}: ok (${Date.now() - t0}ms) ${plan.sections.map((s) => `${s.role}:${s.proof}/${s.density}/${s.surface}`).join(' ')}`);
    }
  }
}

const NAME = /^(?<business>[a-z0-9-]+?)-plan-(?<rep>\d+)\.json$/;
const runs: PlanRun[] = readdirSync(outDir)
  .sort()
  .flatMap((file) => {
    const m = NAME.exec(file);
    if (!m?.groups) return [];
    return [{ business: m.groups.business, rep: Number(m.groups.rep), plan: JSON.parse(readFileSync(join(outDir, file), 'utf8')) as PagePlan }];
  });
const summary = summarizePlans(runs);

// (b) patrón del catálogo por la regla intención→forma, por rol y negocio (forma mayoritaria del negocio).
const { byRole } = rolePatterns(VAULT_ROOT);
const patternKeys: Record<string, Record<string, string>> = {};
for (const row of summary) {
  const patterns = byRole[row.role]?.patterns ?? [];
  if (!patterns.length) continue;
  patternKeys[row.role] = {};
  for (const business of Object.keys(row.shapeByBusiness)) {
    const keys = runs.filter((r) => r.business === business).flatMap((r) => {
      const s = r.plan.sections.find((x) => x.role === row.role);
      const p = s ? patternForIntent(patterns, s) : undefined;
      return p ? [p.key] : [];
    });
    patternKeys[row.role][business] = [...new Set(keys)].join(' / ');
  }
}

const md = [
  `# Plan de página offline (${runs.length} planes, ${[...new Set(runs.map((r) => r.business))].join(' vs ')})`,
  '',
  renderPlanSummary(summary, patternKeys),
  '',
  'Separación = distancia entre negocios / distancia dentro del mismo negocio (ruido entre repeticiones); > 1 claramente = el plan separa negocios. Forma = proof|density|surface|emphasis. Patrón = clave del catálogo de guías que la regla intención→forma elige; si los dos negocios caen en claves distintas, la intención basta para elegir forma.',
  '',
  '## Arcos',
  ...runs.map((r) => `- ${r.business} #${r.rep}: ${r.plan.arc}`),
  '',
  '## Objetivos por sección',
  ...runs.flatMap((r) => r.plan.sections.map((s) => `- ${r.business} #${r.rep} ${s.role}: ${s.objective} [${s.proof}; evita: ${s.avoid.join(', ') || '-'}]`)),
  '',
].join('\n');
writeFileSync(join(outDir, 'REPORT.md'), md);
console.log(md);
