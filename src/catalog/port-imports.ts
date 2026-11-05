// Codemod de imports para portar una sección Relume del vault al scaffold Arc (spec DA1, ADR 0001).
// Dos reescrituras deterministas, nunca inventadas:
//   - `@kit/ui` -> componente Arc equivalente (KIT_TO_ARC), ruta relativa como en los lotes a mano.
//   - `react-icons` -> `lucide-react` (ICON_TO_LUCIDE) o el módulo local de logos (ICON_TO_BRAND),
//     con rename del identificador en el JSX (el nombre lucide no es el de react-icons).
// Lo que no tiene equivalente (Form/Sidebar/Table de @kit/ui, un icono fuera del mapa) se deja
// MARCADO y se devuelve como residual: el gate bloquea el item, no se sustituye por algo falso.

import { importLine } from './import-line';

/** Qué component Arc cubre cada pieza de @kit/ui, anclado a lo que Arc EXPORTA de verdad (no a la
 * paridad con shadcn). La mayoría de los components Arc son de una pieza con props, no composicionales:
 * `Select`/`Accordion`/`Carousel`/`DropdownMenu`/`Pagination`/`Breadcrumb`/`RadioGroup`/`Tooltip` no
 * exponen sub-partes, así que `SelectTrigger`, `AccordionItem`, etc. no tienen equivalente (null) y la
 * sección que los usa queda en la cola. Solo `tabs`, `dialog` y `popover` exponen las sub-partes que
 * shadcn espera. `AccordionItem` en Arc es un tipo, no el componente que @kit/ui importa: null. */
export const KIT_TO_ARC: Readonly<Record<string, string | null>> = {
  Button: 'button', ButtonProps: 'button', Input: 'input', InputProps: 'input', Textarea: 'textarea', Switch: 'switch',
  Checkbox: 'checkbox', Label: null, Select: 'select', SelectTrigger: null, SelectContent: null,
  SelectItem: null, SelectValue: null, Dialog: 'dialog', DialogTrigger: 'dialog', DialogContent: 'dialog',
  Tabs: 'tabs', TabsList: 'tabs', TabsTrigger: 'tabs', TabsContent: 'tabs', Accordion: 'accordion',
  AccordionItem: null, AccordionTrigger: null, AccordionContent: null,
  RadioGroup: 'radio-group', RadioGroupItem: null, VideoIframe: null, useMediaQuery: null,
  Carousel: 'carousel', CarouselApi: null, CarouselContent: null, CarouselItem: null,
  CarouselNext: null, CarouselPrevious: null, DropdownMenu: 'dropdown-menu', DropdownMenuContent: null,
  DropdownMenuItem: null, DropdownMenuTrigger: null, DropdownMenuLabel: null,
  DropdownMenuSeparator: null, DropdownMenuGroup: null, Popover: 'popover', PopoverContent: 'popover',
  PopoverTrigger: 'popover', Tooltip: 'tooltip', TooltipContent: null, TooltipProvider: null, TooltipTrigger: null,
  Badge: 'badge', Breadcrumb: 'breadcrumb', BreadcrumbItem: null, BreadcrumbLink: null, BreadcrumbList: null,
  BreadcrumbSeparator: null, Pagination: 'pagination', PaginationContent: null, PaginationItem: null,
  PaginationLink: null, PaginationNext: null, PaginationPrevious: null, Slider: 'slider', Calendar: 'calendar',
  Sheet: null, SheetClose: null, SheetContent: null, SheetTrigger: null, SheetFooter: null, SheetHeader: null, SheetTitle: null,
  Form: null, FormControl: null, FormField: null, FormItem: null, FormLabel: null, FormMessage: null,
  Sidebar: null, SidebarContent: null, SidebarFooter: null, SidebarHeader: null, SidebarInput: null, SidebarMenu: null,
  SidebarMenuButton: null, SidebarMenuItem: null, SidebarProvider: null, SidebarSeparator: null, SidebarTrigger: null, useSidebar: null,
  Table: null, TableBody: null, TableCell: null, TableHead: null, TableHeader: null, TableRow: null, cn: null,
};

