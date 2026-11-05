// Demo del finding corriendo SOLO sobre el registry curado (gate) — el patrón Relume: primero
// curar, después elegir. selectPage/composePage no cambian; cambia su input.
//   bun scripts/demo-registry.ts
import { lintComponent } from '../src/lint';
import { loadRegistry, RELUME_RHYTHM, verifiedCandidatesByRole } from '../src/registry';
import { composePage } from '../src/select';
import { planFrame, planSections } from '../src/plan';
import type { Brief } from '../src/types';
import { readFileSync } from 'node:fs';

const brief: Brief = {
  summary: 'Acme Pulse, agente de IA que vende por WhatsApp; features, stats y cómo funciona',
  goal: 'agendar una demo',
  tone: 'clean',
  maxStrips: 8,
};

// Lee la fuente vendorizada de una entrada; si no existe en disco, no truena el entrypoint:
// devuelve undefined y la entrada se reporta como "fuente faltante" (su source quedó colgado).
function readSource(source: string | null): string | undefined {
  if (!source) return undefined;
  try {
    return readFileSync(new URL(`../${source}`, import.meta.url), 'utf8');
  } catch {
    return undefined;
  }
}

const registry = loadRegistry();
console.log('registry (gate):');
for (const e of registry) {
  const src = readSource(e.source);
  const lint = src !== undefined ? lintComponent(src) : undefined;
  const state = e.verified ? 'IN ' : 'OUT';
  const lintState = lint
    ? (lint.ok ? 'lint ok' : `lint FAIL: ${lint.issues.map((i) => i.split(' — ')[0]).join('; ')}`)
    : e.source
      ? 'fuente faltante'
      : 'sin fuente';
  console.log(`  ${state} [${e.role}] ${e.slug}  (${lintState})`);
}

const roles = [...planFrame(brief), ...planSections(brief)].map((s) => s.role);
const page = composePage(brief, verifiedCandidatesByRole(roles, registry), RELUME_RHYTHM);

console.log(`\nbrief: ${brief.summary} — ${brief.goal} (tono ${brief.tone})`);
console.log(`total=${page.total}  cohesión (perfil ${page.profile}): ${page.cohesionReasons.join('; ') || '—'}\n`);
for (const sel of Object.values(page.frame)) console.log(`[${sel.role}] ${sel.pick.slug}  score=${sel.score}`);
for (const s of page.strips) {
  console.log(`[${s.role}] ${s.pick.slug}  score=${s.score}  (${s.pick.geometry} · ${s.pick.surface.light})`);
  console.log(`   porqué: ${s.reasons.join(' · ')}`);
  if (s.alternates.length) console.log(`   alternativas: ${s.alternates.map((a) => a.slug).join(', ')}`);
}
