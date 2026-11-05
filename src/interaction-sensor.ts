// preview.interaction (Q3, RE de iteración 2026-10-29): la verificación del turno solo carga la página. Un botón que
// falla al pulsarlo (window.atomCalc.open() sin script) pasó typecheck, build y browser a 1440/375 sin dejar rastro;
// Lovable sí pulsó el suyo y vio el error. El preview-check pulsa los botones de las secciones que cambió la versión
// y lo que tira pasa a ser un defecto con el botón nombrado, que entra al repair como los de carga.

import type { Page } from 'playwright';
import type { RuntimeDefect } from './runtime-sensors';

/** Un turno que toca muchas secciones (la página nueva) no debe comerse el timeout del check. */
const MAX_CLICKS = 30;
const SETTLE_MS = 300;

export interface ClickFailure {
  slug: string;
  label: string;
  errors: string[];
}

/** Archivos cambiados → secciones: `src/sections/02-hero.tsx` y su `.module.css` son `02-hero`. */
export function changedSlugs(paths: readonly string[]): string[] {
  const slugs = paths.map((p) => /^src\/sections\/(\d+-[\w-]+?)(?:\.module)?\.(?:tsx|css)$/.exec(p)?.[1]).filter((s): s is string => Boolean(s));
  return [...new Set(slugs)].sort();
}

export function interactionDefects(failures: readonly ClickFailure[], viewport: number): RuntimeDefect[] {
  return failures.map((f) => ({ field: 'preview.runtime', owner: 'L6', kind: 'interaction', slug: f.slug, viewport, message: `al pulsar "${f.label}": ${f.errors.join(' | ')}`.slice(0, 300) }));
}

const withoutHash = (u: string): string => u.split('#')[0] ?? u;

/** Pulsa los botones visibles de esas secciones. Fuera quedan los enlaces (navegan) y los botones de formulario
 * (un submit puede mandar un lead real). `sink` recibe los errores de la página mientras dura cada clic. */
export async function clickControls(page: Page, slugs: readonly string[], sink: { errors: string[] | null }): Promise<ClickFailure[]> {
  const home = withoutHash(page.url());
  const out: ClickFailure[] = [];
  let clicks = 0;
  for (const slug of slugs) {
    const buttons = page.locator(`[data-wt-slug="${slug}"] button:not([disabled]):not([type=submit])`);
    const n = await buttons.count();
    for (let i = 0; i < n && clicks < MAX_CLICKS; i += 1) {
      const b = buttons.nth(i);
      if (!(await b.isVisible()) || (await b.evaluate((e) => Boolean(e.closest('form'))))) continue;
      const label = ((await b.innerText()).trim() || (await b.getAttribute('aria-label')) || 'botón sin texto').replace(/\s+/g, ' ').slice(0, 60);
      const errors: string[] = [];
      sink.errors = errors;
      clicks += 1;
      try {
        await b.click({ timeout: 2000 });
        await page.waitForTimeout(SETTLE_MS);
      } catch {
        // Tapado por otro elemento o animándose: no es un error de la página.
      } finally {
        sink.errors = null;
      }
      await page.keyboard.press('Escape');
      if (withoutHash(page.url()) !== home) await page.goto(home, { waitUntil: 'networkidle' });
      if (errors.length) out.push({ slug, label, errors: [...new Set(errors)] });
    }
  }
  return out;
}
