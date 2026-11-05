# Ingest del catálogo React del vault

Generado por `bun scripts/catalog-ingest.ts`. Duración: 0.3 s. Fuente: vault READ-ONLY (ui-react/blocks, ui-react/components, sections-react; sections-webflow se salta).

Qué significa cada cosa: **indexed** = entrada nueva en `catalog/index.json` con `verified:false`, `source:null` y `gate`; el source se trae on-demand con `catalog fetch`. **gate ok** = pasa el gate automático (existe, exporta, deps resolubles, lint, sin residuos bloqueantes del transformer): listo para fetch + build. `verified:true` sigue exigiendo source vendorizado y render visto (schema RF5/CA3), por eso el ingest nunca lo escribe.

## Totales

| library | escaneados | indexed | curated | unmapped | component | duplicate |
| --- | --- | --- | --- | --- | --- | --- |
| arc | 241 | 73 | 18 | 0 | 150 | 0 |
| relume | 1524 | 821 | 21 | 681 | 0 | 1 |

## Por rol

| rol | arc indexados | relume indexados | ya curados |
| --- | --- | --- | --- |
| hero | 0 (gate ok 0) | 98 (gate ok 96) | 6 |
| features | 32 (gate ok 32) | 484 (gate ok 479) | 6 |
| steps | 0 (gate ok 0) | 0 (gate ok 0) | 1 |
| cta | 0 (gate ok 0) | 50 (gate ok 50) | 7 |
| testimonials | 0 (gate ok 0) | 39 (gate ok 17) | 3 |
| pricing | 2 (gate ok 2) | 26 (gate ok 24) | 2 |
| faq | 0 (gate ok 0) | 13 (gate ok 4) | 2 |
| logos | 0 (gate ok 0) | 5 (gate ok 5) | 2 |
| stats | 0 (gate ok 0) | 59 (gate ok 54) | 2 |
| navbar | 0 (gate ok 0) | 21 (gate ok 16) | 2 |
| footer | 0 (gate ok 0) | 16 (gate ok 16) | 2 |
| banner | 0 (gate ok 0) | 10 (gate ok 10) | 0 |

## Cola de revisión (por motivo)

Items indexados con gate en rojo: 50. Un item puede estar en varios motivos.

- **@kit/ui no portable (sin equivalente Arc o dep del component ausente)** (29): section_faq1, section_faq10, section_faq11, section_faq2, section_faq3, section_faq4, section_faq5, section_faq6, navbar22_component, section_testimonial10, section_testimonial11, section_testimonial12, section_testimonial15, section_testimonial16, section_testimonial19, section_testimonial20, section_testimonial23, section_testimonial24, section_testimonial27, section_testimonial28, section_testimonial30, section_testimonial31, section_testimonial40, section_testimonial41, section_testimonial42, section_testimonial43, section_testimonial7, section_testimonial8, section_testimonial9
- **transformer** (27): section_faq3, section_faq6, section_faq8, section_layout281, section_layout28, section_layout123, section_layout434, section_layout219, section_header11, section_header138, navbar14_component, navbar5_component, navbar6_component, navbar8_component, section_pricing22, section_pricing27, section_stats23, section_stats24, section_stats41, section_stats42, section_stats53, section_testimonial20, section_testimonial24, section_testimonial28, section_testimonial31, section_testimonial36, section_testimonial37
- **lint** (2): section_testimonial36, section_testimonial37

## Deps que salieron

### Deps npm ausentes en el scaffold (FLAG, no se instalan)

| paquete | items |
| --- | --- |
| framer-motion | 133 |
| @hookform/resolvers | 63 |
| react-hook-form | 63 |
| zod | 63 |
| luxon | 28 |
| embla-carousel-autoplay | 9 |
| tailwind-merge | 7 |

### react-icons portados (a lucide-react / módulo local de logos)

El codemod mapea cada icono a su equivalente lucide o al módulo de logos; ya no bloquean el gate. Un icono fuera del mapa iría a la cola con su propio motivo.

