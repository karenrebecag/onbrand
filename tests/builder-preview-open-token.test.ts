// Identidad §9 con el gate del preview encendido: toda url del preview que el builder abre tiene que llevar el token del
// latido (`urlFor`, lib/preview-access.ts), o el listener responde 401. Los iframes ya pasan por `previewSrc`
// (artboard-canvas.tsx:628,634). El botón "Abrir el preview" (canvas-chrome.tsx:36) abre `builder.previewUrl`
// (use-builder.ts:600: la url del latido o la del evento 'preview') en una pestaña nueva, sin token. Esa pestaña tampoco
// tiene la cookie: es Partitioned bajo el builder. Abre con `urlFor(previewUrl, token)` desde la entrega del fix.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeFiles, ROOT } from './estandares-scan';

// Una llamada que abre una url del preview: window.open con un argumento que nombra el preview.
const OPENS_PREVIEW = /window\.open\(\s*[^,)]*preview/i;

test('el builder no abre una url del preview sin pasarla por urlFor', () => {
  const bare = codeFiles(['apps/builder/src']).flatMap((f) =>
    readFileSync(join(ROOT, f), 'utf8').split('\n').flatMap((line, i) => (OPENS_PREVIEW.test(line) && !line.includes('urlFor(') ? [`${f}:${i + 1}`] : [])),
  );
  expect(bare).toEqual([]);
});
