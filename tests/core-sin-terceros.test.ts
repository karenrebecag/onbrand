import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './estandares-scan';

// Guarda B3 del ADR 0017: el core no importa SDK de terceros de una distro ni nombra a un cliente. Cada excepción lleva fecha y el PR
// mecánico que la cierra; una excepción vencida o que ya no hace falta rompe el test, así la lista solo se achica.
const DIRS = ['src', 'scripts', 'apps/builder/src'];
const TEXT = /\.(ts|tsx|js|mjs|css|txt|json)$/;
const SKIP = new Set(['node_modules', 'dist', 'build', '.git']);
const TODAY = new Date().toISOString().slice(0, 10);

// Solo lo que viaja con el core: versionado o nuevo sin ignorar (`git ls-files --cached --others --exclude-standard`). Un
// archivo ignorado (docs/research/, .env) no cuenta, así el worktree y CI (checkout limpio) ven lo mismo.
function files(dirs: readonly string[] = DIRS, text: RegExp = TEXT): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...dirs], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter((f) => f && text.test(f) && !f.split('/').some((seg) => SKIP.has(seg))).sort();
}
const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8');
const imports = (src: string): string[] => [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);

interface Exception { readonly until: string; readonly pr: string }

// El día que vence una excepción main se pone rojo de golpe: 14 días antes el test avisa por consola para que no sorprenda.
const WARN_DAYS = 14;
export const daysUntil = (until: string, today: string): number => Math.round((Date.parse(until) - Date.parse(today)) / 86_400_000);
const dueSoon = (until: string, today: string): boolean => daysUntil(until, today) <= WARN_DAYS;
function warnExpiring(exceptions: Readonly<Record<string, Exception>>, today: string): void {
  const soon = new Map<string, string[]>();
  for (const [f, e] of Object.entries(exceptions)) if (dueSoon(e.until, today)) soon.set(e.until, [...(soon.get(e.until) ?? []), f]);
  for (const [until, fs] of soon) console.warn(`core-sin-terceros: ${fs.length} excepción(es) vencen el ${until} (${daysUntil(until, today)} días): ${fs.join(', ')}`);
}

// --- Regla 1: SDK de terceros de una distro -------------------------------------------------------------------------
const SDK = /^@(clerk\/|vercel\/sandbox$|vercel\/blob$)/;
test('ningún archivo de src, scripts ni builder importa @clerk/*, @vercel/sandbox o @vercel/blob', () => {
  const code = files().filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
  expect(code.filter((f) => imports(read(f)).some((m) => SDK.test(m)))).toEqual([]);
});

test('package.json no declara @clerk/*, @vercel/sandbox ni @vercel/blob', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  expect(names.filter((n) => n.startsWith('@clerk/') || n === '@vercel/sandbox' || n === '@vercel/blob')).toEqual([]);
});