| paquete | items |
| --- | --- |
| react-icons/rx | 683 |
| react-icons/bi | 370 |
| react-icons/fa6 | 221 |
| react-icons/cg | 82 |
| react-icons/md | 82 |
| react-icons/gr | 23 |
| react-icons/lu | 19 |
| react-icons/io5 | 6 |
| react-icons/go | 4 |
| react-icons/ri | 4 |

### @kit/ui (Relume) y su equivalente en el scaffold Arc

Conteo sobre TODO lo escaneado (indexado o no). "Portar el uso" = reescribir el JSX contra el component Arc; el paquete @kit/ui nunca se instala.

| @kit/ui | items | equivalente |
| --- | --- | --- |
| Button | 1206 | Arc `button` (portar el uso) |
| ButtonProps | 1131 | Arc `button` (portar el uso) |
| Input | 278 | Arc `input` (portar el uso) |
| Dialog | 168 | Arc `dialog` (portar el uso) |
| DialogContent | 168 | Arc `dialog` (portar el uso) |
| DialogTrigger | 168 | Arc `dialog` (portar el uso) |
| Select | 111 | Arc `select` (portar el uso) |
| SelectContent | 111 | sin equivalente Arc |
| SelectTrigger | 111 | sin equivalente Arc |
| SelectItem | 110 | sin equivalente Arc |
| SelectValue | 105 | sin equivalente Arc |
| Tabs | 87 | Arc `tabs` (portar el uso) |
| TabsList | 87 | Arc `tabs` (portar el uso) |
| TabsTrigger | 87 | Arc `tabs` (portar el uso) |
| TabsContent | 83 | Arc `tabs` (portar el uso) |
| Label | 71 | sin equivalente Arc |
| Carousel | 65 | Arc `carousel` (portar el uso) |
| CarouselApi | 65 | sin equivalente Arc |
| CarouselContent | 65 | sin equivalente Arc |
| CarouselItem | 65 | sin equivalente Arc |
| Form | 63 | sin equivalente Arc |
| FormControl | 63 | sin equivalente Arc |
| FormField | 63 | sin equivalente Arc |
| FormItem | 63 | sin equivalente Arc |
| FormMessage | 63 | sin equivalente Arc |
| CarouselNext | 62 | sin equivalente Arc |
| CarouselPrevious | 62 | sin equivalente Arc |
| DropdownMenu | 61 | Arc `dropdown-menu` (portar el uso) |
| DropdownMenuContent | 61 | sin equivalente Arc |
| DropdownMenuItem | 61 | sin equivalente Arc |
| DropdownMenuTrigger | 61 | sin equivalente Arc |
| useMediaQuery | 61 | sin equivalente Arc |
| VideoIframe | 50 | sin equivalente Arc |
| Accordion | 40 | Arc `accordion` (portar el uso) |
| AccordionContent | 40 | sin equivalente Arc |
| AccordionItem | 40 | sin equivalente Arc |
| AccordionTrigger | 40 | sin equivalente Arc |
| FormLabel | 40 | sin equivalente Arc |
| Checkbox | 33 | Arc `checkbox` (portar el uso) |
| Calendar | 23 | Arc `calendar` (portar el uso) |
| cn | 23 | sin equivalente Arc |
| DropdownMenuLabel | 23 | sin equivalente Arc |
| DropdownMenuSeparator | 23 | sin equivalente Arc |
| Popover | 23 | Arc `popover` (portar el uso) |
| PopoverContent | 23 | Arc `popover` (portar el uso) |
| PopoverTrigger | 23 | Arc `popover` (portar el uso) |
| Textarea | 23 | Arc `textarea` (portar el uso) |
| Breadcrumb | 21 | Arc `breadcrumb` (portar el uso) |
| BreadcrumbItem | 21 | sin equivalente Arc |
| BreadcrumbLink | 21 | sin equivalente Arc |
| BreadcrumbList | 21 | sin equivalente Arc |
| BreadcrumbSeparator | 21 | sin equivalente Arc |
| Badge | 19 | Arc `badge` (portar el uso) |
| Sidebar | 19 | sin equivalente Arc |
| SidebarContent | 19 | sin equivalente Arc |
| SidebarFooter | 19 | sin equivalente Arc |
| SidebarMenu | 19 | sin equivalente Arc |
| SidebarMenuButton | 19 | sin equivalente Arc |
| SidebarMenuItem | 19 | sin equivalente Arc |
| SidebarProvider | 19 | sin equivalente Arc |
| SidebarTrigger | 19 | sin equivalente Arc |
| DropdownMenuGroup | 16 | sin equivalente Arc |
| RadioGroup | 16 | Arc `radio-group` (portar el uso) |
| RadioGroupItem | 16 | sin equivalente Arc |
| SidebarHeader | 14 | sin equivalente Arc |
| Switch | 11 | Arc `switch` (portar el uso) |
| Sheet | 10 | sin equivalente Arc |
| SheetClose | 10 | sin equivalente Arc |
| SheetContent | 10 | sin equivalente Arc |
| SheetTrigger | 10 | sin equivalente Arc |
| SidebarInput | 10 | sin equivalente Arc |
| Table | 10 | sin equivalente Arc |
| TableBody | 10 | sin equivalente Arc |
| TableHead | 10 | sin equivalente Arc |
| TableHeader | 10 | sin equivalente Arc |
| TableRow | 10 | sin equivalente Arc |
| TableCell | 9 | sin equivalente Arc |
| Pagination | 8 | Arc `pagination` (portar el uso) |
| PaginationContent | 8 | sin equivalente Arc |
| PaginationItem | 8 | sin equivalente Arc |
| PaginationLink | 8 | sin equivalente Arc |
| PaginationNext | 8 | sin equivalente Arc |
| PaginationPrevious | 8 | sin equivalente Arc |
| SidebarSeparator | 7 | sin equivalente Arc |
| SheetFooter | 5 | sin equivalente Arc |
| SheetHeader | 5 | sin equivalente Arc |
| SheetTitle | 5 | sin equivalente Arc |
| Slider | 5 | Arc `slider` (portar el uso) |
| Tooltip | 4 | Arc `tooltip` (portar el uso) |
| TooltipContent | 4 | sin equivalente Arc |
| TooltipProvider | 4 | sin equivalente Arc |
| TooltipTrigger | 4 | sin equivalente Arc |
| InputProps | 3 | Arc `input` (portar el uso) |
| useSidebar | 3 | sin equivalente Arc |

