// Fuente de verdad del contrato de componente (paso 4.3a): extrae los props de un bloque Arc desde su
// INTERFACE TS (no desde doc.md). Lee la interface de props del componente exportado, resuelve los
// tipos de item de los props array-de-objetos (en el .tsx o en el *-data.ts hermano) y los aplana a la
// notación de rutas que ya consume buildSchema (`features`, `features[].title`). doc.md solo aporta
// `description` después. Sin dep de typescript (bloqueada): parser con conteo de llaves, suficiente para
// las interfaces de Arc (planas, sin genéricos de usuario, sin `extends`). Falla DURO: si no encuentra
// la interface de props, lanza —el gen no hace skip ni cae a doc en silencio, así CI atrapa el typo.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface TsProp {
  /** Ruta del prop: `title`, `features`, `features[].title`. */
  name: string;
  /** Tipo TS crudo, normalizado a una línea. */
  type: string;
  required: boolean;
  /** Campo de un objeto con tipo nombrado (`newsletter.title`): lo clasifica su padre, no la política. */
  field?: true;
  /** JSDoc del prop de primer nivel: los ports no tienen tabla de props en doc.md y su contrato vive aquí. */
  doc?: string;
}

const pascal = (slug: string): string => slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

/** Cuerpo `{...}` que empieza en `open` (índice de la `{`), con conteo de llaves que ignora las de
 * dentro de strings y plantillas. Devuelve el contenido entre llaves y el índice de cierre. */
function braceBody(src: string, open: number): { body: string; end: number } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    // Saltar comentarios: sus llaves (p.ej. `{ sync: ... }` en un jsdoc) no cuentan.
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { body: src.slice(open + 1, i), end: i }; }
  }
  throw new Error('ts-props: llave sin cerrar');
}

/** Encuentra `(export )?(interface|type) <name>` y devuelve el cuerpo `{...}` de su definición. null si
 * no existe o si es un type-alias que no es un objeto literal (union, primitivo). */
function interfaceBody(src: string, name: string): string | null {
  // Anclado a inicio de línea: `import { type ButtonProps }` no es la definición.
  const re = new RegExp(`^[ \\t]*(?:export\\s+)?(interface|type)\\s+${name}\\b`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open === -1) return null;
  // Para `type X = "a" | "b"` (sin `{`) no hay cuerpo de objeto: no es un item expandible.
  if (m[1] === 'type') {
    const eq = src.indexOf('=', m.index);
    if (eq === -1 || eq > open) return null;
    const between = src.slice(eq + 1, open).trim();
    if (between !== '') return null; // `type X = Foo & { ... }` u otra forma: no la expandimos
  }
  return braceBody(src, open).body;
}

/** Parte el cuerpo de una interface en miembros de nivel superior (respeta llaves/paréntesis/corchetes
 * y strings), y descarta separadores `;`/`,`/saltos. Devuelve cada miembro con su jsdoc previo. */
function splitMembers(body: string): { jsdoc: string; decl: string }[] {
  const out: { jsdoc: string; decl: string }[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = '';
  // El salto de línea separa miembros, así que un jsdoc en su propia línea llega solo: se guarda para el siguiente.
  let pending = '';
  const flush = () => {
    const raw = buf.trim();
    buf = '';
    if (!raw) return;
    // Separa un jsdoc `/** ... */` inicial del resto de la declaración.
    const jm = /^\/\*\*([\s\S]*?)\*\//.exec(raw);
    const jsdoc = jm ? jm[1].replace(/^\s*\*?/gm, '').replace(/\s+/g, ' ').trim() : '';
    const decl = (jm ? raw.slice(jm[0].length) : raw).replace(/\/\/[^\n]*/g, '').trim();
    if (!decl) { if (jsdoc) pending = jsdoc; return; }
    out.push({ jsdoc: jsdoc || pending, decl });
    pending = '';
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      buf += c;
      if (c === '\\') { if (i + 1 < body.length) { buf += body[i + 1]; i++; } continue; }
      if (c === quote) quote = null;
      continue;
    }
    // Comentarios: se copian tal cual al buffer (el jsdoc se lee en flush), sin contar sus llaves ni
    // tomar un `,` interno como separador de miembro.
    if (c === '/' && body[i + 1] === '*') { const e = body.indexOf('*/', i + 2); const end = e === -1 ? body.length : e + 2; buf += body.slice(i, end); i = end - 1; continue; }
    if (c === '/' && body[i + 1] === '/') { const e = body.indexOf('\n', i); const end = e === -1 ? body.length : e; buf += body.slice(i, end); i = end - 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; buf += c; continue; }
    // La flecha `=>` no es un cierre de genérico: su `>` no debe decrementar la profundidad.
    if (c === '=' && body[i + 1] === '>') { buf += '=>'; i++; continue; }
    if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
    else if (c === '}' || c === ')' || c === ']' || c === '>') depth--;
    if ((c === ';' || c === ',' || c === '\n') && depth === 0) { flush(); continue; }
    buf += c;
  }
  flush();
  return out;
}

