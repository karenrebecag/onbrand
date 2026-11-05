// preserve.pinned (Q1, O3): lo que la persona dictó literal queda fijo en los turnos siguientes. Lovable, v0 y Stitch
// conservan un titular dictado ante "Usa un tono más formal en toda la página" por criterio del modelo, sin regla
// visible; Figma Make y nosotros lo pisábamos (re-iteracion/verificacion.md §3b, §6.1 paso 4, §7.3 paso 14). Aquí es un
// contrato: el agente recibe la lista como texto fijo y un sensor mide al cerrar que cada uno siga literal en src/.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userLines } from './plan-edit';

export interface Pin {
  text: string;
  /** Archivo de la versión padre donde está: ahí se busca al cerrar y ahí se reconoce un reemplazo. */
  file: string;
  /** Mensaje que lo dictó. */
  messageId: string;
}

export interface PinnedLost { text: string; file: string; messageId: string }

// Comillas dobles rectas, tipográficas y angulares. Las simples no: un apóstrofo ("Karen's") partiría el texto.
const QUOTED = /"([^"\n]{3,300})"|“([^”\n]{3,300})”|«([^»\n]{3,300})»/g;
const MIN_WORDS = 2;
const MAX_PINS = 20;
// Campos del plan que son copy literal; focal, forma o superficie describen y no se copian tal cual.
const COPY_FIELD = /^\s*[-*]\s*(titular|apoyo|cta)\s*:\s*(.+?)\s*$/i;

/** El texto como queda comparable entre el pedido y el TSX: entidades y `{" "}` de JSX fuera, espacios colapsados. */
export const pinNorm = (s: string): string =>
  s.replace(/\{\s*(["'`])\s*\1\s*\}/g, ' ').replace(/\{\s*["'`]([^"'`{}]*)["'`]\s*\}/g, '$1')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();

/** Textos entre comillas de un pedido, con al menos dos palabras: "Cambia el titular por: «…»". */
export function quotedLiterals(prompt: string): string[] {
  const out = [...prompt.matchAll(QUOTED)].map((m) => pinNorm(m[1] ?? m[2] ?? m[3] ?? '')).filter((t) => t.split(' ').length >= MIN_WORDS);
  return [...new Set(out)];
}

/** Valores de titular/apoyo/cta que la persona escribió en el plan (líneas `usuario:` de plan-edit). */
export function planLiterals(planText: string): string[] {
  return userLines(planText).flatMap((l) => {
    const m = COPY_FIELD.exec(l.text);
    const v = m ? pinNorm(m[2]!.replace(/^["“«]|["”»]$/g, '')) : '';
    return v && !/^(ninguno|none|nada)\.?$/i.test(v) ? [v] : [];
  });
}

/** Lo dictado en cada turno de la cadena, del más viejo al más nuevo, que la versión padre todavía tiene: un texto que ya
 * no está (otro pedido lo reemplazó) no se fija. `files` son los archivos de la versión padre con su contenido. */
export function pinsFrom(turns: readonly { messageId: string; literals: readonly string[] }[], files: Readonly<Record<string, string>>): Pin[] {
  const norm = Object.entries(files).map(([file, body]) => [file, pinNorm(body)] as const);
  const seen = new Set<string>();
  const out: Pin[] = [];
  for (const t of [...turns].reverse()) {
    for (const text of t.literals) {
      if (seen.has(text)) continue;
      seen.add(text);
      const at = norm.find(([, body]) => body.includes(text));
      if (at) out.push({ text, file: at[0], messageId: t.messageId });
    }
  }
  return out.slice(0, MAX_PINS).reverse();
}

/** Archivos de src/ del workspace tal como están ahora, para el sensor. */
export function srcFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (/\.(tsx|ts|jsx|js|html|md)$/.test(e.name)) out[r] = readFileSync(join(dir, r), 'utf8');
    }
  };
  walk('src');
  return out;
}

/** El sensor: cada texto fijo sigue literal en algún archivo. Si el pedido de este turno dicta un texto nuevo y ese texto
 * quedó en el archivo del fijo perdido, es un reemplazo pedido ("cambia el titular por …"), no una pérdida. */
export function pinnedLost(pins: readonly Pin[], files: Readonly<Record<string, string>>, prompt = ''): PinnedLost[] {
  const norm = Object.fromEntries(Object.entries(files).map(([f, b]) => [f, pinNorm(b)]));
  const all = Object.values(norm);
  const dictated = quotedLiterals(prompt);
  return pins.flatMap((p) => {
    if (all.some((b) => b.includes(p.text))) return [];
    if (dictated.some((d) => norm[p.file]?.includes(d))) return [];
    return [{ text: p.text, file: p.file, messageId: p.messageId }];
  });
}

/** Lo que el agente lee en el prompt del follow-up. */
export function pinnedPromptLines(pins: readonly Pin[]): string[] {
  if (!pins.length) return [];
  return [
    'TEXTO FIJO: la persona dictó estos textos literales en pedidos anteriores. Van tal cual, carácter por carácter, aunque este mensaje pida un cambio global (tono, idioma, estilo, longitud). Cámbialos solo si este mensaje los reemplaza o los nombra explícitamente; si el cambio global choca con uno, déjalo igual y dilo en el resumen.',
    ...pins.map((p) => `- "${p.text}" (${p.file})`),
  ];
}
