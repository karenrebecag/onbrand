// Puro y sin IO: el test lo importa sin cargar playwright ni leer el vault, que el render-gate sí necesita.

/** Atributo del vault → hook del contrato: el map explícito (codemod de motion-gsap) o, si no, el único hook
 * que termina en el mismo nombre (data-max-rotate → data-3d-hover-target-max-rotate). */
export function migrateAttrs(html: string, hooks: readonly string[], renames: Record<string, string> = {}): string {
  const bare = (a: string) => a.replace(/^data-(anm-)?/, '');
  const found = new Set([...html.matchAll(/\b(data-[\w-]+)(?==|[\s>])/g)].map((m) => m[1]));
  const map: Record<string, string> = { ...renames };
  for (const a of found) {
    if (map[a] || hooks.includes(a)) continue;
    const hits = hooks.filter((h) => h.endsWith(`-${bare(a)}`));
    if (hits.length === 1) map[a] = hits[0];
  }
  let out = html;
  for (const [from, to] of Object.entries(map).sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`${from.replace(/[-]/g, '\\-')}(?![\\w-])`, 'g'), to);
  }
  return out;
}
