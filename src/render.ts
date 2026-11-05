// Render de la página elegida como PREVIEW visual: apila la imagen renderizada real de cada pieza
// (el preview del MCP) en orden: banner → navbar → strips → footer. No construye React/Tailwind:
// muestra el diseño real de los componentes elegidos, suficiente para juzgar composición y criterio.

import type { Brief } from './types';
import type { PageResult } from './select';
import type { Selection } from './types';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function strip(s: Selection, kind: 'frame' | 'content'): string {
  const img = s.pick.preview
    ? `<img src="${esc(s.pick.preview)}" alt="${esc(s.pick.slug)}" loading="lazy">`
    : `<div class="missing">sin preview: ${esc(s.pick.slug)}</div>`;
  const { light, dark } = s.pick.surface;
  const style = ` (${esc(s.pick.geometry)} · ${esc(light === dark ? light : `${light}/${dark}`)})`;
  return `<section class="strip ${kind}">
  <figure>${img}</figure>
  <figcaption><b>${esc(s.role)}</b> · ${esc(s.pick.slug)} <span>${style} · score ${s.score}</span><br>${esc(s.reasons.join(' · '))}</figcaption>
</section>`;
}

export function renderPage(brief: Brief, page: PageResult): string {
  const parts: string[] = [];
  if (page.frame.banner) parts.push(strip(page.frame.banner, 'frame'));
  if (page.frame.navbar) parts.push(strip(page.frame.navbar, 'frame'));
  for (const s of page.strips) parts.push(strip(s, 'content'));
  if (page.frame.footer) parts.push(strip(page.frame.footer, 'frame'));

  const frameList = (['banner', 'navbar', 'footer'] as const)
    .filter((r) => page.frame[r])
    .map((r) => `${r}=${page.frame[r]!.pick.slug}`)
    .join(', ');

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>web-transformer — ${esc(brief.summary)}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 -apple-system, system-ui, sans-serif; color: #18181b; background: #fff; }
header { padding: 24px 20px; border-bottom: 1px solid #e4e4e7; }
header h1 { margin: 0 0 4px; font-size: 18px; }
header .meta { color: #52525b; font-size: 13px; }
main { max-width: 1100px; margin: 0 auto; }
.strip figure { margin: 0; }
.strip img { display: block; width: 100%; height: auto; }
.strip.frame figure { background: #fafafa; }
.strip figcaption { padding: 10px 20px 24px; font-size: 12px; color: #52525b; border-bottom: 1px solid #f4f4f5; }
.strip figcaption b { color: #18181b; text-transform: uppercase; letter-spacing: .04em; }
.strip.frame figcaption b { color: #7c3aed; }
.strip figcaption span { color: #a1a1aa; }
.missing { padding: 60px; text-align: center; color: #a1a1aa; background: #fafafa; }
</style></head>
<body>
<header>
  <h1>${esc(brief.summary)}${brief.goal ? ` — ${esc(brief.goal)}` : ''}</h1>
  <div class="meta">tono ${esc(brief.tone ?? 'clean')} · marco: ${esc(frameList || '—')} · ${page.strips.length} strips · total ${page.total}<br>cohesión: ${esc(page.cohesionReasons.join('; ') || '—')}</div>
</header>
<main>
${parts.join('\n')}
</main>
</body></html>`;
}