/** react-icons -> lucide-react. Cada destino existe en el lucide-react del scaffold (verificado contra
 * su .d.ts); los renombres de lucide (Filter->Funnel, MoreHorizontal->Ellipsis, Spinner->LoaderCircle,
 * Home->House, HelpCircle->CircleQuestionMark) están resueltos aquí, no adivinados en runtime. */
export const ICON_TO_LUCIDE: Readonly<Record<string, string>> = {
  BiArchive: 'Archive', BiBarChartAlt2: 'ChartColumn', BiBath: 'Bath', BiBed: 'Bed', BiBell: 'Bell',
  BiBookOpen: 'BookOpen', BiBookmark: 'Bookmark', BiCalendarAlt: 'Calendar', BiCheck: 'Check', BiCog: 'Cog',
  BiCookie: 'Cookie', BiCreditCard: 'CreditCard', BiDotsHorizontal: 'Ellipsis', BiDotsHorizontalRounded: 'Ellipsis',
  BiDownArrowAlt: 'ArrowDown', BiEnvelope: 'Mail', BiFile: 'File', BiFilter: 'Funnel', BiHelpCircle: 'CircleQuestionMark',
  BiHome: 'House', BiLayer: 'Layers', BiLinkAlt: 'Link', BiLoader: 'Loader', BiMap: 'Map', BiMessageDetail: 'MessageSquare',
  FaArrowRight: 'ArrowRight',
  BiPhone: 'Phone', BiPieChartAlt2: 'ChartPie', BiPurchaseTag: 'Tag', BiSearch: 'Search', BiSolidStar: 'Star',
  BiSolidStarHalf: 'StarHalf', BiStar: 'Star', BiTimeFive: 'Clock', BiUpArrowAlt: 'ArrowUp', BiUser: 'User', BiX: 'X',
  CgSpinner: 'LoaderCircle', FaCirclePlay: 'CirclePlay', FaRegCalendar: 'Calendar', GoEye: 'Eye', GrReturn: 'Undo2',
  IoCloseOutline: 'X', LuListFilter: 'ListFilter', LuMapPin: 'MapPin', MdAccessTime: 'Clock',
  MdKeyboardDoubleArrowLeft: 'ChevronsLeft', MdKeyboardDoubleArrowRight: 'ChevronsRight', MdLocationOn: 'MapPin',
  MdTrendingUp: 'TrendingUp', RiQuestionLine: 'CircleQuestionMark', RxChevronDown: 'ChevronDown', RxChevronLeft: 'ChevronLeft',
  RxChevronRight: 'ChevronRight', RxChevronUp: 'ChevronUp', RxCross2: 'X', RxPlus: 'Plus',
};

/** react-icons de marca -> export del módulo local de logos. lucide eliminó los iconos de marca, así
 * que estos no tienen equivalente lucide; el glifo correcto vive en `src/components/brand-icons.tsx`
 * (SVG, sin dep nueva). Un logo sigue siendo su logo: no se sustituye por un icono genérico. */
export const ICON_TO_BRAND: Readonly<Record<string, string>> = {
  BiLogoApple: 'AppleIcon', BiLogoDribbble: 'DribbbleIcon', BiLogoFacebook: 'FacebookIcon',
  BiLogoFacebookCircle: 'FacebookCircleIcon', BiLogoGoogle: 'GoogleIcon', BiLogoInstagram: 'InstagramIcon',
  BiLogoLinkedinSquare: 'LinkedinIcon', BiLogoYoutube: 'YoutubeIcon', FaXTwitter: 'XTwitterIcon',
};

/** Piezas de @kit/ui sin equivalente Arc que se cubren con un shim local (nativo, sin dep):
 * `VideoIframe` (embed 16:9) y `useMediaQuery` (hook). El nombre no cambia en el JSX. */
export const KIT_TO_LOCAL: Readonly<Record<string, true>> = { VideoIframe: true, useMediaQuery: true };

