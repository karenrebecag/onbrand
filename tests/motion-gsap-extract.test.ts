import { describe, expect, test } from 'bun:test';
import { depsOf, parseFences } from '../scripts/motion-gsap-extract';

describe('parseFences', () => {
  test('empareja cada `### header` con su bloque fenced siguiente', () => {
    const md = '## Files\n### Comp.jsx\n```jsx\nconst a = 1;\n```\n### comp.css\n```css\n.x{color:red}\n```\n';
    const f = parseFences(md);
    expect(f).toEqual([
      { header: 'Comp.jsx', lang: 'jsx', code: 'const a = 1;' },
      { header: 'comp.css', lang: 'css', code: '.x{color:red}' },
    ]);
  });

  test('un bloque sin `###` previo (install bash, json de meta) se ignora', () => {
    const md = '### Comp.jsx\n```jsx\nx\n```\n```bash\nnpm i gsap\n```\n';
    expect(parseFences(md).map((f) => f.header)).toEqual(['Comp.jsx']);
  });
});

describe('depsOf', () => {
  test('toma solo imports reales, colapsa gsap/* y descarta react', () => {
    const code = `import { useRef } from 'react';\nimport gsap from 'gsap';\nimport { ScrollTrigger } from 'gsap/ScrollTrigger';\nimport { useGSAP } from '@gsap/react';\n`;
    expect(depsOf(code)).toEqual(['@gsap/react', 'gsap']);
  });

  test('un `from "..."` dentro de un comentario NO cuenta como dep', () => {
    const code = `import gsap from 'gsap';\n// no puede distinguir "dark because it is shadow" from "dark because it is background robe"\n`;
    expect(depsOf(code)).toEqual(['gsap']);
  });

  test('detecta three (categoría shader) como dep ajena', () => {
    const code = `import gsap from 'gsap';\nimport * as THREE from 'three';\n`;
    expect(depsOf(code)).toEqual(['gsap', 'three']);
  });
});