## Rol sin mapear (no indexado)

### Relume: categorías sin rol en el core

| categoría | items |
| --- | --- |
| multi-step-forms | 46 |
| event-sections | 37 |
| uncommon-components-2 | 37 |
| blog-sections | 36 |
| long-form-content-sections | 32 |
| contact-sections | 30 |
| uncommon-components | 30 |
| career-sections | 27 |
| header-sections | 27 |
| gallery-sections | 26 |
| forms | 20 |
| team-sections | 20 |
| timelines | 20 |
| onboarding-forms | 17 |
| portfolio-sections | 17 |
| signup-login-pages | 17 |
| blog-headers | 16 |
| blog-headers-2 | 16 |
| links-pages | 16 |
| application-shells | 15 |
| comparison-sections | 15 |
| uncommon-components-part-3 | 15 |
| portfolio-headers | 12 |
| product-list-sections | 12 |
| event-item-headers | 11 |
| grid-lists | 10 |
| stacked-lists | 10 |
| tables | 10 |
| product-headers | 9 |
| sidebars | 9 |
| stat-cards | 8 |
| category-filters | 6 |
| contact-modals | 6 |
| event-headers | 6 |
| blog-post-headers | 5 |
| cookies | 5 |
| loaders | 5 |
| page-headers | 5 |
| sign-up-log-in-modals | 5 |
| description-lists | 4 |
| section-headers | 4 |
| topbars | 4 |
| card-headers | 2 |
| uncommon-components-timeline | 1 |

### Arc: bloques de app-UI sin rol (candidatos a inner cuando exista un slot que los admita)

ninguno

## Components Arc (inventario)

Components Arc escaneados: 150; indexados (kind component, sin rol) 147. Fuera los no instalables con el scaffold: deps npm o cierre de imports.