/** Ruta relativa desde un bloque Relume (`components/relume/<cat>/<item>/`) a un component Arc.
 * Exportada: la pasada AST `deps` (RF4) reescribe los mismos imports sobre el árbol, no por texto. */
export const arcImportPath = (slug: string): string => `../../../arc/${slug}/${slug}`;
/** Ruta relativa desde un bloque Relume al módulo de logos (`components/brand-icons.tsx`). */
export const BRAND_IMPORT = '../../../brand-icons';
/** Ruta relativa desde un bloque Relume al módulo de shims (`components/kit-shims.tsx`). */
export const KIT_SHIM_IMPORT = '../../../kit-shims';
/** Specifier destino de framer-motion (ya en el scaffold como `motion`), sin instalar otra librería. */
export const MOTION_IMPORT = 'motion/react';

/** Statement de import completo (una o varias líneas) con su spec capturado. */
const IMPORT_RE = /^import\b[\s\S]*?\bfrom\s*["']([^"']+)["'];?$/gm;

/** Nombres entre llaves de un import, sin `type ` y sin alias (`X as Y` -> X). Preserva el orden. */
function namedBindings(stmt: string): { raw: string; name: string; isType: boolean }[] {
  const open = stmt.indexOf('{');
  const close = stmt.lastIndexOf('}');
  if (open < 0 || close < 0 || close < open) return [];
  return stmt.slice(open + 1, close)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const isType = /^type\s+/.test(raw);
      const name = raw.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      return { raw, name, isType };
    });
}

function portKit(stmt: string, arcComponents: ReadonlySet<string> | undefined, residual: Set<string>, defaults: ReadonlySet<string> = new Set()): string {
  // `import type { X } from "@kit/ui"` marca TODO el statement como tipo; preservarlo o esbuild
  // intentaría importar un tipo como valor y el build fallaría al no hallar el export.
  const typeOnly = /^import\s+type\b/.test(stmt.trimStart());
  const bySlug = new Map<string, string[]>();
  const local: string[] = [];
  const unmapped: string[] = [];
  for (const { name, isType } of namedBindings(stmt)) {
    if (KIT_TO_LOCAL[name]) { local.push(name); continue; }
    const slug = KIT_TO_ARC[name];
    const present = slug != null && (!arcComponents || arcComponents.has(slug));
    // Los `*Props` de Arc son interfaces (export type): se importan como tipo aunque el source los
    // traiga en un import de valores, o rolldown falla con MISSING_EXPORT.
    const asType = typeOnly || isType || /Props$/.test(name);
    if (present) bySlug.set(slug, [...(bySlug.get(slug) ?? []), `${asType ? 'type ' : ''}${name}`]);
    else { unmapped.push(name); residual.add(name); }
  }
  const lines = [...bySlug.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([slug, names]) => {
      if (!defaults.has(slug)) return [`import { ${names.join(', ')} } from "${arcImportPath(slug)}";`];
      // Un componente solo-default: el valor va sin llaves y los tipos siguen siendo exports nombrados.
      // Un módulo default exporta un solo valor: un segundo (`ToastAction`) no existe y queda residual.
      const [value, ...extra] = names.filter((n) => !n.startsWith('type '));
      for (const n of extra) { unmapped.push(n); residual.add(n); }
      const types = names.filter((n) => n.startsWith('type '));
      return [
        ...(value ? [importLine({ export: value, importPath: arcImportPath(slug), exportDefault: true }, '"')] : []),
        ...(types.length ? [`import { ${types.join(', ')} } from "${arcImportPath(slug)}";`] : []),
      ];
    });
  if (local.length) lines.push(`import { ${local.sort().join(', ')} } from "${KIT_SHIM_IMPORT}";`);
  if (unmapped.length) lines.push(`// TODO(@kit/ui sin equivalente Arc: ${unmapped.join(', ')})`);
  return lines.join('\n');
}

