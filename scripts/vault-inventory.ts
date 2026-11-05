// Runner del inventario F0. Ejecuta buildInventory sobre el vault real (READ-ONLY) y el índice
// unificado, y escribe catalog/inventory.json + catalog/inventory.md. No toca el vault ni la red.
//   bun scripts/vault-inventory.ts
// WT_VAULT_ROOT sobreescribe la raíz del vault (tests/CI).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_PATH, REPO_ROOT, VAULT_ROOT } from '../src/catalog/load';
import { buildInventory, renderMarkdown, type IndexEntry } from '../src/catalog/inventory';
import { readFileSync } from 'node:fs';

function main(): void {
  const index = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as IndexEntry[];
  const inv = buildInventory(VAULT_ROOT, index, new Date().toISOString());
  writeFileSync(join(REPO_ROOT, 'catalog', 'inventory.json'), `${JSON.stringify(inv, null, 2)}\n`);
  writeFileSync(join(REPO_ROOT, 'catalog', 'inventory.md'), renderMarkdown(inv));
  const t = inv.totals;
  console.log(`inventario: ${t.vaultItems} items en el vault, ${t.indexed} indexados (${t.notIndexed} fuera).`);
  console.log(`carpetas sin ingest: ${inv.folders.filter((f) => !f.scanned).map((f) => f.name).join(', ')}`);
  console.log(`-> catalog/inventory.json + catalog/inventory.md`);
}

main();
