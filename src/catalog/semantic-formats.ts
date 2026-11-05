// Vocabulario CERRADO y versionado de `format` semánticos para el contrato de componente (paso 4.1).
// Es el puente que faltaba entre el copy y los props: el schema de cada bloque marca QUÉ tipo de
// contenido llena cada prop (un heading, un cta, una foto), para que un inyector genérico —no un
// `case` por slug— pueda llenar cualquiera de los 5000 bloques. El vocabulario es cerrado a propósito:
// un format fuera de esta lista es un error, no una extensión silenciosa.
//
// v2 (paso 4.2): añade `label` y, sobre todo, CLASIFICA cada prop en tres clases (contenido / config /
// estado). Solo el contenido lleva format y entra al denominador de C12b; config y estado (variant,
// locale, defaultX, el valor controlado de un input) no son copy y salen de la métrica.

export const FORMATS_VERSION = 2;

export const SEMANTIC_FORMATS = [
  'heading', 'description', 'tagline', 'label', 'cta', 'link', 'quote', 'person', 'role',
  'company', 'metric', 'price', 'image', 'icon', 'logo', 'chatMessage', 'series', 'tag', 'date',
] as const;

export type SemanticFormat = (typeof SEMANTIC_FORMATS)[number];

/** Clase de un prop. Solo `content` lo llena el copy; `config` elige comportamiento/formato y `state`
 * es el valor actual/por defecto de un control. Config y estado NO llevan format ni cuentan en C12b. */
export type PropClass = 'content' | 'config' | 'state';

export interface FormatGuess {
  format?: SemanticFormat;
  /** `high`: el nombre y el tipo concuerdan con un format. `low`: ambiguo; NO se adivina el format,
   * se marca para revisión humana (x-format-confidence en el schema). */
  confidence: 'high' | 'low';
}

/** Segmento final de una ruta de prop (`features[].title` → `title`), sin corchetes. */
const leafName = (name: string): string => name.split(/[.[]/).filter(Boolean).pop() ?? name;

// Nombres que son ESTADO de un control: su valor actual o inicial, no contenido autoral.
const STATE_NAMES = new Set([
  'value', 'current', 'query', 'end', 'start', 'page', 'index', 'step', 'selected', 'active',
  'open', 'expanded', 'checked', 'position',
]);
// Nombres que son CONFIG: eligen comportamiento/formato/región o son identificadores técnicos que
// pone el mapeo (id/key), no se leen como prosa.
const CONFIG_NAMES = new Set([
  'id', 'key', 'model', 'channel', 'category', 'comparewith', 'currency', 'locale', 'timezone',
  'metric', 'map', 'period', 'ticker', 'mode', 'variant', 'size', 'tone', 'align', 'orientation', 'layout',
]);

/** Clasifica un prop en contenido / config / estado desde su nombre y tipo TS. El orden importa:
 * `defaultX` y los handlers `onX` se resuelven antes que cualquier nombre de contenido. */
export function classifyProp(name: string, type: string): PropClass {
  const leaf = leafName(name);
  const lower = leaf.toLowerCase();
  const t = type.trim();
  if (/^default[A-Z0-9]/.test(leaf)) return 'state'; // defaultX = estado inicial de un prop controlado
  if (/^on[A-Z]/.test(leaf)) return 'config'; // handler, no contenido
  if (STATE_NAMES.has(lower)) return 'state';
  if (CONFIG_NAMES.has(lower)) return 'config';
  if (/\|/.test(t) && /["']/.test(t)) return 'config'; // union de literales = enum de config
  if (/^boolean$/.test(t)) return 'config';
  return 'content';
}

/** Reglas por NOMBRE de prop → format, en orden de prioridad (la primera que matchea gana). Cada una
 * exige además un tipo compatible para contar como alta confianza (ver inferFormat). */
const NAME_RULES: ReadonlyArray<readonly [RegExp, SemanticFormat]> = [
  [/^(title|heading)$/i, 'heading'],
  [/heading$/i, 'heading'],
  [/^(description|subtitle|body|footnote|note|answer|greeting)$/i, 'description'],
  [/^(tagline|eyebrow)$/i, 'tagline'],
  [/(cta|buttonlabel|primaryaction|secondaryaction)$/i, 'cta'],
  [/^placeholder$/i, 'label'],
  [/^(label|caption)$/i, 'tagline'],
  [/(arealabel|areaname|regionlabel|regionnoun)$/i, 'label'],
  [/label$/i, 'label'],
  [/^(href|url)$|link$/i, 'link'],
  [/quote$/i, 'quote'],
  [/^(name|author)$|person$|^faces$/i, 'person'],
  [/^(role|position)$/i, 'role'],
  [/company$/i, 'company'],
  [/(price)$|monthlyprice/i, 'price'],
  [/metric$/i, 'metric'],
  [/(image|photo|avatar)$/i, 'image'],
  [/icon$/i, 'icon'],
  [/(logo)$|^brand$/i, 'logo'],
  [/(message|chat)$/i, 'chatMessage'],
  [/series$/i, 'series'],
  [/date$|datetime$/i, 'date'],
  [/^(prompts|points|topics|tags|meta)$|tag$/i, 'tag'],
  [/question$/i, 'heading'],
];

/** Formats que llevan número, no texto. Un match de nombre con un tipo incompatible baja la confianza. */
const NUMERIC_FORMATS = new Set<SemanticFormat>(['metric']);
/** Formats que pueden ser un objeto/tipo nombrado ({label,href}, {name,image}), no solo texto. */
const STRUCTURED_FORMATS = new Set<SemanticFormat>(['cta', 'link', 'person', 'image', 'icon', 'logo', 'quote', 'chatMessage', 'series', 'date']);

/** ¿El tipo TS del prop es texto plano (candidato a contenido de prosa)? */
const isTextType = (type: string): boolean => /^string(\[\])?$|^string \| undefined$/.test(type.trim());
const isNumberType = (type: string): boolean => /^number(\[\])?$/.test(type.trim());
/** ¿El tipo nombra algo (objeto, tipo con nombre, string)? Para los formats estructurados. */
const isStructuredType = (type: string): boolean => /[A-Za-z{]/.test(type.trim());

/** Infiere el format semántico de un prop desde su nombre y tipo. Deriva confianza: alta solo si el
 * nombre matchea una regla Y el tipo concuerda con la clase del format; si no, `low` sin format. */
export function inferFormat(name: string, type: string): FormatGuess {
  const leaf = leafName(name);
  const rule = NAME_RULES.find(([re]) => re.test(leaf));
  if (!rule) {
    // Sin regla: solo es "contenido" si es texto; se marca low para revisión (puede ser un format nuevo).
    return isTextType(type) ? { confidence: 'low' } : { confidence: 'high' };
  }
  const format = rule[1];
  const typeOk = NUMERIC_FORMATS.has(format)
    ? isNumberType(type)
    : STRUCTURED_FORMATS.has(format)
      ? isStructuredType(type)
      : isTextType(type);
  return typeOk ? { format, confidence: 'high' } : { confidence: 'low' };
}

/** ¿Es un prop de CONTENIDO (lo llena el copy)? Reexpresa classifyProp para el generador de schema. */
export function isContentProp(name: string, type: string): boolean {
  return classifyProp(name, type) === 'content';
}
