// Transporte Claude para la frontera CopyGenerator: implementa LlmInfer contra la Messages API de
// Anthropic. Es el equivalente a enrutar `page-content-1` al servidor de Relume, pero el prompt lo
// escribimos nosotros (el de Relume vive en su servidor, no en el extract). La key sale SOLO de
// `ANTHROPIC_API_KEY` (nunca embebida ni logueada); sin key no se construye y el runner cae al
// generador determinista. Es una llamada de red: manda el brief + contexto de página a Anthropic.

import { llmCopyGenerator, type CopyGenerator, type LlmInfer, type PageContentRequest } from './generator';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
/** Modelo por defecto para redactar copy; override por WT_COPY_MODEL. Sonnet 5.5: buena calidad/costo. */
const DEFAULT_MODEL = 'claude-sonnet-5-5';

export interface ClaudeTransportOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  /** Inyectable para tests: por defecto el fetch global de la plataforma. */
  fetchImpl?: typeof fetch;
}

/** System prompt del contrato page-content-1: redacta copy real por campo, al presupuesto, coherente de
 * página, en el idioma, y devuelve SOLO el JSON que `parsePageContentOutput` (OQ de Relume) espera. */
export function buildSystemPrompt(req: PageContentRequest): string {
  const lote = req.languageLOTE ? ` Write every text value in ${req.languageLOTE}.` : '';
  return [
    'You write the copy for the sections of a marketing landing page.',
    'The user message is a JSON object: page context plus a list of sections. Each section has',
    '"input text fields", and each field has an "id", "css classes" (the role of the text slot, e.g.',
    'a heading, body text, a button label, a quote), a "max length" budget expressed in words or',
    'sentences, and a "placeholder text" hint.',
    '',
    'Rules:',
    `- Write real, specific copy for EVERY field, in ${req.language}.${lote}`,
    '- Respect each field\'s "max length" closely: a heading budgeted "3 words" is about three words.',
    '- Match the slot role: headings are short and concrete, body text explains a benefit, button',
    '  labels are a short call to action, a "quote" placeholder reads like a real customer sentence.',
    '- Keep the whole page coherent and avoid repeating the same headline or message across sections.',
    '- Ground the copy in the "company description". Do not invent specific figures, prices, company or',
    '  person names as if they were facts: where a field is a number, price or testimonial, keep it',
    '  plausible and clearly generic.',
    '- No markdown, no commentary, no code fences.',
    '',
    'Return ONLY a JSON object of this exact shape:',
    '{"sections":[{"section_id":"section_0","real_text_fields":[{"id":1,"text":"..."}]}]}',
    'One entry per section_id given, one real_text_fields entry per input field id.',
  ].join('\n');
}

/** Extrae el primer objeto JSON del texto del modelo (tolerante a texto alrededor, aunque se pida JSON
 * puro). Lanza si no hay objeto parseable: el adaptador LLM normaliza con el parser de Relume después. */
function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('claude: la respuesta no contiene un objeto JSON');
  return JSON.parse(text.slice(start, end + 1));
}

/** Construye el LlmInfer: una llamada a Messages por request de página. */
export function claudeInfer(opts: ClaudeTransportOptions): LlmInfer {
  const doFetch = opts.fetchImpl ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? 4096;
  return async (_prompt, context) => {
    const res = await doFetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: buildSystemPrompt(context),
        messages: [{ role: 'user', content: context.inputJson }],
      }),
    });
    if (!res.ok) {
      // No se incluye el cuerpo por si trae eco de la key; solo el status.
      throw new Error(`claude: Messages API respondió ${res.status}`);
    }
    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    if (!text) throw new Error('claude: respuesta sin texto');
    return parseJsonObject(text);
  };
}

/** Generador de copy respaldado por Claude. `undefined` si no hay `ANTHROPIC_API_KEY`: el runner cae
 * entonces al determinista. `WT_COPY_MODEL` cambia el modelo. */
export function claudeCopyGeneratorFromEnv(env: Record<string, string | undefined> = process.env): CopyGenerator | undefined {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  return llmCopyGenerator(claudeInfer({ apiKey, ...(env.WT_COPY_MODEL ? { model: env.WT_COPY_MODEL } : {}) }));
}
