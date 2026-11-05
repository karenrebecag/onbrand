// Siguientes pasos como paso propio después del turno, con un modelo barato: Lovable los genera aparte y los ata al
// turno (featureSuggestions en asyncRunResult, re-iteracion/lovable-details/deob/dashboard-shared-CKfq1xYq.deob.js:4754),
// no los saca del texto del resumen. Los de sección no van en el turno: Stitch los pide por pantalla solo al pedirlos
// (DesignPage _Component66, re-iteracion/stitch-ui/deob/webcrack/DesignPage-DeNbrR8l/deobfuscated.js:13864).

import type { EventLog, Suggestion } from './events';
import { boundedSignal, OPTIONAL_TIMEOUT_MS, type Infer } from './infer';
import { MAX_SUGGESTIONS, normalizeText } from './agent-summary';

const MAX_TITLE = 40;
const STEP_ID = 'agent:suggestions';

export interface SuggestInput {
  prompt: string;
  summary: string;
  lang: string;
}

// Reglas sacadas de sugerencias reales (re-iteracion/s3-sugerencias.md): los 17 message de Lovable son cambios que el
// agente hace en el producto; ninguno pide verificar, capturar ni confirmar (QA en Nimbus vio "Recaptura a 1440").
const RULES = [
  '"title": 2 a 5 palabras para el botón. "message": una o dos oraciones, el pedido completo que la persona le manda al agente, en imperativo de segunda persona ("Añade una franja de logos entre el hero y los beneficios").',
  'Cada message es un CAMBIO a la página que el agente hace editando código: diseño, contenido, una sección, datos, SEO o medición. Atado a lo que cambió en este turno cuando se pueda.',
  'Nunca pidas verificar, capturar, probar, validar, confirmar ni revisar: si el resumen deja algo sin verificar, propone el cambio que lo resuelve ("Mejora el menú móvil para que…"), no la verificación.',
  'Datos de ejemplo o inventados: "Reemplaza X con [dato real]", "Quita X" o "Marca X como provisional", con el hueco entre corchetes; nunca "Confirma X".',
  'Si el turno dejó una decisión abierta, ofrece sus opciones como pasos ("Quitar también el enlace" / "Dejar el enlace por ahora").',
  'Nada genérico ni ya hecho, nunca en voz del agente. Escribe en el idioma de la página.',
];

const SYSTEM = [
  'Propones los siguientes pasos de una landing page que otro agente acaba de escribir o editar.',
  'Responde SOLO un objeto JSON: {"page": [{"title": string, "message": string}]}.',
  '"page": exactamente 3 pasos distintos para la página entera.',
  ...RULES,
].join('\n');

function asList(v: unknown, max: number): Suggestion[] {
  if (!Array.isArray(v)) return [];
  const out: Suggestion[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const { title, message } = item as Record<string, unknown>;
    if (typeof title !== 'string' || typeof message !== 'string') continue;
    const t = normalizeText(title);
    const m = normalizeText(message);
    if (!t || !m || t.length > MAX_TITLE || out.some((s) => s.message === m)) continue;
    out.push({ title: t, message: m });
    if (out.length >= max) break;
  }
  return out;
}

/** La respuesta del modelo es dato externo: solo pasan las formas válidas, hasta el tope de Lovable/Stitch. */
export function parseTurnSuggestions(raw: unknown): Suggestion[] {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return asList(obj.page, MAX_SUGGESTIONS);
}

/** El paso de sugerencias del turno. Si el modelo falla, el turno no: queda en rojo y vuelve null para usar el resumen.
 * Los chips viajan en el step.end (followUps): la versión ya está guardada cuando llegan. */
/** `pinned`: un chip que va primero aunque el modelo no lo proponga (el de datos reales de C4, como Lovable). */
export async function suggestTurn(infer: Infer, input: SuggestInput, log: EventLog, timeoutMs: number = OPTIONAL_TIMEOUT_MS, pinned?: Suggestion): Promise<Suggestion[] | null> {
  log.emit({ type: 'step.start', stepId: STEP_ID, kind: 'action', label: 'Proponiendo siguientes pasos' });
  try {
    const proposed = parseTurnSuggestions(await infer(SYSTEM, JSON.stringify(input), boundedSignal(timeoutMs)));
    const page = pinned ? [pinned, ...proposed.filter((x) => x.title !== pinned.title)].slice(0, MAX_SUGGESTIONS) : proposed;
    log.emit({ type: 'step.end', stepId: STEP_ID, label: 'Siguientes pasos', status: 'ok', detail: { kind: 'action', name: 'suggestions', summary: `${page.length} de página`, ...(page.length ? { followUps: page } : {}) } });
    return page;
  } catch (e: unknown) {
    log.emit({ type: 'step.end', stepId: STEP_ID, label: 'Sin siguientes pasos del modelo', status: 'error', error: { type: 'suggestions', message: e instanceof Error ? e.message.slice(0, 300) : String(e) } });
    return null;
  }
}

export const MAX_SECTION_SUGGESTIONS = 5;
// Stitch manda el body de la pantalla sin script/style recortado a 8000 caracteres
// (stitch-ui/deob/webcrack/DesignPage-DeNbrR8l/deobfuscated.js:8482-8486); aquí va la fuente de la sección, que es lo
// que el agente edita: el HTML renderizado no existe en el server sin abrir un navegador.
const SECTION_SOURCE_MAX = 8000;

export interface SectionSuggestInput {
  prompt: string;
  lang: string;
  slug: string;
  role: string;
  source: string;
}

const SECTION_SYSTEM = [
  'Propones cambios para UNA sección de una landing page que otro agente escribió. Recibes su rol y su código.',
  `Responde SOLO un objeto JSON: {"suggestions": [{"title": string, "message": string}]} con 2 a ${MAX_SECTION_SUGGESTIONS} pasos distintos, propios de esa sección.`,
  ...RULES,
].join('\n');

/** Ideas de una sección a pedido, como Stitch por pantalla: una llamada solo cuando la persona la elige
 * (deobfuscated.js:8472-8506, el generate del panel de ideas, con tope `.slice(0, 4)`; aquí 5, el tope del builder). */
export async function suggestSection(infer: Infer, input: SectionSuggestInput, timeoutMs: number = OPTIONAL_TIMEOUT_MS): Promise<Suggestion[]> {
  const raw = await infer(SECTION_SYSTEM, JSON.stringify({ ...input, source: input.source.slice(0, SECTION_SOURCE_MAX) }), boundedSignal(timeoutMs));
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return asList(obj.suggestions, MAX_SECTION_SUGGESTIONS);
}
