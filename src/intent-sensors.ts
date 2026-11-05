// Sensores de intención (P1 del reparto 2026-10-23, qa-atomchat/AUDITORIA-QAWebTransformer.md): lo que vio la
// usuaria en el flujo atomchat y ningún sensor de forma marcaba. Deciden sobre la medida del navegador, la misma en
// nuestro dist y en el preview de v0, más el brief o el follow-up que escribió la usuaria. Calibración: 0 en v0.

import type { MeasuredSection, Owner, PageMeasure } from './page-sensors';
import { fold, OTHER, requestedRoles, roleOfKey } from './plan-sensors';
import { roleOfSlug } from './section-slug';

export type IntentField = 'links.dead' | 'cta.link' | 'cta.target' | 'content.brand' | 'attachments.used' | 'edit.scope' | 'images.requested' | 'surface.painted';

export interface IntentDefect {
  field: IntentField;
  owner: Owner;
  section: string;
  expected: string;
  actual: string;
  message: string;
}

const defect = (field: IntentField, owner: Owner, section: string, expected: string, actual: string, message: string): IntentDefect =>
  ({ field, owner, section, expected, actual, message });

/** Un enlace que no lleva a ningún lado (`#`, vacío o un ancla sin destino) dentro de una sección de contenido.
 * El marco no se afirma: v0 j049 deja 14 `#` de relleno en header y footer, el mismo listón que el nuestro. Los
 * enlaces del marco que nombran el canal del brief los cubre `cta.target`. */
export function deadLinks(m: PageMeasure): IntentDefect[] {
  return m.sections.filter((s) => !s.frame).flatMap((s) => (s.links ?? [])
    .filter((l) => l.href === '' || l.href === '#' || l.target === false)
    .map((l) => defect('links.dead', 'A', s.key, 'destino real', l.href || '(vacío)', `"${l.text}" en ${s.role} apunta a ${l.href || '(vacío)'} y no lleva a ningún lado`)));
}

const WHATSAPP = /^(https?:)?\/\/(wa\.me|api\.whatsapp\.com|(www\.)?whatsapp\.com\/send)/i;

/** Si el brief pone WhatsApp como canal, cada enlace que lo nombra abre WhatsApp, y la página tiene al menos uno.
 * v0 lo cumple en atomchat (6 enlaces wa.me con mensaje escrito). Sin WhatsApp en el brief no se afirma. */
export function ctaTarget(m: PageMeasure, brief: string): IntentDefect[] {
  if (!/whatsapp/i.test(brief)) return [];
  const links = m.sections.flatMap((s) => (s.links ?? []).map((l) => ({ s, l })));
  const out = links
    .filter(({ l }) => /whatsapp/i.test(l.text) && !WHATSAPP.test(l.href))
    .map(({ s, l }) => defect('cta.target', 'A', s.key, 'wa.me', l.href || '(vacío)', `"${l.text}" en ${s.role} dice WhatsApp y apunta a ${l.href || '(vacío)'}`));
  if (!links.some(({ l }) => WHATSAPP.test(l.href))) out.push(defect('cta.target', 'A', '-', '≥1 enlace a WhatsApp', '0', 'el brief pide la conversión por WhatsApp y ningún enlace de la página abre WhatsApp'));
  return out;
}

// Mayúscula al inicio, para nombres propios ("Pulso", "Mueblería Roble"); una sigla corta no da señal.
const PROPER = /^\p{Lu}[\p{L}\d]{2,}$/u;

/** Un nombre propio en el alt de una imagen que no está ni en el brief ni en ningún texto de la página: el
 * producto o una marca renombrada que solo existe en la imagen ("Pulso" en el hero de abbcfe51). */
export function brandNames(m: PageMeasure, brief: string): IntentDefect[] {
  // Solo el texto visible: domText trae los propios alt y el nombre se validaría contra sí mismo.
  const known = fold(`${brief} ${m.sections.map((s) => s.text).join(' ')}`);
  const isKnown = (w: string): boolean => new RegExp(`(^|[^\\p{L}])${fold(w)}([^\\p{L}]|$)`, 'u').test(known);
  // Un alt hecho solo de nombres ("Tandem Harbor") es la etiqueta de un logo, no una frase que nombre otra marca.
  const isLabel = (alt: string): boolean => alt.split(/\s+/).filter(Boolean).every((w) => PROPER.test(w));
  return m.sections.flatMap((s) => (s.images ?? []).filter((img) => !isLabel(img.alt)).flatMap((img) => img.alt.split(/[\s,.;:()"“”]+/).slice(1)
    .filter((w) => PROPER.test(w) && !isKnown(w))
    .map((w) => defect('content.brand', 'A', s.key, 'nombres del brief o de la página', w, `el alt de una imagen de ${s.role} nombra "${w}", que no aparece en el brief ni en la página`))));
}

export interface Attachment { name: string; width: number; height: number }

/** Cada imagen adjunta en el mensaje está cargada en la página. Se reconoce por sus dimensiones, porque el
 * nombre cambia al servirla (v0 la sirve desde su URL de origen; nosotros la copiaríamos a public/). */
export function attachmentsUsed(m: PageMeasure, attachments: readonly Attachment[]): IntentDefect[] {
  const loaded = m.sections.flatMap((s) => s.images ?? []);
  return attachments
    .filter((a) => !loaded.some((i) => i.width === a.width && i.height === a.height))
    .map((a) => defect('attachments.used', 'A', '-', `${a.name} ${a.width}x${a.height} en la página`, 'ausente', `la usuaria adjuntó ${a.name} (${a.width}x${a.height}) y no hay ninguna imagen cargada con esas dimensiones`));
}

const norm = (t: string): string => t.normalize('NFKC').replace(/\s+/g, ' ').trim();
const sectionSig = (s: MeasuredSection): string => `${norm(s.text)}|${(s.images ?? []).map((i) => `${i.width}x${i.height}`).join(',')}`;

/** Un follow-up edita: cambian las secciones que nombra (y las que agrega) y el resto queda igual. Se compara el
 * texto visible y las imágenes de cada rol entre la versión anterior y la nueva. v0 en atomchat cambia 2 de 10. */
// header y footer comparten el rol `frame`, y todo id fuera del vocabulario cae en `other` (el agente nombra
// "preguntas" y "cierre"): esos se distinguen por su nombre, o se compararía una sección con otra.
const slotOf = (key: string): string => (['frame', OTHER].includes(roleOfKey(key)) ? fold(roleOfSlug(key)) : roleOfKey(key));

export function editScope(before: PageMeasure, after: PageMeasure, followUp: string): IntentDefect[] {
  const named = requestedRoles(followUp);
  const old = new Map(before.sections.map((s) => [slotOf(s.key), s]));
  return after.sections
    .filter((s) => {
      const prev = old.get(slotOf(s.key));
      return prev !== undefined && !named.has(roleOfKey(s.key)) && sectionSig(prev) !== sectionSig(s);
    })
    .map((s) => defect('edit.scope', 'A', s.key, 'igual que antes', 'cambió', `${s.role} cambió y el follow-up no lo pide`));
}

// Pedir que se genere una imagen (no colocar un adjunto): v0 atomchat la genera en beneficios.
const ASK_IMAGE = /\b(genera|generar|crea|crear|generate|create|gera|gerar)\b[^.]*\b(imagen|imagenes|foto|fotos|ilustracion|image|images|photo|illustration|imagem)\b|\b(imagen|foto|image|photo|imagem) nueva\b|\bnew (image|photo)\b/;
const dims = (s: MeasuredSection | undefined): Set<string> => new Set((s?.images ?? []).map((i) => `${i.width}x${i.height}`));

/** Cada sección donde el follow-up pide generar una imagen carga una imagen que antes no tenía y que no es un
 * adjunto. Se lee por frase: "agrega esta infografía en X. Y genera una imagen para Y" pide la imagen solo en Y. */
export function imagesRequested(before: PageMeasure, after: PageMeasure, followUp: string, attachments: readonly Attachment[] = []): IntentDefect[] {
  const asked = fold(followUp).split(/[.;\n]+/).filter((c) => ASK_IMAGE.test(c)).flatMap((c) => [...requestedRoles(c)]);
  const attached = new Set(attachments.map((a) => `${a.width}x${a.height}`));
  const old = new Map(before.sections.map((s) => [slotOf(s.key), s]));
  return [...new Set(asked)].flatMap((role) => {
    const now = after.sections.filter((s) => roleOfKey(s.key) === role);
    const fresh = now.some((s) => [...dims(s)].some((d) => !dims(old.get(slotOf(s.key))).has(d) && !attached.has(d)));
    return fresh ? [] : [defect('images.requested', 'A', now[0]?.key ?? role, `una imagen nueva en ${role}`, 'sin imagen nueva', `el follow-up pide generar una imagen para ${role} y la sección no carga ninguna imagen nueva`)];
  });
}

const rgb = (c: string): number[] => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const distance = (a: string, b: string): number => { const [x, y] = [rgb(a), rgb(b)]; return Math.max(...x.map((v, i) => Math.abs(v - (y[i] ?? 0)))); };
// Menos que esto por canal es el mismo fondo a la vista (un gris 1-2 % más oscuro no se distingue).
const MIN_SURFACE_DELTA = 6;

/** Una sección que pide `muted`, `raised` o `inverse` pinta un fondo distinto del de la página. Sin
 * `data-wt-surface` (v0) no se afirma: es un campo de nuestro contrato. */
export function surfacePainted(m: PageMeasure): IntentDefect[] {
  return m.sections
    .filter((s) => s.surface?.declared && s.surface.declared !== 'base')
    .filter((s) => distance(s.surface!.bg, s.surface!.page) < MIN_SURFACE_DELTA)
    .map((s) => defect('surface.painted', 'B', s.key, `fondo ${s.surface!.declared}`, s.surface!.bg, `${s.role} pide surface ${s.surface!.declared} y pinta el mismo fondo que la página (${s.surface!.bg})`));
}

export interface PageAction { key: string; label: string; href: string }

const LABEL_KEYS = ['label', 'children', 'title', 'text'] as const;
const labelOf = (o: Record<string, unknown>): string | undefined => {
  for (const k of LABEL_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    // El runner recibe el texto de un botón como slot: { $slot: { text, value } }.
    const slot = v && typeof v === 'object' ? (v as { $slot?: { value?: unknown } }).$slot : undefined;
    if (slot && typeof slot.value === 'string' && slot.value.trim()) return slot.value.trim();
  }
  return undefined;
};

/** Acciones que el composer decidió para una sección de page.json: todo nodo con texto y un href a algún lado. */
export function sectionActions(key: string, node: unknown, out: PageAction[] = []): PageAction[] {
  if (Array.isArray(node)) { node.forEach((n) => sectionActions(key, n, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  const o = node as Record<string, unknown>;
  const label = labelOf(o);
  if (typeof o.href === 'string' && o.href.trim() && o.href !== '#' && label) out.push({ key, label, href: o.href.trim() });
  Object.values(o).forEach((v) => sectionActions(key, v, out));
  return out;
}

/** Cada acción de page.json llega como enlace: un <a> con su texto y su destino. Un botón que pierde el href es
 * texto que no lleva a ningún lado (faq9 en el j049 de orq: "Start free" → #cta pintado como <button>). */
export function actionLinks(m: PageMeasure, actions: readonly PageAction[]): IntentDefect[] {
  return actions.flatMap((a) => {
    const s = m.sections.find((x) => x.key === a.key);
    if (!s?.links) return [];
    const label = fold(a.label);
    const same = s.links.filter((l) => fold(l.text).includes(label));
    if (same.some((l) => l.href === a.href)) return [];
    const actual = same.length ? same.map((l) => l.href || '(vacío)').join(', ') : 'sin <a>';
    return [defect('cta.link', 'B', a.key, a.href, actual, `"${a.label}" en ${s.role} debía llevar a ${a.href} y ${same.length ? `el enlace apunta a ${actual}` : 'no sale como enlace'}`)];
  });
}
