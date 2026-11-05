// Genera las guías de layout por rol (src/ds-layout-guides.ts) desde el vault y las deja en
// generated/registry/references/layouts/ con un reporte de cobertura. No publica: el registry las
// toma de aquí (build-registry) como entradas `layout-<rol>` de `references`.
//   bun scripts/build-layout-guides.ts

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, VAULT_ROOT } from '../src/catalog/load';
import { layoutGuides } from '../src/ds-layout-guides';

const OUT = join(REPO_ROOT, 'generated', 'registry', 'references', 'layouts');

const report = layoutGuides(VAULT_ROOT);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const [key, md] of Object.entries(report.guides)) writeFileSync(join(OUT, `${key}.md`), md);
writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({ roles: report.roles, excluded: report.excluded }, null, 2)}\n`);

const inRole = Object.values(report.roles).reduce((n, r) => n + r.total, 0);
const out = Object.values(report.excluded).reduce((n, c) => n + c, 0);
console.log(`layouts: ${Object.keys(report.guides).length} guías desde ${inRole} secciones con rol (${out} sin rol en ${Object.keys(report.excluded).length} categorías) -> ${OUT}`);
for (const [role, r] of Object.entries(report.roles)) {
  console.log(`  ${role.padEnd(13)} ${String(r.total).padStart(4)} secciones · ${r.patterns} patrones cubren ${r.covered} (${Math.round((r.covered / r.total) * 100)}%) · ${r.singles} únicas`);
}