| component | motivo |
| --- | --- |
| breadcrumb | lib renombrada en el vault: uikit-provider (el scaffold la tiene como arc-provider) |
| lightbox-gallery | lib renombrada en el vault: uikit-provider (el scaffold la tiene como arc-provider) |
| share-access | lib renombrada en el vault: uikit-provider (el scaffold la tiene como arc-provider) |

## Ya curados a mano (no se tocan)

section_cta13 (índice: cta13_block), section_cta23 (índice: section_cta23), section_cta3 (índice: cta3_shell), section_cta40 (índice: section_cta40), section_faq7 (índice: faq7_shell), section_layout237 (índice: section_layout237), section_layout253 (índice: layout253_block), section_layout255 (índice: layout255_shell), section_layout122 (índice: section_layout122), footer1_component (índice: footer1_component), section_header1 (índice: header1_shell), section_header19 (índice: section_header19), section_header30 (índice: header30_shell), section_header37 (índice: section_header37), section_logo1 (índice: section_logo1), navbar13_component (índice: navbar13_component), section_pricing10 (índice: pricing10_block), section_stats10 (índice: section_stats10), section_testimonial3 (índice: testimonial3_block), section_testimonial39 (índice: section_testimonial39), section_timeline10 (índice: section_timeline10), contact-section (índice: contact-section), cta-section (índice: cta-section), faq-section (índice: faq-section), feature-bento (índice: feature-bento), hero-section (índice: hero-section), hero-signup (índice: hero-signup), logo-marquee (índice: logo-marquee), newsletter-signup (índice: newsletter-signup), plan-comparison (índice: plan-comparison), scroll-story (índice: scroll-story), site-footer (índice: site-footer), site-header (índice: site-header), spotlight-grid (índice: spotlight-grid), stats-band (índice: stats-band), testimonial-stage (índice: testimonial-stage), theme-switch-eclipse (índice: theme-switch), theme-switch-rise (índice: theme-switch), theme-switch-split (índice: theme-switch)

## Roles sin RoleCopy

logos, banner: sin contrato en `src/copy.ts`; un item de ese rol no puede portar copy aunque pase el gate. No se escribe aquí (decisión de copy).

## Slugs repetidos en el vault (se indexa el primero)

application-shell6 (application-shells)

## Build de muestra

Un item por rol y librería, construido con vite en una copia del scaffold (/var/folders/js/qbhmlm1d5jl8xqv83ncpf_hw0000gn/T/wt-ingest-sample); nada se vendorizó en el repo. 13/13 builds verdes.
Arc: fetch real desde el vault + build. Relume: transformer sobre el source leído del vault + build; el codemod porta @kit/ui -> component Arc y react-icons -> lucide/brand, así que el build valida CSS module, JSX reescrito y el mapeo resuelto contra el scaffold. Los deps que el scaffold no instala quedan como TODO.

| rol | library | slug | gate | build | detalle |
| --- | --- | --- | --- | --- | --- |
| features | arc | comparison-table | ok | ok | vite build ok |
| pricing | arc | pricing-calculator | ok | ok | vite build ok |
| hero | relume | section_header10 | ok | ok | vite build ok; sin resolver por Tailwind (1): rb-4; imports marcados (0): - |
| features | relume | section_layout1 | ok | ok | vite build ok; sin resolver por Tailwind (1): rb-5; imports marcados (0): - |
| cta | relume | section_cta1 | ok | ok | vite build ok; sin resolver por Tailwind (1): rb-5; imports marcados (0): - |
| testimonials | relume | section_testimonial1 | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
| pricing | relume | section_pricing1 | ok | ok | vite build ok; sin resolver por Tailwind (1): rb-5; imports marcados (0): - |
| faq | relume | section_faq12 | ok | ok | vite build ok; sin resolver por Tailwind (2): rb-12, rb-5; imports marcados (0): - |
| logos | relume | section_logo2 | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
| stats | relume | section_stats1 | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
| navbar | relume | navbar1_component | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
| footer | relume | footer10_component | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
| banner | relume | banner1_component | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |

