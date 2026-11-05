// Marcas disponibles para el transport: ids y resúmenes (registry o carpetas locales) y las instrucciones por marca
// que la persona edita fuera del pack. Es el nivel "workspace" de Lovable (custom_instructions) y el catálogo que el
// panel de Tema pinta; no sabe de corridas ni de workspaces. Paso 4 de la modularización de transport.ts.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBrandPack, logoSrc, type BrandPack } from '../brand';
import { localBrandIds } from '../brand-detect';
import { localBrandDir } from '../brand-registry';
import type { RegistrySource } from './registry';
import { LOCAL_OWNER } from './session';

/** Lo que el panel de Tema pinta de una marca. `preset` cuando el acento es uno del contrato (el color lo pone foundation.css). */
export interface BrandSummary { id: string; name: string; accent?: string; preset?: string; background?: string; foreground?: string; fonts?: { display?: string; body?: string }; logoSrc?: string; error?: string }

export function brandSummary(id: string, brand: BrandPack): BrandSummary {
  // El token map va al final de la identidad y puede pisar acento y superficie (brand.ts resolveIdentity): manda él.
  const t = brand.tokens ?? {};
  const accent = t['--accent'] ?? (typeof brand.accent === 'string' ? undefined : brand.accent.base);
  const background = t['--background'] ?? brand.surface?.background;
  const foreground = t['--foreground'] ?? brand.surface?.foreground;
  const fonts = { ...(brand.fonts?.display ? { display: brand.fonts.display } : {}), ...(brand.fonts?.body ? { body: brand.fonts.body } : {}) };
  const logo = logoSrc(brand);
  return { id, name: brand.name, ...(accent ? { accent } : { preset: brand.accent as string }), ...(background ? { background } : {}), ...(foreground ? { foreground } : {}), ...(Object.keys(fonts).length ? { fonts } : {}), ...(logo ? { logoSrc: logo } : {}) };
}

export interface BrandStoreDeps {
  /** Raíz del transport: las instrucciones viven en `<root>/brand-instructions/<id>.json`. */
  root: string;
  /** Carpetas locales de marcas; por defecto `<root>/brands`. */
  brandsRoot?: string;
  /** Registry publicado; sin él, o si no publica marcas, valen las carpetas locales. */
  registry?: (pin?: string) => Promise<RegistrySource>;
  /** Valida y recorta una lista de instrucciones (la misma regla que las del chat); undefined si no es una lista. */
  parseInstructions: (v: unknown) => string[] | undefined;
}

/** Nombre de carpeta de un dueño: el hash, no el id. Un id largo (JWT sub, email) daría ENAMETOOLONG y uno con `/` o `..` saldría
 * de su carpeta; el hash tiene siempre 43 caracteres de [A-Za-z0-9_-]. */
export const ownerSlug = (owner: string): string => createHash('sha256').update(owner).digest('base64url');

export class BrandStore {
  /** Resúmenes por pin del registry: un pack publicado es inmutable por pin. Los locales se releen porque cambian en disco. */
  private summaries = new Map<string, BrandSummary[]>();
  /** Cadena de escritura de memoria por (dueño, marca) (withMemory): serializa PUT y `remember` concurrentes. */
  private memoryChains = new Map<string, Promise<unknown>>();

  constructor(private deps: BrandStoreDeps) {}

  root(): string {
    return this.deps.brandsRoot ?? join(this.deps.root, 'brands');
  }

  localDir(id: string): string {
    return localBrandDir(id, this.root());
  }

  /** Ids de marca disponibles para el cliente: los del índice publicado (latest) o, si el registry no publica marcas, las
   * carpetas locales. */
  async ids(): Promise<string[]> {
    if (!this.deps.registry) return localBrandIds(this.root());
    const r = await this.deps.registry();
    return r.brandIds ? r.brandIds() : localBrandIds(this.root());
  }

