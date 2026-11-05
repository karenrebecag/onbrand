// Frontera del generador de copy: el contrato es el del prompt `page-content-1` de Relume
// (relume-llm-infer/paginas/page-content.js:152-158). Entrada = inputJson con contexto de página +
// secciones con sus campos de texto presupuestados, idioma y languageLOTE; salida = secciones con
// `real_text_fields` {id, text}. Una implementación es determinista (sin red); la LLM es un adaptador
// inyectable al que se le pasa el transporte: aquí no hay cliente HTTP, endpoint ni token, a propósito.

import type { InputTextField } from './slot-model';

export interface SectionInput {
  section_id: string;
  /** Categoría de la sección (en Relume el nombre de la categoría; aquí el rol). */
  category: string;
  /** Qué debe contar la sección (descripción de la sección en el sitemap de Relume). */
  outline: string;
  'input text fields': InputTextField[];
}

/** Réplica del objeto `q` de generateCopy: las claves con espacios son las que Relume serializa. */
export interface PageContentInput {
  'project name'?: string;
  'company description'?: string;
  'all pages': string[];
  'page name': string;
  'page sections': string[];
  'page additional instructions'?: string;
  'page content'?: string;
  'context instructions'?: string;
  sections: SectionInput[];
}

/** El promptContext literal de `llm.infer("page-content-1", ...)`. */
export interface PageContentRequest {
  inputJson: string;
  /** Nombre del idioma ("Spanish"), como `m.G6[locale].name` en Relume. */
  language: string;
  /** Solo si el idioma no es inglés (Relume lo omite para en-*). */
  languageLOTE?: string;
}

export interface RealTextField {
  id: number;
  text: string;
}

export interface SectionOutput {
  section_id: string;
  real_text_fields: RealTextField[];
}

export interface PageContentOutput {
  sections: SectionOutput[];
}

export interface CopyGenerator {
  readonly id: string;
  generate(req: PageContentRequest): Promise<PageContentOutput>;
}

export type Lang = 'es' | 'en';

export const LANGUAGE_NAME: Readonly<Record<Lang, string>> = { es: 'Spanish', en: 'English' };

export const parseLang = (raw: string | undefined): Lang => {
  if (raw === undefined) return 'es';
  if (raw === 'es' || raw === 'en') return raw;
  throw new Error(`idioma no soportado: ${raw} (es|en)`);
};

/** Parseo tolerante de la respuesta, calcado de `OQ` (page-content.js:219): ignora secciones o campos
 * mal formados en vez de fallar, y solo acepta `id` numérico + `text` string. */
export function parsePageContentOutput(raw: unknown): PageContentOutput {
  const sections: SectionOutput[] = [];
  if (!raw || typeof raw !== 'object') return { sections };
  const list = (raw as { sections?: unknown }).sections;
  if (!Array.isArray(list)) return { sections };
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const sid = (s as { section_id?: unknown }).section_id;
    if (typeof sid !== 'string') continue;
    const fields = (s as { real_text_fields?: unknown }).real_text_fields;
    const real: RealTextField[] = [];
    if (Array.isArray(fields)) {
      for (const fld of fields) {
        if (!fld || typeof fld !== 'object') continue;
        const { id, text } = fld as { id?: unknown; text?: unknown };
        if (typeof id === 'number' && typeof text === 'string') real.push({ id, text });
      }
    }
    sections.push({ section_id: sid, real_text_fields: real });
  }
  return { sections };
}

/** Transporte de un LLM: recibe el nombre del prompt y su contexto, devuelve el JSON ya parseado.
 * Quien lo implemente decide proveedor, credenciales y streaming; este módulo no sabe nada de eso. */
export type LlmInfer = (prompt: 'page-content-1', context: PageContentRequest) => Promise<unknown>;

/** Adaptador LLM: delega en el transporte inyectado y normaliza la respuesta con el parser de Relume.
 * Sin transporte no se puede construir (no hay credenciales embebidas ni endpoint por defecto). */
export function llmCopyGenerator(infer: LlmInfer): CopyGenerator {
  return {
    id: 'llm',
    async generate(req) {
      return parsePageContentOutput(await infer('page-content-1', req));
    },
  };
}
