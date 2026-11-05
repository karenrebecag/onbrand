// Primitivo de publish del CORE: validar un dist ya construido y exportarlo a un destino. SIN red, SIN cuenta, SIN Vercel
// ni Blob. El seam `PublishProvider` deja que una distro enchufe un destino hosted; el core trae solo el export
// LOCAL (copia el dist a una carpeta). La validación `checkPublishable` es pura y vale para cualquier destino: el dist lo
// construyó el agente, así que es dato que puede traer orígenes de dev, rutas del transport o secretos (security-reviewer
// #283, mismo criterio que publish-check de H1).
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface PublishResult {
  /** Dónde quedó el sitio. En el export local es un `file://` a la carpeta. */
  url: string;
  files: number;
  bytes: number;
}

/** El destino de un publish. El core implementa solo el local; una variante añade el hosted (Vercel) detrás del mismo seam. */
export interface PublishProvider {
  publish(dir: string, opts: { chat: string; commit: string; externalOrigins: readonly string[] }): Promise<PublishResult>;
}

export interface PublishError {
  code: string;
  path: string;
  detail: string;
}
export type CheckResult = { externalOrigins: string[]; files: number; bytes: number } & ({ ok: true } | { ok: false; errors: PublishError[] });

const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;
const TEXT_EXT = /\.(html?|css|js|mjs|cjs|json|svg|map)$/i;
// Orígenes de dev que no deben quedar en un sitio publicado (el preview vivo, no el build final).
const DEV = [/https?:\/\/localhost[:/]/i, /https?:\/\/127\.0\.0\.1[:/]/i, /https?:\/\/[^/"'\s]+\.localhost[:/]/i, /\/@vite\//, /\/@fs\//, /__vite_ping/];
// Rutas del transport: un sitio no debe apuntar a la API que lo generó.
const TRANSPORT = [/["'(]\/runs(?:\/|["')])/, /["'(]\/approvals(?:\/|["')])/, /["'(]\/chats(?:\/|["')])/, /["'(]\/api\//];
// Patrones de secreto (nunca se devuelve el valor, solo el patrón y el archivo).
const SECRET: [string, RegExp][] = [['sk-', /\bsk-[A-Za-z0-9]{16,}/], ['ghp_', /\bghp_[A-Za-z0-9]{20,}/], ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/]];
const EXTERNAL = /\bhttps?:\/\/([a-z0-9.-]+)/gi;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|[^/]*\.localhost)$/i;

// Marcador del host en la raíz de dist/<commit> (preview-dist saveDist): no es parte del sitio, así que ni se valida ni
// se copia. Sin esto la regla de archivos ocultos rechazaba todo dist servible (export.ts lo omite igual).
const DIST_MARKER = '.base';

interface Walked {
  rel: string[];
  text: { rel: string; body: string }[];
  files: number;
  bytes: number;
  bad: PublishError[];
}

function walk(root: string): Walked {
  const out: Walked = { rel: [], text: [], files: 0, bytes: 0, bad: [] };
  const recurse = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      const full = join(abs, name);
      const rel = relative(root, full);
      if (rel === DIST_MARKER) continue;
      let st;
      try {
        // lstat y no stat: stat sigue el enlace y nunca ve un symlink, y uno que el agente deje en el dist publicaría
        // archivos de fuera del workspace.
        st = lstatSync(full);
      } catch {
        out.bad.push({ code: 'bad-path', path: rel, detail: 'no se pudo leer' });
        continue;
      }
      if (st.isSymbolicLink()) {
        out.bad.push({ code: 'symlink', path: rel, detail: 'symlink no permitido' });
        continue;
      }
      if (st.isDirectory()) {
        recurse(full);
        continue;
      }
      out.files += 1;
      out.bytes += st.size;
      out.rel.push(rel.split('\\').join('/'));
      // HACK: tope de 2 MiB para escanear texto. Un bundle JS por encima no se revisa, así que un secreto o un origen
      // de dev dentro de él pasa el gate y se publica. Disparador: escanear por streaming (sin cargar el archivo entero)
      // cuando un dist real pase de 2 MiB en JS, o antes del primer publish hosted a un dominio público (lo que ocurra
      // primero). El tope existe para no cargar en RAM un bundle enorme por archivo.
      if (TEXT_EXT.test(name) && st.size < 2 * 1024 * 1024) out.text.push({ rel: rel.split('\\').join('/'), body: readFileSync(full, 'utf8') });
    }
  };
  recurse(root);
  return out;
}