  /** GET /brands: los ids (como hasta ahora) y lo que el panel de Tema pinta de cada una. Un pack del registry es inmutable
   * por pin, así que su resumen se guarda por pin; los locales se releen porque cambian en disco. Un pack que no parsea
   * sale con su error en vez de tirar la lista entera. */
  async list(): Promise<{ brands: string[]; items: BrandSummary[] }> {
    const registry = this.deps.registry ? await this.deps.registry() : undefined;
    // Un registry sin marcas (el del repo) deja las del brandsRoot, que se releen porque cambian en disco.
    const published = registry?.brandIds ? registry : undefined;
    const ids = published?.brandIds ? published.brandIds() : localBrandIds(this.root());
    const cached = published ? this.summaries.get(published.pin) : undefined;
    if (cached) return { brands: ids, items: cached };
    const points = registry?.extensionPoints ? await registry.extensionPoints() : undefined;
    const opts = { ...(points ? { extensionPoints: points } : {}), ...(registry ? { pin: registry.pin } : {}) };
    const items = await Promise.all(ids.map(async (id): Promise<BrandSummary> => {
      try {
        const dir = registry?.brandPack ? await registry.brandPack(id) : this.localDir(id);
        // El pack entero, no solo brand.json: uno con DESIGN.md o facts.json roto fallaría al correr y el panel lo daría por bueno.
        return brandSummary(id, loadBrandPack(dir, opts).brand);
      } catch (e) {
        return { id, name: id, error: e instanceof Error ? e.message : String(e) };
      }
    }));
    if (published) this.summaries.set(published.pin, items);
    return { brands: ids, items };
  }

  /** Dónde vive el estado de la persona (instrucciones y memoria) de un dueño. El pack es del catálogo y lo ven todos; esto
   * es de quien lo escribió (identidad §8b). El dueño implícito conserva la ruta de siempre: lo que ya estaba en disco sin
   * dueño es suyo, sin migrar nada. Otro dueño va a `by-owner/<sha256>` (ownerSlug). */
  private ownerDir(base: string, owner: string): string {
    return owner === LOCAL_OWNER ? base : join(base, 'by-owner', ownerSlug(owner));
  }

  /** Reglas de una marca que valen para todos los chats de su dueño (el nivel workspace de Lovable, custom_instructions).
   * Viven fuera del pack: el pack es inmutable por pin y estas las edita la persona. */
  instructionsPath(owner: string, id: string): string {
    return join(this.ownerDir(join(this.deps.root, 'brand-instructions'), owner), `${id}.json`);
  }

  instructions(owner: string, id: string): string[] {
    const path = this.instructionsPath(owner, id);
    if (!existsSync(path)) return [];
    // Un archivo editado a mano que ya no valida no entra al prompt: falla en voz alta en vez de colar reglas sin tope.
    return this.deps.parseInstructions(JSON.parse(readFileSync(path, 'utf8'))) ?? [];
  }

  /** Reemplaza la lista entera; el llamador ya validó el id y la lista. */
  writeInstructions(owner: string, id: string, instructions: string[]): void {
    const path = this.instructionsPath(owner, id);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(instructions, null, 2));
  }

  /** Memoria de la marca (M2): hechos duraderos que el agente guarda con `remember` y la persona edita en el panel. Vive
   * bajo la raíz del transport (`<root>/brand-memory/<id>.md`), como las instrucciones, NO junto al pack: `brandsRoot`
   * puede ser el repo o una carpeta hermana, y ahí no se escribe estado de la persona. */
  memoryPath(owner: string, id: string): string {
    return join(this.ownerDir(join(this.deps.root, 'brand-memory'), owner), `${id}.md`);
  }

  memory(owner: string, id: string): string {
    const path = this.memoryPath(owner, id);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  /** Reemplaza el archivo entero; el llamador ya validó topes, formato y datos personales con memory-edit. Escritura
   * atómica (temp + rename): un GET concurrente lee el archivo viejo o el nuevo entero, nunca uno a medio escribir, y una
   * caída a mitad no trunca la memoria de la persona. */
  writeMemory(owner: string, id: string, text: string): void {
    const path = this.memoryPath(owner, id);
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, path);
    } catch (e) {
      // Disco lleno o destino imposible: el temporal (a medias) no queda en el directorio de la memoria.
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** Sección crítica por (dueño, marca): el PUT de la persona y los `remember` de corridas paralelas son read-modify-write
   * sobre el mismo archivo; sin serializar, dos a la vez se pisan y un hecho se pierde. Encadena por llave; `fn` recibe la
   * memoria ya actual dentro de su turno.
   * HACK: la serialización es por proceso (cadena de promesas en memoria). Lock de archivo cuando dos transports compartan
   * el mismo root. */
  withMemory<T>(owner: string, id: string, fn: (current: string) => T): Promise<T> {
    const key = `${owner}\u0000${id}`;
    const prev = this.memoryChains.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => fn(this.memory(owner, id)));
    this.memoryChains.set(key, run);
    // Poda: sin esto, cada id que llega (un GET con cualquier id de marca válido) deja una entrada para siempre. Solo si la
    // cadena sigue siendo la propia: otra sección crítica encolada detrás ya la reemplazó y se poda a sí misma.
    const prune = (): void => { if (this.memoryChains.get(key) === run) this.memoryChains.delete(key); };
    void run.then(prune, prune);
    return run;
  }
}