/** Sustituye cada alias de literales de `type` por su cuerpo en `ext`; descarta los que son `never`. */
function inlineAliases(type: string, ext: string): string {
  const parts = type.split('|').map((p) => p.trim()).filter(Boolean);
  const resolved = parts.flatMap((name) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [name];
    if (new RegExp(`type\\s+${name}\\s*=\\s*never\\s*;`).test(ext)) return [];
    const body = new RegExp(`type\\s+${name}\\s*=\\s*((?:\\s*\\|?\\s*["'][^"']*["'])+)\\s*;`).exec(ext)?.[1];
    return [body ? body.trim().replace(/^\|\s*/, '') : name];
  });
  return resolved.join(' | ');
}

/** Partes de un alias intersección `A & Partial<B> & { ... }` al nivel superior. */
function intersectionParts(rhs: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const c of rhs) {
    if ('<({['.includes(c)) depth++;
    else if ('>)}]'.includes(c)) depth--;
    if (c === '&' && depth === 0) { parts.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf.trim());
  return parts.filter(Boolean);
}

/** Miembros de `type X = ComponentPropsWithoutRef<"section"> & Partial<Props> & { children?: ReactNode }`,
 * la forma de las secciones Relume portadas. Los tipos ajenos al archivo (atributos HTML, Omit de ellos)
 * son passthrough y no entran al contrato; `Partial<T>` vuelve opcionales los miembros de T. null si el
 * alias no es una intersección con alguna parte local. */
function intersectionMembers(src: string, name: string, external: (typeName: string) => string | null = () => null): { decl: string; forceOptional: boolean }[] | null {
  const m = new RegExp(`(?:export\\s+)?type\\s+${name}\\s*=`).exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  let end = start;
  for (let depth = 0; end < src.length; end++) {
    const c = src[end];
    if (c === '{') { end = braceBody(src, end).end; continue; }
    if ('<(['.includes(c)) depth++;
    else if ('>)]'.includes(c)) depth--;
    else if (c === ';' && depth === 0) break;
  }
  const parts = intersectionParts(src.slice(start, end));
  if (parts.length < 2) return null;
  return partsMembers(parts, src, external);
}

/** Miembros de las partes de una intersección: `Pick<Externo, ...>` resuelto contra su archivo, `Partial<T>`
 * y `{...}` inline o un tipo local. null si ninguna parte es local (todo passthrough). */
function partsMembers(parts: string[], src: string, external: (typeName: string) => string | null): { decl: string; forceOptional: boolean }[] | null {
  const out: { decl: string; forceOptional: boolean }[] = [];
  let local = false;
  for (const part of parts) {
    // `Pick<ButtonProps, "variant" | "size">` de otro archivo: las claves elegidas son parte del contrato
    // aunque su tipo viva fuera. Opcionales, porque la opcionalidad de origen no se ve desde aquí.
    const pick = /^Pick<\s*([A-Za-z_$][\w$]*)\s*,\s*((?:["'][^"']+["']\s*\|?\s*)+)>$/.exec(part);
    if (pick && interfaceBody(src, pick[1]) === null) {
      local = true;
      const ext = external(pick[1]);
      const extBody = ext ? interfaceBody(ext, pick[1]) : null;
      const extMembers = new Map((extBody ? splitMembers(extBody) : []).flatMap(({ decl }) => { const pm = parseMember(decl); return pm ? [[pm.key, pm.type] as const] : []; }));
      for (const k of pick[2].match(/[^"'|\s]+/g) ?? []) {
        const t = extMembers.get(k);
        // Un alias de literales del otro archivo (`ButtonVariant`) se inlinea: aquí no se ve su cuerpo. El tipo puede ser
        // una unión de alias (`ButtonVariant | BrandButtonVariant`): cada nombre se resuelve solo y un `never` se descarta.
        const alias = t && ext ? inlineAliases(t, ext) : undefined;
        out.push({ decl: `${k}?: ${alias ?? t ?? `${pick[1]}["${k}"]`}`, forceOptional: true });
      }
      continue;
    }
    const partial = /^Partial<\s*([A-Za-z_$][\w$]*)\s*>$/.exec(part);
    const ref = partial?.[1] ?? (/^[A-Za-z_$][\w$]*$/.test(part) ? part : null);
    const body = part.startsWith('{') ? braceBody(part, 0).body : ref ? interfaceBody(src, ref) : null;
    if (body === null) continue;
    local = true;
    for (const { decl } of splitMembers(body)) out.push({ decl, forceOptional: Boolean(partial) });
  }
  return local ? out : null;
}

/** De una declaración `name?: type` saca nombre, opcionalidad y tipo (en una línea). null si no es un
 * miembro con nombre (p.ej. una firma de índice o un método sin `:`). */
function parseMember(decl: string): { key: string; optional: boolean; type: string } | null {
  const m = /^(readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/.exec(decl);
  if (!m) return null;
  return { key: m[2], optional: Boolean(m[3]), type: m[4].replace(/\s+/g, ' ').trim() };
}

/** ¿El tipo es un array de objetos expandible? Devuelve el nombre del tipo de item, o null para
 * `string[]`/`number[]`/`boolean[]` o cualquier cosa que no sea `Identificador[]`. */
function objectArrayItem(type: string): string | null {
  const m = /^([A-Za-z_$][\w$]*)\[\]$/.exec(type.trim());
  if (!m) return null;
  if (/^(string|number|boolean|unknown|any|ReactNode)$/.test(m[1])) return null;
  return m[1];
}

/** `Name`, `Name | null` o `Partial<Name>` con Name en PascalCase que no sea un tipo de React: el objeto
 * nombrado cuyos campos se pueden expandir. null para todo lo demás. */
function namedObject(type: string): { name: string; partial: boolean } | null {
  const t = type.replace(/\s*\|\s*(null|undefined)\s*$/, '').trim();
  const m = /^(Partial<\s*)?([A-Z][\w$]*)(\s*>)?$/.exec(t);
  if (!m || Boolean(m[1]) !== Boolean(m[3])) return null;
  if (/^(ReactNode|ReactElement|CSSProperties|Record|Date|HTMLElement)$/.test(m[2])) return null;
  return { name: m[2], partial: Boolean(m[1]) };
}

/** Cuerpo del tipo literal inline anotado sobre el parámetro desestructurado del componente
 * (`function X({ a, b }: { a: string; b?: number })`): el contrato vive en la firma, sin tipo nombrado.
 * Devuelve el cuerpo `{...}` del tipo, o null si el parámetro no usa un objeto literal inline. */
function inlineParamType(src: string, exportName: string): string | null {
  const fn = new RegExp(`export\\s+(?:default\\s+)?function\\s+${exportName}\\s*\\(`, 'm').exec(src)
    ?? new RegExp(`export\\s+(?:const|default function)\\s+${exportName}\\b[^=]*=\\s*\\(`, 'm').exec(src);
  if (!fn) return null;
  // El primer `{` tras el `(` abre el patrón de desestructuring; se salta entero.
  const patOpen = src.indexOf('{', fn.index + fn[0].length - 1);
  if (patOpen === -1) return null;
  const pat = braceBody(src, patOpen);
  const rest = src.slice(pat.end + 1);
  const colon = /^\s*:\s*/.exec(rest);
  if (!colon) return null;
  const typeOpen = pat.end + 1 + colon[0].length;
  if (src[typeOpen] !== '{') return null; // `: XProps` nombrado lo resuelve propsTypeName
  return braceBody(src, typeOpen).body;
}

/** Localiza el tipo de props del componente exportado: su anotación `: XProps` (en firma o destructuring)
 * o, si no, `<Pascal>Props`. Devuelve el nombre del tipo. */
function propsTypeName(src: string, exportName: string, slug: string): string | null {
  // `export function X(... : Name)` o `export function X({...}: Name)`
  const fn = new RegExp(`export\\s+function\\s+${exportName}\\s*\\(([\\s\\S]*?)\\)`, 'm').exec(src);
  const arrow = new RegExp(`export\\s+(?:const|default function)\\s+${exportName}\\b[^=]*=?\\s*\\(([\\s\\S]*?)\\)\\s*(?::|=>)`, 'm').exec(src);
  const param = (fn ?? arrow)?.[1];
  if (param) {
    const ann = /:\s*([A-Za-z_$][\w$]*)\s*$/.exec(param.trim());
    if (ann) return ann[1];
  }
  const pas = `${pascal(slug)}Props`;
  if (new RegExp(`(?:export\\s+)?(?:interface|type)\\s+${pas}\\b`).test(src)) return pas;
  return null;
}

/**
 * Props del bloque desde su interface TS. `slug` para el nombre por convención y el *-data.ts hermano;
 * `exportName` el componente exportado. Aplana los props array-de-objetos a `name[].field`. Lanza si no
 * encuentra la interface de props (el gen debe fallar, no caer a doc).
 */
export function tsPropsOf(sourceFile: string, slug: string, exportName: string): TsProp[] {
  const src = readFileSync(sourceFile, 'utf8');
  // Contrato anotado inline sobre el parámetro (`{ ... }: { ... }`): no hay tipo nombrado que resolver.
  const inline = inlineParamType(src, exportName);
  const typeName = inline === null ? propsTypeName(src, exportName, slug) : null;
  if (inline === null && !typeName) throw new Error(`ts-props: ${slug}: no se encontró el tipo de props del componente ${exportName}`);
  const body = inline ?? (typeName !== null ? interfaceBody(src, typeName) : null);
  // El archivo de un tipo importado por ruta relativa (`type ButtonProps` de ../../../arc/button/button).
  const external = (typeName: string): string | null => {
    const imp = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${typeName}\\b[^}]*\\}\\s*from\\s*["'](\\.[^"']+)["']`).exec(src);
    if (!imp) return null;
    const file = ['.tsx', '.ts'].map((ext) => join(dirname(sourceFile), imp[1] + ext)).find(existsSync);
    if (!file) return null;
    const text = readFileSync(file, 'utf8');
    // Un alias de ese archivo puede venir de otro hermano (BrandButtonVariant de button.brand.ts): se suman sus
    // imports relativos, un nivel, para que el alias se resuelva en vez de quedar como nombre suelto.
    const siblings = [...text.matchAll(/import\s+type\s*\{[^}]*\}\s*from\s*["'](\.[^"']+)["']/g)]
      .map((m) => ['.ts', '.tsx'].map((ext) => join(dirname(file), m[1] + ext)).find(existsSync))
      .filter((f): f is string => Boolean(f))
      .map((f) => readFileSync(f, 'utf8'));
    return [text, ...siblings].join('\n');
  };
  const members: { decl: string; forceOptional: boolean; jsdoc?: string }[] | null = body !== null ? splitMembers(body).map(({ decl, jsdoc }) => ({ decl, forceOptional: false, jsdoc })) : typeName !== null ? intersectionMembers(src, typeName, external) : null;
  if (members === null) throw new Error(`ts-props: ${slug}: interface ${typeName} no encontrada o no es un objeto`);

  // Para resolver tipos de item: primero el propio .tsx, luego el *-data.ts hermano.
  const dataFile = (() => {
    const dir = dirname(sourceFile);
    const guess = join(dir, `${slug}-data.ts`);
    return existsSync(guess) ? readFileSync(guess, 'utf8') : '';
  })();
  const resolveItem = (name: string): { decl: string; forceOptional: boolean }[] | null => {
    const body = interfaceBody(src, name) ?? (dataFile ? interfaceBody(dataFile, name) : null);
    return body !== null ? splitMembers(body).map(({ decl }) => ({ decl, forceOptional: false })) : intersectionMembers(src, name, external);
  };

  const out: TsProp[] = [];
  /** Expande un tipo intersección (o array de ella) bajo `path`; false si el tipo no lo es. */
  const expandIntersection = (path: string, type: string, field: boolean): boolean => {
    const bare = type.replace(/\s*\|\s*(null|undefined)\s*$/, '').trim();
    const arr = /^\((.+)\)\[\]$/.exec(bare);
    // Un alias local (`buttons?: Layout122Button[]` con `type Layout122Button = Pick<...> & {...}`) se
    // resuelve igual que el inline: si no, el array quedaba opaco en el schema.
    const named = /^([A-Za-z_$][\w$]*)(\[\])?$/.exec(bare);
    const aliased = named ? intersectionMembers(src, named[1], external) : null;
    const parts = aliased ? [] : intersectionParts(arr?.[1] ?? bare);
    if (!aliased && parts.length < 2) return false;
    const prefix = arr || named?.[2] ? `${path}[]` : path;
    for (const sub of aliased ?? partsMembers(parts, src, external) ?? []) {
      const sm = parseMember(sub.decl);
      if (sm && !/^class(name)?$/i.test(sm.key)) out.push({ name: `${prefix}.${sm.key}`, type: sm.type, required: !sm.optional && !sub.forceOptional, ...(field && prefix === path ? { field: true as const } : {}) });
    }
    return true;
  };
  for (const { decl, forceOptional, jsdoc } of members) {
    const m = parseMember(decl);
    if (!m) continue;
    if (/^class(name)?$/i.test(m.key)) continue; // passthrough técnico, fuera del contrato
    out.push({ name: m.key, type: m.type, required: !m.optional && !forceOptional, ...(jsdoc ? { doc: jsdoc } : {}) });
    // Literal de objeto inline (`brand: { name; mark?: ReactNode }`): se expanden sus hojas solo si
    // lleva un ReactNode, porque ahí hay un slot anidado; el resto ya lo clasifica su padre.
    if (m.type.startsWith('{') && /\bReactNode\b/.test(m.type)) {
      for (const sub of splitMembers(braceBody(m.type, 0).body)) {
        const sm = parseMember(sub.decl);
        if (sm && !/^class(name)?$/i.test(sm.key)) out.push({ name: `${m.key}.${sm.key}`, type: sm.type, required: !sm.optional });
      }
      continue;
    }
    // Objeto con tipo nombrado (`newsletter?: SiteFooterNewsletter | null`, `labels?: Partial<Labels>`): se
    // expanden sus campos para que el schema vea los textos que el composer puede llenar (ADR 0006).
    const named = namedObject(m.type);
    if (named) {
      const fields = resolveItem(named.name);
      for (const sub of fields ?? []) {
        const sm = parseMember(sub.decl);
        if (sm && !/^class(name)?$/i.test(sm.key)) {
          out.push({ name: `${m.key}.${sm.key}`, type: sm.type, required: !sm.optional && !named.partial && !sub.forceOptional, field: true });
          expandIntersection(`${m.key}.${sm.key}`, sm.type, true);
        }
      }
      continue;
    }
    // `button: Pick<ButtonProps, "variant"> & { title: string }` (contrato de botón de los ports Relume):
    // sin expandir, el schema decía solo `object` y el composer inventaba `children` en vez de `title`.
    if (expandIntersection(m.key, m.type, true)) continue;
    const item = objectArrayItem(m.type);
    if (!item) continue;
    const itemMembers = resolveItem(item);
    if (!itemMembers) continue; // item externo/no resoluble: queda como array opaco, no se inventa
    for (const sub of itemMembers) {
      const sm = parseMember(sub.decl);
      if (!sm || /^class(name)?$/i.test(sm.key)) continue;
      out.push({ name: `${m.key}[].${sm.key}`, type: sm.type, required: !sm.optional && !sub.forceOptional });
      expandIntersection(`${m.key}[].${sm.key}`, sm.type, false);
    }
  }
  // Un alias de literales (`visual: BentoVisual`, definido aquí o en el *-data.ts) se inlinea: sin eso el schema
  // decía `object`, el modelo mandaba el string correcto y check_layout lo rechazaba (feature-bento, #173).
  // También el importado (`variant?: ButtonVariant` de ../../button/button) y la unión de alias
  // (`ButtonVariant | BrandButtonVariant`): quedaban `object` y un variant "whatsapp" no validaba.
  // Archivos importados por ruta relativa, más los `import type` de cada uno (BrandButtonVariant de button.brand.ts).
  const importedText = (text: string, dir: string, depth = 1): string[] => [...text.matchAll(/import\s*(?:type\s*)?\{[^}]*\}\s*from\s*["'](\.[^"']+)["']/g)]
    .map((m) => ['.tsx', '.ts'].map((ext) => join(dir, m[1] + ext)).find(existsSync))
    .filter((f): f is string => Boolean(f))
    .flatMap((f) => { const t = readFileSync(f, 'utf8'); return depth > 0 ? [t, ...importedText(t, dirname(f), depth - 1)] : [t]; });
  const aliasText = [src, dataFile, ...new Set([...importedText(src, dirname(sourceFile)), ...importedText(dataFile, dirname(sourceFile))])].join('\n');
  const literalAlias = (type: string): string => {
    if (!/^[A-Za-z_$][\w$]*(\s*\|\s*[A-Za-z_$][\w$]*)*$/.test(type.trim())) return type;
    return inlineAliases(type, aliasText) || type;
  };
  return out.map((p) => ({ ...p, type: literalAlias(p.type) }));
}

/** Las secciones Relume portadas no ponen defaults en la firma: mezclan `{ ...XDefaults, ...props }` con
 * un `export const XDefaults = { ... }`. Cada miembro de ese objeto es el default de su prop, y todo él
 * es el placeholder de Relume ("Medium length heading goes here"): copia de demo, nunca configuración. */
export function mergedDefaultsOf(src: string, exportName: string): Map<string, string> {
  const out = new Map<string, string>();
  const name = `${exportName}Defaults`;
  if (!new RegExp(`\\.\\.\\.${name}\\b`).test(src)) return out;
  const decl = new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(src);
  if (!decl) return out;
  for (const member of topLevelEntries(braceBody(src, decl.index + decl[0].length - 1).body)) {
    const m = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(member);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

/** Entradas `clave: valor` de un literal de objeto, cortadas por comas de nivel superior. A diferencia de
 * splitMembers, un salto de línea no corta: el valor de un default suele seguir en la línea siguiente. */
function topLevelEntries(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    buf += c;
    if (quote) {
      if (c === '\\') { buf += body[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(buf.slice(0, -1).trim()); buf = ''; }
  }
  out.push(buf.trim());
  return out.map((e) => e.replace(/^(\s*\/\/[^\n]*\n)+/, '').trim()).filter(Boolean);
}

/** Defaults del destructuring del componente (`{ items = exampleItems, holdings: h = HOLDINGS }`), por
 * nombre de prop, con la expresión cruda. Vacío si no encuentra la firma: es información extra, el
 * contrato sale de la interface. */
export function propDefaultsOf(src: string, exportName: string): Map<string, string> {
  const out = new Map<string, string>();
  const fn = new RegExp(`function\\s+${exportName}\\s*\\(`).exec(src);
  if (!fn) return mergedDefaultsOf(src, exportName);
  const open = src.indexOf('{', fn.index);
  if (open === -1 || src.slice(fn.index + fn[0].length, open).trim() !== '') return out;
  for (const { decl } of splitMembers(braceBody(src, open).body)) {
    const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$]*\s*)?=\s*([\s\S]+)$/.exec(decl);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}