/** Valida un dist servible antes de publicarlo. Puro, sin red. `externalOrigins` lista los hosts http(s) externos del
 *  bundle (para que un destino hosted decida su CSP; el export local no los bloquea). */
export function checkPublishable(dir: string): CheckResult {
  const errors: PublishError[] = [];
  let w: Walked;
  try {
    if (lstatSync(dir).isSymbolicLink()) return { ok: false, errors: [{ code: 'symlink', path: '.', detail: 'el dist es un symlink' }], externalOrigins: [], files: 0, bytes: 0 };
    w = walk(dir);
  } catch {
    return { ok: false, errors: [{ code: 'unreadable', path: '.', detail: 'no se pudo recorrer el dist' }], externalOrigins: [], files: 0, bytes: 0 };
  }
  errors.push(...w.bad);
  if (!w.rel.includes('index.html')) errors.push({ code: 'asset-missing', path: 'index.html', detail: 'el dist no tiene index.html' });
  if (w.files > MAX_FILES) errors.push({ code: 'too-large', path: '.', detail: `${w.files} archivos superan el tope de ${MAX_FILES}` });
  if (w.bytes > MAX_BYTES) errors.push({ code: 'too-large', path: '.', detail: `${w.bytes} bytes superan el tope de ${MAX_BYTES}` });
  for (const rel of w.rel) {
    const base = rel.split('/').pop() ?? rel;
    if (rel.includes('..')) errors.push({ code: 'bad-path', path: rel, detail: 'ruta con ..' });
    if (/(^|\/)\.(env|git)(\/|$)/i.test(rel) || base.startsWith('.')) errors.push({ code: 'forbidden-file', path: rel, detail: 'archivo oculto/sensible' });
    if (/\.map$/i.test(rel)) errors.push({ code: 'forbidden-file', path: rel, detail: 'sourcemap no se publica' });
  }
  const origins = new Set<string>();
  for (const { rel, body } of w.text) {
    for (const re of DEV) if (re.test(body)) errors.push({ code: 'dev-origin', path: rel, detail: `origen de dev (${re.source})` });
    for (const re of TRANSPORT) if (re.test(body)) errors.push({ code: 'transport-route', path: rel, detail: 'referencia a una ruta del transport' });
    for (const [label, re] of SECRET) if (re.test(body)) errors.push({ code: 'secret', path: rel, detail: `posible secreto (${label})` });
    for (const m of body.matchAll(EXTERNAL)) {
      const host = m[1];
      if (host && !LOOPBACK_HOST.test(host)) origins.add(host);
    }
  }
  const externalOrigins = [...origins].sort();
  return errors.length ? { ok: false, errors, externalOrigins, files: w.files, bytes: w.bytes } : { ok: true, externalOrigins, files: w.files, bytes: w.bytes };
}

/** Export local: copia el dist a `<outRoot>/<chat>/` (reemplazándolo) y devuelve un `file://`. Sin red ni cuenta. */
export function localPublish(outRoot: string): PublishProvider {
  return {
    async publish(dir, { chat }) {
      const safe = chat.replace(/[^A-Za-z0-9_-]/g, '_');
      const dest = join(outRoot, safe);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      // Defensa además de checkPublishable: sin dereference y filtrando por lstat, un enlace nunca trae su destino.
      cpSync(dir, dest, { recursive: true, filter: (src) => src !== join(dir, DIST_MARKER) && !lstatSync(src).isSymbolicLink() });
      const w = walk(dest);
      // Un enlace cambiado entre el lstat del filtro y la copia llega como enlace: la copia no se publica a medias.
      if (w.bad.length) {
        rmSync(dest, { recursive: true, force: true });
        throw new Error(`el dist cambió durante la copia: ${w.bad.map((b) => b.path).join(', ')}`);
      }
      return { url: `file://${dest}`, files: w.files, bytes: w.bytes };
    },
  };
}
