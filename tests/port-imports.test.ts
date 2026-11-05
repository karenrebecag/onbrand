import { describe, expect, test } from 'bun:test';
import { ICON_TO_BRAND, ICON_TO_LUCIDE, kitImports, portImports } from '../src/catalog/port-imports';

describe('portImports — @kit/ui', () => {
  test('portea una pieza con equivalente Arc a la ruta relativa del component', () => {
    const src = `import { Button, type ButtonProps } from "@kit/ui";\nexport const X = (p: ButtonProps) => <Button {...p} />;\n`;
    const r = portImports(src);
    expect(r.tsx).toContain('import { Button, type ButtonProps } from "../../../arc/button/button";');
    expect(r.tsx).not.toContain('@kit/ui');
    expect(r.kitResidual).toEqual([]);
  });

  test('agrupa por component las piezas del mismo slug (tabs expone sub-partes en Arc)', () => {
    const src = `import { Tabs, TabsList, TabsContent } from "@kit/ui";\n`;
    const r = portImports(src);
    expect(r.tsx).toContain('import { Tabs, TabsList, TabsContent } from "../../../arc/tabs/tabs";');
  });

  test('las sub-partes que Arc NO expone (Select composicional) quedan residual', () => {
    const src = `import { Select, SelectTrigger, SelectContent } from "@kit/ui";\n`;
    const r = portImports(src);
    expect(r.tsx).toContain('import { Select } from "../../../arc/select/select";');
    expect(r.kitResidual).toEqual(['SelectContent', 'SelectTrigger']);
  });

  test('marca como residual la pieza sin equivalente Arc', () => {
    const src = `import { Button, Form } from "@kit/ui";\n`;
    const r = portImports(src);
    expect(r.kitResidual).toEqual(['Form']);
    expect(r.tsx).toContain('../../../arc/button/button');
    expect(r.tsx).toContain('TODO(@kit/ui sin equivalente Arc: Form)');
  });

  test('VideoIframe y useMediaQuery se portan al shim local, no son residual', () => {
    const src = `import { Button, VideoIframe, useMediaQuery } from "@kit/ui";\n`;
    const r = portImports(src);
    expect(r.tsx).toContain('import { Button } from "../../../arc/button/button";');
    expect(r.tsx).toContain('import { VideoIframe, useMediaQuery } from "../../../kit-shims";');
    expect(r.kitResidual).toEqual([]);
  });

  test('con arcComponents, un slug ausente del vault es residual', () => {
    const src = `import { Button } from "@kit/ui";\n`;
    const r = portImports(src, { arcComponents: new Set<string>() });
    expect(r.kitResidual).toEqual(['Button']);
  });
});

describe('portImports — react-icons', () => {
  test('mapea a lucide y renombra el uso en el JSX', () => {
    const src = `import { RxChevronRight } from "react-icons/rx";\nexport const X = () => <RxChevronRight className="c" />;\n`;
    const r = portImports(src);
    expect(r.tsx).toContain('import { ChevronRight } from "lucide-react";');
    expect(r.tsx).toContain('<ChevronRight className="c" />');
    expect(r.tsx).not.toContain('RxChevronRight');
    expect(r.tsx).not.toContain('react-icons');
    expect(r.iconResidual).toEqual([]);
  });

  test('dos iconos que caen en el mismo lucide se importan una vez', () => {
    const src = `import { BiStar, BiSolidStar } from "react-icons/bi";\nexport const X = () => <><BiStar /><BiSolidStar /></>;\n`;
    const r = portImports(src);
    expect(r.lucide).toEqual(['Star']);
    expect([...r.tsx.matchAll(/from "lucide-react"/g)]).toHaveLength(1);
  });

  test('un logo de marca va al módulo local, no a lucide', () => {
    const src = `import { BiLogoLinkedinSquare } from "react-icons/bi";\nexport const X = () => <BiLogoLinkedinSquare />;\n`;
    const r = portImports(src);
    expect(r.tsx).toContain('import { LinkedinIcon } from "../../../brand-icons";');
    expect(r.tsx).toContain('<LinkedinIcon />');
    expect(r.brand).toEqual(['LinkedinIcon']);
  });

  test('un icono fuera del mapa queda residual y marcado', () => {
    const src = `import { BiRocketZzz } from "react-icons/bi";\n`;
    const r = portImports(src);
    expect(r.iconResidual).toEqual(['BiRocketZzz']);
    expect(r.tsx).toContain('TODO(react-icons sin mapa a lucide/brand: BiRocketZzz)');
  });
});

describe('mapas', () => {
  test('todos los targets lucide/brand son nombres distintos de su fuente', () => {
    for (const [src, tgt] of Object.entries(ICON_TO_LUCIDE)) expect(src).not.toBe(tgt);
    for (const [src, tgt] of Object.entries(ICON_TO_BRAND)) expect(src).not.toBe(tgt);
  });

  test('kitImports lista las piezas @kit/ui del source', () => {
    const src = `import { Button, type ButtonProps } from "@kit/ui";\n`;
    expect(kitImports(src)).toEqual(['Button', 'ButtonProps']);
  });
});

describe('portImports — componentes solo-default', () => {
  test('un segundo valor de un módulo solo-default queda residual en vez de perderse', () => {
    const src = `import { Tabs, TabsList } from "@kit/ui";\nexport const X = () => <Tabs><TabsList /></Tabs>;\n`;
    const r = portImports(src, { defaultExports: new Set(['tabs']) });
    expect(r.tsx).toContain('import Tabs from "../../../arc/tabs/tabs";');
    expect(r.kitResidual).toEqual(['TabsList']);
    expect(r.tsx).toContain('// TODO(@kit/ui sin equivalente Arc: TabsList)');
  });

  test('el valor va como import default y el tipo sigue nombrado', () => {
    const src = `import { Button, type ButtonProps } from "@kit/ui";\nexport const X = (p: ButtonProps) => <Button {...p} />;\n`;
    const r = portImports(src, { defaultExports: new Set(['button']) });
    expect(r.tsx).toContain('import Button from "../../../arc/button/button";');
    expect(r.tsx).toContain('import { type ButtonProps } from "../../../arc/button/button";');
  });
});
