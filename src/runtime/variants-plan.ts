// Plan de una corrida de variantes (S5): un título y un prompt propios por variante, escritos antes de generar. En
// Stitch los escribe el agente de la sesión y cada pantalla los trae (ZAP 26790: campo 8 "<marca> - Variante 1: Enfoque …",
// campo 9 "Crea la Variante 1: Enfoque … Mantén estrictamente todas las restricciones"); las N generaciones corren
// después y en paralelo. Aquí es UNA llamada al modelo barato, como el plan de imagen y las sugerencias (AUDIT-COSTO C),
// y no un turno del agente: el agente de cada variante recibe su prompt ya escrito.

import type { Infer } from './infer';

export interface VariantPlan {
  title: string;
  prompt: string;
}

export const MAX_VARIANTS = 5;
const MAX_TITLE = 120;
const MAX_PROMPT = 2000;

export const PLAN_SYSTEM = [
  'Planificas variantes de una landing page que ya existe. Recibes el pedido de variantes (en inglés, con los aspectos a cambiar y los que no se tocan), cuántas hacen falta y, si lo hay, el título de la página y sus secciones.',
  'Devuelve SOLO JSON: {"variants":[{"title":"…","prompt":"…"}]} con exactamente esa cantidad.',
  'Cada variante explora una dirección distinta de las demás. `title` nombra el enfoque en pocas palabras ("Variante 1: Enfoque …"). `prompt` es la instrucción para quien la va a construir sobre la página actual: qué cambia y con qué intención, y que mantiene estrictamente las restricciones del pedido y lo que no debe tocar.',
  // QA A8: las fotos de V1 y V2 salían casi iguales porque los prompts solo cambiaban layout y copy. En Stitch cada variante
  // lleva su prompt propio (ZAP 26790, campo 9) y regenera la pantalla entera, imágenes incluidas.
  'Si la página usa fotos, el prompt de cada variante pide una dirección fotográfica propia (escena, encuadre, luz), distinta de la de las otras variantes.',
  'Escribe title y prompt en el idioma de la página. No inventes datos del negocio que la página no tiene.',
].join('\n');

/** Si el modelo falla o devuelve otra cosa, cada variante sigue con el pedido y su lugar en el grupo: nunca se pierde
 * la corrida por el plan. */
export const fallbackPlan = (basePrompt: string, count: number): VariantPlan[] =>
  Array.from({ length: count }, (_, i) => ({
    title: `Variante ${i + 1}`,
    prompt: `${basePrompt}\n\nEsta es la variante ${i + 1} de ${count}: explora una dirección distinta de las otras ${count - 1}.`,
  }));

function parsePlan(raw: unknown, count: number): VariantPlan[] | undefined {
  const list = (raw as { variants?: unknown } | null)?.variants;
  if (!Array.isArray(list) || list.length < count) return undefined;
  const out = list.slice(0, count).map((v) => {
    const o = (v ?? {}) as { title?: unknown; prompt?: unknown };
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, MAX_TITLE) : '';
    const prompt = typeof o.prompt === 'string' ? o.prompt.trim().slice(0, MAX_PROMPT) : '';
    return title && prompt ? { title, prompt } : undefined;
  });
  return out.every((v): v is VariantPlan => v !== undefined) ? out : undefined;
}

export interface PlanInput {
  basePrompt: string;
  count: number;
  page?: { title?: string; sections?: string[] };
}

export async function planVariants(infer: Infer, input: PlanInput): Promise<{ plans: VariantPlan[]; fallback: boolean; error?: string }> {
  try {
    const plans = parsePlan(await infer(PLAN_SYSTEM, JSON.stringify(input)), input.count);
    if (plans) return { plans, fallback: false };
    return { plans: fallbackPlan(input.basePrompt, input.count), fallback: true, error: 'el plan no trajo una variante válida por cada una' };
  } catch (e) {
    return { plans: fallbackPlan(input.basePrompt, input.count), fallback: true, error: e instanceof Error ? e.message : String(e) };
  }
}
