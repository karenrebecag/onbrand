// Lo que el composer decidió por sección (page.json) junto al TSX que emitió el runner, para el sensor
// content.emitted. Sin page.json (un snapshot de v0) no hay nada que afirmar.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { textLeaves, type EmittedSection } from '../src/page-sensors';
import { sectionActions, type PageAction } from '../src/intent-sensors';

// El runner nombra cada sección "NN-rol.tsx" con NN = posición + 1, igual que el data-wt-slug del wrapper.
const SECTION_FILE = /^(\d{2,})-.+\.tsx$/;

export function emittedSections(dir: string): EmittedSection[] {
  const pagePath = join(dir, 'page.json');
  const sectionsDir = join(dir, 'src', 'sections');
  if (!existsSync(pagePath) || !existsSync(sectionsDir)) return [];
  const page = JSON.parse(readFileSync(pagePath, 'utf8')) as { sections?: unknown[] };
  const files = readdirSync(sectionsDir).filter((f) => SECTION_FILE.test(f));
  return (page.sections ?? []).flatMap((section, i) => {
    const file = files.find((f) => Number(SECTION_FILE.exec(f)![1]) === i + 1);
    if (!file) return [];
    return [{ key: file.replace(/\.tsx$/, ''), leaves: textLeaves(section), source: readFileSync(join(sectionsDir, file), 'utf8') }];
  });
}

/** Las acciones (texto + href) que decidió el composer, por key de sección, para el sensor cta.link. */
export function emittedActions(dir: string): PageAction[] {
  const pagePath = join(dir, 'page.json');
  const sectionsDir = join(dir, 'src', 'sections');
  if (!existsSync(pagePath) || !existsSync(sectionsDir)) return [];
  const page = JSON.parse(readFileSync(pagePath, 'utf8')) as { sections?: unknown[] };
  const files = readdirSync(sectionsDir).filter((f) => SECTION_FILE.test(f));
  return (page.sections ?? []).flatMap((section, i) => {
    const file = files.find((f) => Number(SECTION_FILE.exec(f)![1]) === i + 1);
    return file ? sectionActions(file.replace(/\.tsx$/, ''), section) : [];
  });
}
