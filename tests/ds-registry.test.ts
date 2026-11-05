import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { adoptPortedImports, buildIndex, readSourceItem, staticGateOf, closure, guidePath, indexPathOf, itemPath, publishEnv, unreviewed, closureProblems, missingAllow, ratchet, filesSha, hashItem, itemGates, npmDepsOf, motionListing, MOTION_RUNTIME, MOTION_TOKENS, readMotionItems, readMotionTokens, readSharedLib, readVaultItem, secretHits, type RegistryItem, componentSourcesOf, extensionPointsPath } from '../src/ds-registry';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { REPO_ROOT, VAULT_ROOT } from '../src/catalog/load';
import { existsSync } from 'node:fs';

const item = (name: string, content: string, deps: string[] = []): RegistryItem => ({
  name, type: 'registry:ui', dependencies: [], registryDependencies: deps, files: [{ path: `src/components/arc/${name}/${name}.tsx`, content }], categories: [], meta: { origin: 'arc', kind: 'component' }, schema: null,
  allow: { export: 'X', importPath: `@/components/arc/${name}/${name}`, kind: 'component', schema: null, propless: false, accepts: [], provides: [] },
});

describe('ds-registry', () => {
  test('el hash cambia con el contenido: un path r/<slug>@<sha> nunca sirve dos versiones', () => {
    expect(hashItem(item('card', 'a'))).not.toBe(hashItem(item('card', 'b')));
    expect(hashItem(item('card', 'a'))).toBe(hashItem(item('card', 'a')));
  });



  test('una lib que importa otras libs sueltas las declara como deps', () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-lib-'));
    mkdirSync(join(root, 'src/components/relume'), { recursive: true });
    writeFileSync(join(root, 'src/components/brand-icons.tsx'), 'export const XIcon = () => null;\n');
    writeFileSync(join(root, 'src/components/relume/social-network.ts'), 'export const net = () => "X";\n');
    writeFileSync(join(root, 'src/components/relume/social.tsx'), "import { XIcon } from '../brand-icons';\nimport { net } from './social-network';\nexport const S = () => [XIcon(), net()];\n");
    expect(readSharedLib('relume-social', root).registryDependencies).toEqual(['components-brand-icons', 'relume-social-network']);
  });

  test('closure publica las deps transitivas', () => {
    const deps: Record<string, string[]> = { hero: ['button'], button: ['lib-motion'], 'lib-motion': [] };
    expect(closure(['hero'], (s) => deps[s] ?? [])).toEqual(['button', 'hero', 'lib-motion']);
  });

  test('secretHits marca tokens y rutas .env, no el selector CSS .env', () => {
    expect(secretHits([item('a', '.env { color: red; }')])).toEqual([]);
    expect(secretHits([item('b', "dotenv.config({ path: '.env.local' })")])).toHaveLength(1);
    expect(secretHits([item('c', 'const API_KEY = "abcdefgh12345678";')])).toHaveLength(1);
  });

  test('secretHits reconoce formatos de proveedor y claves en minúsculas o con dos puntos', () => {
    const leaks = [
      'const k = "sk_live_' + 'a'.repeat(24) + '";',
      'gh = "ghp_' + 'A'.repeat(36) + '"',
      'aws = "AKIA' + 'B'.repeat(16) + '"',
      'slack = "xoxb-1234567890-abcdefghij"',
      'jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop"',
      '-----BEGIN RSA PRIVATE KEY-----',
      'BLOB = "vercel_blob_rw_' + 'c'.repeat(24) + '"',
      'const cfg = { apiKey: "abcdefgh12345678" };',
      'clientSecret = "abcdefgh12345678"',
    ];
    for (const l of leaks) expect(secretHits([item('x', l)])).toHaveLength(1);
    expect(secretHits([item('ui', 'const label = { token: "Personal access token" };')])).toEqual([]);
  });

  test('secretHits mira también description, schema y allow, no solo los archivos', () => {
    const it = { ...item('card', 'ok'), description: 'usa apiKey: "abcdefgh12345678"' };
    expect(secretHits([it]).map((h) => h.id)).toEqual(['card: (metadatos)']);
  });

  test('un fixture revisado se acepta solo con el contenido revisado: otro secreto en el mismo archivo frena', () => {
    const [hit] = secretHits([item('env', 'const API_KEY = "abcdefgh12345678";')]);
    expect(unreviewed([hit], { [hit.id]: hit.sha })).toEqual([]);
    const [changed] = secretHits([item('env', 'const API_KEY = "abcdefgh12345678"; const T = "ghp_' + 'A'.repeat(36) + '";')]);
    expect(unreviewed([changed], { [hit.id]: hit.sha })).toEqual([changed.id]);
  });

  test('itemPath y guidePath rechazan slugs que salen de su carpeta', () => {
    expect(itemPath('cta13_block', 'abc')).toBe('r/cta13_block@abc.json');
    expect(() => itemPath('../latest', 'abc')).toThrow();
    expect(() => guidePath('a/b', '# x')).toThrow();
  });

  test('indexPathOf solo acepta un índice inmutable como destino de latest', () => {
    expect(indexPathOf({ index: 'index@0123456789abcdef.json' })).toBe('index@0123456789abcdef.json');
    for (const bad of [{ index: 'https://evil.example/i.json' }, { index: '../index@0123456789abcdef.json' }, {}, null]) expect(() => indexPathOf(bad)).toThrow();
  });

  test('publishEnv solo pasa al CLI lo que necesita, sin el resto del entorno', () => {
    const env = publishEnv({ PATH: '/bin', HOME: '/h', BLOB_READ_WRITE_TOKEN: 't', BLOB_STORE_ID: 's', GITHUB_TOKEN: 'g' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', BLOB_READ_WRITE_TOKEN: 't' });
  });


  // #296 partió plan-comparison en .tsx + -data.ts en el scaffold; el registry.json del vault solo lista el .tsx y el .css,
  // y el item publicado importaba un archivo que no viajaba ("fuera de su clausura" al armar el pin sobre 3518d7c).
  test('un archivo del scaffold que el item importa en relativo y el vault no lista entra al item', () => {
    const vault = mkdtempSync(join(tmpdir(), 'reg-vault-'));
    const vdir = join(vault, 'ui-react', 'blocks', 'plan-comparison');
    mkdirSync(join(vdir, 'files', 'registry', 'blocks', 'plan-comparison'), { recursive: true });
    writeFileSync(join(vdir, 'registry.json'), JSON.stringify({ files: [{ path: 'registry/blocks/plan-comparison/plan-comparison.tsx' }, { path: 'registry/blocks/plan-comparison/plan-comparison.module.css' }] }));
    writeFileSync(join(vdir, 'files', 'registry', 'blocks', 'plan-comparison', 'plan-comparison.tsx'), 'export function PlanComparison() { return null; }\n');
    writeFileSync(join(vdir, 'files', 'registry', 'blocks', 'plan-comparison', 'plan-comparison.module.css'), '.root {}\n');
    const scaffold = mkdtempSync(join(tmpdir(), 'reg-scaffold-'));
    const sdir = join(scaffold, 'src/components/arc/blocks/plan-comparison');
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, 'plan-comparison.tsx'), 'import { demoPlans } from "./plan-comparison-data";\nimport styles from "./plan-comparison.module.css";\nexport function PlanComparison() { return demoPlans; }\n');
    writeFileSync(join(sdir, 'plan-comparison.module.css'), '.root {}\n');
    writeFileSync(join(sdir, 'plan-comparison-data.ts'), 'import { labels } from "./plan-comparison-labels";\nexport const demoPlans = labels;\n');
    writeFileSync(join(sdir, 'plan-comparison-labels.ts'), 'export const labels = [];\n');
    const it = readVaultItem('plan-comparison', vault, undefined, null, scaffold);
    expect(it.files.map((f) => f.path)).toEqual([
      'src/components/arc/blocks/plan-comparison/plan-comparison.tsx',
      'src/components/arc/blocks/plan-comparison/plan-comparison.module.css',
      'src/components/arc/blocks/plan-comparison/plan-comparison-data.ts',
      'src/components/arc/blocks/plan-comparison/plan-comparison-labels.ts',
    ]);
    expect(closureProblems([it], new Set())).toEqual([]);
    // Sin scaffold (lectura del vault puro) no se inventa nada.
    expect(readVaultItem('plan-comparison', vault, undefined, null).files).toHaveLength(2);
  });

  // #308 añadió arc/button/action-variant.ts en el scaffold; lo importan heros Morphin y relume/action, y el vault no lo lista:
  // el publish del pin sobre 859408c abortó con 8 imports fuera de la clausura.
  test('un archivo de otra carpeta que la portada añadió entra al item dueño y el importador gana la dep', () => {
    const scaffold = mkdtempSync(join(tmpdir(), 'reg-scaffold-'));
    mkdirSync(join(scaffold, 'src/components/arc/button'), { recursive: true });
    writeFileSync(join(scaffold, 'src/components/arc/button/action-variant.ts'), 'import type { ButtonVariant } from "./button";\nexport const v = (h: string): ButtonVariant => "whatsapp";\n');
    const button = { ...item('button', 'a'), files: [{ path: 'src/components/arc/button/button.tsx', content: 'export type ButtonVariant = "whatsapp";\n' }] };
    const hero = { ...item('morphin-gem-hero', 'b'), type: 'registry:block' as const, files: [{ path: 'src/components/morphin/gem-hero/gem-hero.tsx', content: 'import { v } from "../../arc/button/action-variant";\nexport const GemHero = v;\n' }] };
    const action = { ...item('relume-action', 'c'), registryDependencies: ['button'], files: [{ path: 'src/components/relume/action.tsx', content: 'import { v } from "../arc/button/action-variant";\nexport const A = v;\n' }] };
    const orphan = { ...item('x', 'd'), files: [{ path: 'src/components/arc/x/x.tsx', content: 'import { q } from "../nadie/q";\n' }] };
    // Un item de Arc lleva dentro los archivos de sus deps: api-keys también trae button.tsx y no es el dueño.
    const decoy = { ...item('api-keys', 'e'), files: [{ path: 'src/components/arc/api-keys/api-keys.tsx', content: 'export const K = 1;\n' }, { path: 'src/components/arc/button/button.tsx', content: 'export type ButtonVariant = "whatsapp";\n' }] };
    const before = closureProblems([decoy, button, hero, action, orphan], new Set());
    expect(before).toHaveLength(3);
    const { items, adopted } = adoptPortedImports([decoy, button, hero, action, orphan], scaffold);
    const by = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(by.button.files.map((f) => f.path)).toEqual(['src/components/arc/button/button.tsx', 'src/components/arc/button/action-variant.ts']);
    expect(by['morphin-gem-hero'].registryDependencies).toEqual(['button']);
    expect(by['relume-action'].registryDependencies).toEqual(['button']);
    expect(adopted).toEqual(['button: src/components/arc/button/action-variant.ts']);
    expect(by['api-keys'].files).toHaveLength(2);
    // Lo que no existe en el scaffold ni tiene dueño sigue saliendo en la clausura.
    expect(closureProblems(items, new Set())).toEqual(['x: src/components/arc/x/x.tsx importa ../nadie/q, fuera de su clausura']);
    // Entrada intacta.
    expect(button.files).toHaveLength(1);
    expect(hero.registryDependencies).toEqual([]);
  });


  test('el índice apunta el schema al item, no a una ruta del repo', () => {
    const it = { ...item('card', 'a'), allow: { export: 'Card', importPath: '@/x', kind: 'component' as const, schema: 'catalog/schemas/components/card.schema.json', propless: false, accepts: [], provides: [] }, schema: {} };
    const { index } = buildIndex([{ item: it, sha: 'x', path: 'r/card@x.json' }], {});
    expect(index.items.card.allow?.schema).toBe('r/card@x.json#schema');
  });

  test('motion: runtime depende de los tokens, cada efecto del runtime, con hooks y descripción del listado', () => {
    const root = mkdtempSync(join(tmpdir(), 'motion-'));
    const dir = join(root, 'src/components/arc/lib/motion');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runtime.ts'), 'export const x = 1;');
    writeFileSync(join(dir, 'text-reveal.ts'), 'export const REQUIRED_HOOKS = [\n  "data-a",\n  "data-a-item",\n] as const;\nexport const GSAP_PLUGINS = ["SplitText"] as const;');
    const listing = motionListing('- **Text Reveal** (`text-reveal`, scroll) - Lines rise from a mask.');
    const [rt, fx] = readMotionItems(root, listing);
    expect(rt).toMatchObject({ name: MOTION_RUNTIME, registryDependencies: [MOTION_TOKENS], dependencies: [] });
    expect(fx).toMatchObject({ name: 'motion-text-reveal', registryDependencies: [MOTION_RUNTIME], description: 'Lines rise from a mask.', meta: { kind: 'motion', hooks: ['data-a', 'data-a-item'], plugins: ['SplitText'] } });
  });

  test('motion: el CSS que importa el módulo viaja en el item y la descripción cae a la primera línea', () => {
    const root = mkdtempSync(join(tmpdir(), 'motion-'));
    const dir = join(root, 'src/components/arc/lib/motion');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'underline.ts'), '// Underline (motion-html/underline) en el contrato W6: subraya al pasar.\nimport "./underline.css";\n');
    writeFileSync(join(dir, 'underline.css'), '.u{}');
    const [u] = readMotionItems(root, {});
    expect(u.files.map((f) => f.path)).toEqual(['src/components/arc/lib/motion/underline.ts', 'src/components/arc/lib/motion/underline.css']);
    expect(u.description).toBe('Underline (motion-html/underline) en el contrato W6: subraya al pasar.');
    expect(closureProblems([{ ...u, files: [u.files[0]] }], new Set())).toHaveLength(1);
  });

  test('trinquete: un componente sin AllowEntry ya publicado así se tolera; uno nuevo frena; una lib no cuenta', () => {
    const lib: RegistryItem = { ...item('arc-motion-tokens', ''), type: 'registry:lib', allow: undefined };
    const items = [{ ...item('avatar', ''), allow: undefined }, { ...item('chip', ''), allow: undefined }, lib];
    expect(missingAllow(items)).toEqual(['avatar', 'chip']);
    expect(ratchet(missingAllow(items), new Set(['avatar', 'arc-motion-tokens']))).toEqual({ blocked: ['chip'], tolerated: ['avatar'] });
  });

  test('itemGates: static del catálogo, schemaDemo contra los examples y renderGate solo si el sha coincide', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], examples: [{ title: 'Hola' }] };
    const it = { ...item('hero', 'a'), schema };
    const fresh = { hero: { sha: filesSha(it.files), result: 'ok' as const, at: '2026-10-22T00:00:00Z' } };
    expect(itemGates(it, { ok: true }, fresh)).toEqual({ static: 'ok', schemaDemo: 'ok', renderGate: 'ok' });
    const stale = { hero: { ...fresh.hero, sha: 'otro' } };
    expect(itemGates({ ...it, schema: { ...schema, examples: [{}] } }, null, stale)).toEqual({ static: 'none', schemaDemo: 'fail', renderGate: 'none' });
    expect(itemGates(item('card', 'a'), { ok: false }, {}).schemaDemo).toBe('none');
  });

  test('npmDepsOf: deps reales de los imports, colapsadas al paquete y con el rango del starter', () => {
    const files = [{ path: 'src/components/arc/x/x.tsx', content: 'import { gsap } from "gsap";\nimport { ScrollTrigger } from "gsap/ScrollTrigger";\nimport React from "react";\nimport s from "./x.module.css";\nconst doc = `import crypto from "node:crypto"`;' }];
    expect(npmDepsOf(files, { gsap: '^3.15.0' })).toEqual(['gsap@^3.15.0']);
  });

  test('closureProblems: import relativo fuera de la clausura y paquete fuera del starter frenan; next/image lo da el starter', () => {
    const avatar = item('avatar', 'import { ArcImage } from "../lib/arc-provider";');
    const hero = { ...item('hero', 'import Image from "next/image";\nimport { x } from "left-pad";'), dependencies: ['left-pad'] };
    expect(closureProblems([avatar, hero], new Set(['gsap']))).toEqual([
      'avatar: src/components/arc/avatar/avatar.tsx importa ../lib/arc-provider, fuera de su clausura',
      'hero: src/components/arc/hero/hero.tsx importa left-pad, paquete que el starter no instala',
    ]);
  });

  test('las ranuras de marca van por ruta en el índice y cambian su versión', () => {
    const b = [{ item: item('card', 'a'), sha: 'x', path: 'r/card@x.json' }];
    const path = extensionPointsPath('{"button":{}}');
    expect(path).toMatch(/^extension-points@[0-9a-f]{16}\.json$/);
    const withPts = buildIndex(b, {}, {}, {}, path);
    expect(withPts.index.extensionPoints).toBe(path);
    expect(withPts.sha).not.toBe(buildIndex(b, {}).sha);
    expect(buildIndex(b, {}).index.extensionPoints).toBeUndefined();
  });

  test('el código de un componente extensible sale de su item publicado', () => {
    const button = { ...item('button', 'x'), files: [{ path: 'src/components/arc/button/button.tsx', content: 'TSX' }, { path: 'src/components/arc/button/button.module.css', content: 'CSS' }] };
    const built = [{ item: button, sha: 'x', path: 'r/button@x.json' }];
    expect(componentSourcesOf(built as never, ['button', 'badge'])).toEqual({ button: { tsx: 'TSX', css: 'CSS' } });
  });

  test('el índice cambia de versión si cambia un item o una guía', () => {
    const b = [{ item: item('card', 'a'), sha: 'x', path: 'r/card@x.json' }];
    const one = buildIndex(b, { data: '# data' }).sha;
    expect(buildIndex(b, { data: '# data 2' }).sha).not.toBe(one);
  });
});