function portIconsStmt(
  stmt: string,
  renames: Map<string, string>,
  lucide: Set<string>,
  brand: Set<string>,
  residual: Set<string>,
): string {
  const unmapped: string[] = [];
  for (const { name } of namedBindings(stmt)) {
    const luc = ICON_TO_LUCIDE[name];
    const brd = ICON_TO_BRAND[name];
    if (luc) { renames.set(name, luc); lucide.add(luc); }
    else if (brd) { renames.set(name, brd); brand.add(brd); }
    else { unmapped.push(name); residual.add(name); }
  }
  // Todos mapeados: el statement se va (el import consolidado lo reemplaza). Si algo no mapea, se
  // deja marcado con los nombres sin mapa para la revisión (el gate ya bloquea el item).
  return unmapped.length ? `// TODO(react-icons sin mapa a lucide/brand: ${unmapped.join(', ')})` : '';
}

/** Inserta un bloque de imports tras el último import (incluidos los que quedaron como TODO). */
function insertAfterImports(tsx: string, block: string): string {
  const importLines = [...tsx.matchAll(/^(\/\/ TODO[^\n]*\n)?import\b[^\n]*$/gm)];
  const last = importLines.at(-1);
  const at = last ? (last.index ?? 0) + last[0].length + 1 : 0;
  return `${tsx.slice(0, at)}${block}\n${tsx.slice(at)}`;
}

export interface PortResult {
  tsx: string;
  /** Piezas @kit/ui sin component Arc (o ausente en el vault): bloquean el gate. */
  kitResidual: string[];
  /** Iconos react-icons fuera de los mapas: bloquean el gate. */
  iconResidual: string[];
  lucide: string[];
  brand: string[];
}

/** Portea los imports de una sección Relume. Con `arcComponents` el porte de @kit/ui comprueba que el
 * component esté en el vault; sin él (p. ej. un sample ya gate-ok) asume presente. */
export function portImports(tsx: string, opts: { arcComponents?: ReadonlySet<string>; defaultExports?: ReadonlySet<string> } = {}): PortResult {
  const kitResidual = new Set<string>();
  const iconResidual = new Set<string>();
  const renames = new Map<string, string>();
  const lucide = new Set<string>();
  const brand = new Set<string>();

  let out = tsx.replace(IMPORT_RE, (stmt, spec: string) => {
    if (spec === '@kit/ui') return portKit(stmt, opts.arcComponents, kitResidual, opts.defaultExports);
    if (spec === 'react-icons' || spec.startsWith('react-icons/')) return portIconsStmt(stmt, renames, lucide, brand, iconResidual);
    // framer-motion es el predecesor de `motion` (ya en el scaffold): mismo API en `motion/react`, se
    // reescribe el specifier en vez de instalar una segunda librería de animación.
    if (spec === 'framer-motion') return stmt.replace(/(['"])framer-motion\1/, '"motion/react"');
    return stmt;
  });

  for (const [src, tgt] of renames) out = out.replace(new RegExp(`\\b${src}\\b`, 'g'), tgt);

  const inject: string[] = [];
  if (lucide.size) inject.push(`import { ${[...lucide].sort().join(', ')} } from "lucide-react";`);
  if (brand.size) inject.push(`import { ${[...brand].sort().join(', ')} } from "${BRAND_IMPORT}";`);
  if (inject.length) out = insertAfterImports(out, inject.join('\n'));

  return {
    tsx: out,
    kitResidual: [...kitResidual].sort(),
    iconResidual: [...iconResidual].sort(),
    lucide: [...lucide].sort(),
    brand: [...brand].sort(),
  };
}

/** `import { Button, type ButtonProps } from "@kit/ui"` -> ["Button", "ButtonProps"]. Se mantiene
 * para el reporte del ingest (qué piezas @kit/ui trae cada item). */
export function kitImports(tsx: string): string[] {
  const names = [...tsx.matchAll(IMPORT_RE)]
    .filter((m) => m[1] === '@kit/ui')
    .flatMap((m) => namedBindings(m[0]).map((b) => b.name));
  return [...new Set(names)].sort();
}
