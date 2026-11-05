// B9 §6.4: el scaffold base no trae dependencias fuera de react, react-dom y su cadena de build (decisión de Karen
// 2026-11-05: vite, typescript, @vitejs/plugin-react y los tipos de React). Lo que pida más es de una distro.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = { dependencies: ['react', 'react-dom'], devDependencies: ['@types/react', '@types/react-dom', '@vitejs/plugin-react', 'typescript', 'vite'] };

test('el package.json de templates/base-scaffold solo declara react, react-dom y la cadena de build aprobada', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'templates', 'base-scaffold', 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  expect({ dependencies: Object.keys(pkg.dependencies ?? {}).sort(), devDependencies: Object.keys(pkg.devDependencies ?? {}).sort() }).toEqual(ALLOWED);
});