// --- Regla 2: ni runtime ni orquestador conocen los adaptadores de una distro ---------------------------------------
test('nada de src/runtime ni src/orchestrator importa un adaptador de distro (adapters/clerk, adapters/vercel-*)', () => {
  const offenders = files().filter((f) => /^src\/(runtime|orchestrator)\//.test(f) && /\.(ts|tsx)$/.test(f))
    .filter((f) => imports(read(f)).some((m) => /(?:^|\/)adapters\/(clerk|vercel-[\w-]+)(?:\/|$)/.test(m)));
  expect(offenders).toEqual([]);
});

// --- Regla 3: ningún nombre de cliente en el core -------------------------------------------------------------------
const CLIENT = /\batom\b/i;
// `@atom:<categoría>` es el placeholder de atomic design (átomo) que resuelve el compositor (ds-layout-guides), no el cliente:
// se quita antes de buscar para que la guarda no obligue a renombrar un token con comportamiento.
const namesClient = (text: string): boolean => CLIENT.test(text.replace(/@atom:/g, ''));
// GUARDA (permanente): un detector de terceros tiene que nombrar al cliente para buscarlo. Exime solo las líneas del patrón
// declarado; cualquier otra mención en el archivo falla.
const GUARDA: Readonly<Record<string, RegExp>> = {
  'scripts/e2e-core-clone.ts': /^const THIRD_PARTY = \//,
  // Esta misma guarda escribe un archivo que nombra al cliente para probar que el .gitignore lo deja fuera.
  'tests/core-sin-terceros.test.ts': /^ {2}writeFileSync\(f, 'borrador local que nombra a /,
};
const clientLines = (text: string): string[] => text.replace(/@atom:/g, '').split('\n').filter((l) => CLIENT.test(l));
const MOVER_IMAGEN: Exception = { until: '2026-12-31', pr: 'PR mecánico: cliImageGen, CLI_IMAGE_TOOL y CLI_IMAGE_MCP (el generador de un cliente) se mudan al repo de la distro detrás del puerto image' };
const NEUTRALIZAR: Exception = { until: '2026-12-15', pr: 'PR mecánico (B1) "neutralizar menciones de cliente en comentarios y ejemplos": sin cambio de cuerpos' };
const MOVER_WA: Exception = { until: '2026-12-31', pr: 'PR mecánico: wa-sdk, wa-sensors y wa-measure se mudan al repo de la distro (contrato propio de un cliente), y con ellos las líneas del SDK de tracking del prompt de ds-skill-agent' };
// El atributo de botón del SDK de WhatsApp del cliente lo emite templates/arc-scaffold/src/components/arc/button/action.tsx
// y los tests de bloques lo comprueban tal cual.
const CLIENT_EXCEPTIONS: Readonly<Record<string, Exception>> = {
  'scripts/wa-measure.ts': MOVER_WA,
  'src/ds-skill-agent.ts': MOVER_WA,
  'src/runtime/image-step.ts': MOVER_IMAGEN,
  'src/wa-sdk.ts': MOVER_WA,
  'src/wa-sensors.ts': MOVER_WA,
  'tests/wa-sdk.test.ts': MOVER_WA,
  'tests/wa-sensors.test.ts': MOVER_WA,
};
// La regla 3 cubre también tests/; las reglas 1 y 2 no, porque tests/chat-index-blob-live.test.ts importa el SDK de Blob a propósito.
const CLIENT_DIRS = [...DIRS, 'tests'];
// Archivos sueltos de la raíz que viajan con el core: no son código, así que TEXT no los cubre.
const ROOT_FILES = ['README.md', '.env.example'];
const ROOT_TEXT = /^(README\.md|\.env\.example)$/;
const clientFiles = (): string[] => [...files(CLIENT_DIRS), ...files(ROOT_FILES, ROOT_TEXT)];

warnExpiring(CLIENT_EXCEPTIONS, TODAY);

test('el aviso de vencimiento salta 14 días antes y no antes', () => {
  expect(daysUntil('2026-12-15', '2026-12-01')).toBe(14);
  expect(dueSoon('2026-12-15', '2026-12-01')).toBe(true);
  expect(dueSoon('2026-12-15', '2026-11-30')).toBe(false);
  expect(dueSoon('2026-12-15', '2027-01-01')).toBe(true);
});

test('ningún archivo nombra a un cliente fuera de las excepciones fechadas', () => {
  const named = clientFiles().filter((f) => namesClient(read(f)));
  expect(named.filter((f) => !(f in CLIENT_EXCEPTIONS) && !(f in GUARDA))).toEqual([]);
});

test('la regla 3 lee README.md y .env.example de la raíz', () => {
  expect(files(ROOT_FILES, ROOT_TEXT)).toEqual([...ROOT_FILES].sort());
});

test('cada excepción de cliente sigue nombrándolo y no ha vencido (la lista solo se achica)', () => {
  for (const [f, e] of Object.entries(CLIENT_EXCEPTIONS)) {
    expect(namesClient(read(f)), `${f} ya no nombra al cliente: quítalo de CLIENT_EXCEPTIONS`).toBe(true);
    expect(e.until >= TODAY, `${f}: excepción vencida el ${e.until} (${e.pr})`).toBe(true);
  }
  expect(Object.keys(CLIENT_EXCEPTIONS)).toHaveLength(7);
});

test('GUARDA: en cada detector de terceros la única mención del cliente es la del patrón declarado', () => {
  for (const [f, allowed] of Object.entries(GUARDA)) {
    const lines = clientLines(read(f));
    expect(lines.length, `${f} ya no nombra al cliente en su patrón: quita la GUARDA`).toBeGreaterThan(0);
    expect(lines.filter((l) => !allowed.test(l)), `${f}: mención del cliente fuera de ${allowed}`).toEqual([]);
  }
});

// --- Regla 3 en docs y fixtures (lista propia) ----------------------------------------------------------------------
// Docs y fixtures se publican con el core: un ejemplo o una spec que nombra al cliente lo ata igual que el código.
const DOC_DIRS = ['docs', 'fixtures'];
const DOC_TEXT = /\.(md|ts|tsx|js|mjs|css|txt|json)$/;
// El contenido ES la decisión de Karen citada con fecha: reescribirlo borraría la historia. Sale con el corte del repo
// público con historial limpio después del alpha (ADR 0017, decisiones del 2026-11-05).
const HISTORIA: Exception = { until: '2026-12-31', pr: 'registro fechado de decisiones de Karen que nombran a la distro: no entra al repo público con historial limpio que se corta tras el alpha' };
const MOVER_DISTRO: Exception = { until: '2026-12-31', pr: 'spec aparcada con alcance de la distro (lo dice su cabecera): se muda al repo de la distro con el tag 0.1.0' };
const DOC_EXCEPTIONS: Readonly<Record<string, Exception>> = {
  'docs/adr/0017-cableado-core-perfil.md': HISTORIA,
  'docs/archive/pendientes-relume-ranker.md': HISTORIA,
  'docs/notas/cierre-modulo-2026-11-04.md': HISTORIA,
  'docs/notas/decisiones-pendientes-2026-11-04.md': HISTORIA,
  'docs/notas/decisiones-publish-2026-11-04.md': HISTORIA,
  'docs/notas/estado-2026-11-05.md': HISTORIA,
  'docs/spec/publish-hosted.md': MOVER_DISTRO,
};

test('ningún doc ni fixture nombra a un cliente fuera de las excepciones fechadas', () => {
  const named = files(DOC_DIRS, DOC_TEXT).filter((f) => namesClient(read(f)));
  expect(named.filter((f) => !(f in DOC_EXCEPTIONS))).toEqual([]);
});

// Sin esto, un pathspec o cwd mal puestos dejarían `git ls-files` vacío y todas las reglas pasarían sin mirar nada.
const MIN_CODE_FILES = 300;
const MIN_DOC_FILES = 100;

test('la guarda ve el código y los docs del core (no es vacua)', () => {
  expect(files().length).toBeGreaterThan(MIN_CODE_FILES);
  expect(files(DOC_DIRS, DOC_TEXT).length).toBeGreaterThan(MIN_DOC_FILES);
});

test('un archivo nuevo sin commit sí cuenta para la guarda (el árbol de un par se revisa antes del commit)', () => {
  const f = join(ROOT, 'docs', 'notas', '__guarda-nuevo.md');
  writeFileSync(f, 'nota nueva sin commit\n');
  try {
    expect(files(DOC_DIRS, DOC_TEXT)).toContain('docs/notas/__guarda-nuevo.md');
  } finally {
    rmSync(f, { force: true });
  }
});

test('un archivo ignorado por git no cuenta para la guarda, aunque nombre al cliente', () => {
  // docs/research/ está en .gitignore (Karen 2026-10-21): un brief local daba rojo en el worktree y verde en CI.
  const dir = join(ROOT, 'docs', 'research');
  const f = join(dir, '__guarda-ignorado.md');
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, 'borrador local que nombra a atom\n');
  try {
    expect(files(DOC_DIRS, DOC_TEXT)).not.toContain('docs/research/__guarda-ignorado.md');
  } finally {
    rmSync(f, { force: true });
  }
});

test('cada excepción de docs sigue nombrando al cliente y no ha vencido (la lista solo se achica)', () => {
  for (const [f, e] of Object.entries(DOC_EXCEPTIONS)) {
    expect(namesClient(read(f)), `${f} ya no nombra al cliente: quítalo de DOC_EXCEPTIONS`).toBe(true);
    expect(e.until >= TODAY, `${f}: excepción vencida el ${e.until} (${e.pr})`).toBe(true);
  }
  expect(Object.keys(DOC_EXCEPTIONS)).toHaveLength(7);
});
