import { describe, expect, test } from 'bun:test';
import { agentSystemPrompt, agentUserPrompt } from '../src/runtime/agent-prompt';

const base = { skillDir: '.wt/skill', hasBrowser: true, followUp: false };

describe('agent-prompt', () => {
  test('con WhatsApp en los hechos, la regla de botones usa ese número y no el de ejemplo', () => {
    const real = agentSystemPrompt({ ...base, brand: { name: 'Acme', facts: { whatsapp: '+5215555550100' } } });
    expect(real).toContain('https://wa.me/5215555550100?text=');
    expect(real).not.toContain('5215500000000');
    expect(agentSystemPrompt(base)).toContain('https://wa.me/5215500000000?text=');
  });

  test('las instrucciones de la marca van antes que las de la persona y solo con marca', () => {
    const p = agentSystemPrompt({ ...base, brand: { name: 'Acme', instructions: ['tutea'] }, instructions: ['usa usted'] });
    const brand = p.indexOf('INSTRUCCIONES DE LA MARCA Acme');
    expect(brand).toBeGreaterThan(-1);
    expect(p.indexOf('1. tutea')).toBeGreaterThan(brand);
    expect(p.indexOf('INSTRUCCIONES DE LA PERSONA')).toBeGreaterThan(p.indexOf('1. tutea'));
    expect(agentSystemPrompt({ ...base, brand: { name: 'Acme' }, instructions: ['usa usted'] })).not.toContain('INSTRUCCIONES DE LA MARCA');
    expect(agentSystemPrompt({ ...base, instructions: ['usa usted'] })).not.toContain('INSTRUCCIONES DE LA MARCA');
  });

  test('página nueva: orden skill → starter → secciones → verificación, reglas de contenido y browser obligatorio', () => {
    const p = agentSystemPrompt(base);
    expect(p.indexOf('MODO PÁGINA NUEVA')).toBeLessThan(p.indexOf('SECCIONES'));
    // Spec plan-de-pagina-artefacto: el plan va después de la identidad y antes de las secciones; el código lo obedece.
    expect(p.indexOf('IDENTIDAD')).toBeLessThan(p.indexOf('PLAN DE PÁGINA'));
    expect(p.indexOf('PLAN DE PÁGINA')).toBeLessThan(p.indexOf('SECCIONES'));
    for (const rule of ['`page-plan.md`', 'justo después de `src/identity.css`', '`## NN-<rol> · #<ancla>`', '- titular:', '- conteo:', '- focal:', '- detalle:', '- superficie:', '- inventado:', 'El código obedece al plan', 'edita el plan primero']) expect(p).toContain(rule);
    expect(p).toContain('nunca encima del titular');
    expect(p.indexOf('SECCIONES')).toBeLessThan(p.indexOf('CONTENIDO'));
    expect(p.indexOf('CONTENIDO')).toBeLessThan(p.indexOf('VERIFICACIÓN'));
    expect(p.indexOf('VERIFICACIÓN')).toBeLessThan(p.indexOf('RESUMEN FINAL'));
    for (const rule of ['.wt/skill/SKILL.md', 'src/sections/NN-<rol>.tsx', 'data-wt-role', 'wa.me', 'UNA sola sección', 'Nunca lorem', 'La tool `browser` es a pedido', '`question` concreta', 'No devuelve imágenes', 'Desborde horizontal', 'no hace falta `bunx vite build`', 'no repitas las capturas para confirmar', 'Datos de ejemplo', 'Pendiente']) expect(p).toContain(rule);
    // Fuera de SKILL.md, el prompt no fija rutas internas del skill: su forma la decide el skill (plantilla Carbon).
    expect(p.match(/`[^`]*(foundations|references)\/[^`]*`/g) ?? []).toEqual([]);
    // Lo que es del DS vive en el skill: el prompt remite a sus secciones y no lista el starter ni repite reglas de forma.
    for (const sec of ['El starter ya está montado', 'Reglas de siempre', 'Reglas duras', 'Revisión final']) expect(p).toContain(sec);
    expect(p).not.toContain('src/main.tsx');
    expect(p).not.toContain('nunca edites');
    expect(p).toContain('No hay imagen generada');
    expect(p).toContain('Sin pack de marca');
    // Sin marca: una sola declaración de identidad antes de escribir, con las superficies del contrato, y en el resumen.
    expect(p.indexOf('IDENTIDAD')).toBeLessThan(p.indexOf('SECCIONES'));
    expect(p).not.toContain('PRIMER mensaje de texto');
    // live5/live6: sonnet no emite texto antes de escribir; la declaración es identity.css + el punto 0 del resumen.
    // demo cc7b8016: 3 Bash denegados (cd + `..`, varias órdenes, heredoc) y 1 en el follow-up (node -e); el prompt nombra cada forma.
    expect(p).toContain('5. "Siguientes pasos"');
    // gen Karen 999ea0e0 (QA Front): los chips salían en voz del agente ("Pídeme el menú móvil…") y se envían como mensaje de la persona.
    for (const rule of ['como el pedido que la persona te mandaría tal cual, en imperativo', '"Agrega un menú móvil al navbar"', 'nunca en tu voz ("Pídeme…"']) expect(p).toContain(rule);
    // El resumen de 999ea0e0 midió 2.804 caracteres: el prompt lo acota.
    expect(p).toContain('no más de 15 líneas en total');
    for (const rule of ['una sola orden por llamada', 'sin `cd`, `;`, `&&` ni `|`', 'sin `node -e` ni `python3`', 'sin `..`', 'renombra con `mv`', 'repite la tarea con Read, Write o Edit']) expect(p).toContain(rule);
    // QA 3c12e988 (pin 5d265553): un Edit falló con `../../../../../../<sesión>/...`; la regla de rutas cubre también Read/Write/Edit.
    expect(p).toContain('En Read, Write y Edit la ruta es absoluta dentro del workspace o relativa a su raíz, nunca con `..`');
    for (const rule of ['sin heredoc', 'No pongas `background` en el `<section>`', 'data-wt-surface', 'base | muted | raised | inverse', 'data-theme="dark"', '0. "Identidad"']) expect(p).toContain(rule);
  });

  // gen Karen 999ea0e0: con imagen y cero fotos fuera del hero; con la tool el plan exige al menos una sección con focal
  // imagen, y sin ella no se pide una foto que nada va a generar.
  test('la sección con focal imagen además del hero solo se pide con la tool de imagen', () => {
    expect(agentSystemPrompt({ ...base, imageTool: true })).toContain('al menos una sección de contenido además del hero lleva `focal: imagen`');
    expect(agentSystemPrompt(base)).not.toContain('focal: imagen`');
  });

  test('los hechos del pack entran como DATOS REALES y quedan fuera de ejemplo e inventado', () => {
    const p = agentSystemPrompt({ ...base, brand: { name: 'Zed', facts: { domain: 'zed.io', whatsapp: '+5215512345678' } } });
    expect(p.indexOf('DATOS REALES DE LA MARCA')).toBeLessThan(p.indexOf('PLAN DE PÁGINA'));
    for (const rule of ['- Dominio: zed.io', 'wa.me/5215512345678', 'no van en "Datos de ejemplo" ni en `inventado:`', 'sigue siendo inventado y se declara']) expect(p).toContain(rule);
    expect(agentSystemPrompt({ ...base, brand: { name: 'Zed' } })).not.toContain('DATOS REALES');
  });

  test('con dirección, el prompt manda leer direction.md antes del plan y citarla en la cabecera', () => {
    const p = agentSystemPrompt({ ...base, direction: { id: 'premium-sobrio' } });
    expect(p.indexOf('DIRECCIÓN')).toBeLessThan(p.indexOf('PLAN DE PÁGINA'));
    for (const rule of ['.wt/skill/references/direction.md', 'dirección "premium-sobrio"', '`direccion: premium-sobrio`', '`- forma:`']) expect(p).toContain(rule);
    expect(agentSystemPrompt(base)).not.toContain('DIRECCIÓN');
  });

  // Karen 2026-10-30 "vamos como v0": solo el follow-up que pide reemplazar un contenido sin traerlo pregunta; T1 rellena.
  test('el follow-up pregunta por el valor que falta; la página nueva sigue inventando datos verosímiles', () => {
    expect(agentSystemPrompt({ ...base, followUp: true })).toMatch(/no trae el valor nuevo[^]*no lo inventes: no escribas ningún archivo: llama a la tool `ask_user` con UNA pregunta/);
    expect(agentSystemPrompt({ ...base, followUp: true, hasBrowser: false })).toMatch(/no escribas ningún archivo: cierra con UNA pregunta y el apartado "Siguientes pasos"/);
    const t1 = agentSystemPrompt({ ...base, followUp: false });
    expect(t1).not.toContain('no trae el valor nuevo');
    expect(t1).toContain('Inventa datos verosímiles');
  });

  // QA d62b35cb F1c: "Agrega en el hero un mockup de chat" reemplazó la foto pedida en T1.
  test('en follow-up, agregar suma sin quitar lo del plan', () => {
    const fu = agentSystemPrompt({ ...base, followUp: true });
    expect(fu).toMatch(/Agregar \("agrega"[^]*se queda\. Si el mensaje pide reemplazar/);
    expect(agentSystemPrompt({ ...base, followUp: false })).not.toContain('Agregar ("agrega"');
  });

  test('con marca o en follow-up no hay bloque IDENTIDAD', () => {
    expect(agentSystemPrompt({ ...base, brand: { name: 'Acme' } })).not.toContain('IDENTIDAD');
    expect(agentSystemPrompt({ ...base, followUp: true })).not.toContain('IDENTIDAD');
  });

  // A1 (como los extracts, Karen 2026-10-30): el cambio global de color/tipo/radio va solo en identity.css, como el
  // `:root` único de Lovable/Make; no por sección ni reasignando rol de token (el por-elemento de v0 es lo que no queremos).
  test('el cambio global de identidad manda editar solo src/identity.css, sin tocar secciones', () => {
    for (const p of [
      agentSystemPrompt({ ...base, followUp: true }),
      agentSystemPrompt({ ...base, followUp: true, brand: { name: 'Acme' } }),
      agentSystemPrompt(base),
    ]) {
      expect(p).toContain('Cambio global de identidad');
      expect(p).toContain('SOLO en `src/identity.css`');
      expect(p).toContain('No toques las secciones ni reasignes qué token usa una sección');
    }
    // Con pack ya no es un "no lo toques" absoluto: la vía legítima del cambio global son los tokens del pack en identity.css.
    const conPack = agentSystemPrompt({ ...base, followUp: true, brand: { name: 'Acme' } });
    expect(conPack).not.toContain('ya trae sus tokens, no lo toques.');
    expect(conPack).toContain('solo el cambio global de identidad de abajo los edita');
  });

  // Palanca D (AUDIT-COSTO, solo Parte 1): con skillPreload el bloque fijo va embebido y no se instruye leer SKILL.md,
  // pero NO se prohíbe leer la fuente de los componentes (prohibirlo hizo que el agente reinventara componentes, bench
  // 2026-10-30). Sin skillPreload, el prompt queda igual que antes.
  test('con skillPreload embebe el skill y no manda releerlo; sin él, comportamiento viejo', () => {
    const on = agentSystemPrompt({ ...base, skillPreload: '### .wt/skill/SKILL.md\ncontenido del skill' });
    expect(on).toContain('SKILL PRECARGADO');
    expect(on).toContain('contenido del skill');
    expect(on).toContain('NO lo releas con Read');
    expect(on).not.toContain('lee `.wt/skill/SKILL.md`');
    // No prohíbe leer la fuente de componentes (Parte 2 descartada por el bench).
    expect(on).not.toContain('No leas el código fuente');
    // Sin skillPreload: comportamiento viejo intacto (sigue mandando leer SKILL.md, sin bloque embebido).
    const off = agentSystemPrompt(base);
    expect(off).not.toContain('SKILL PRECARGADO');
    expect(off).toContain('lee `.wt/skill/SKILL.md`');
  });

  test('sin browser pide tsc y build por bash y manda declarar las capturas como pendientes', () => {
    const p = agentSystemPrompt({ ...base, hasBrowser: false });
    expect(p).toContain('bunx tsc --noEmit');
    expect(p).toContain('No tienes navegador');
    expect(p).not.toContain('"viewport": 1440');
  });

  test('adjuntos, marca con logo y follow-up entran como datos del mensaje', () => {
    const p = agentSystemPrompt({ ...base, followUp: true, attachments: [{ path: '/images/a.png', name: 'a.png', width: 800, height: 600 }], brand: { name: 'Acme', logoSrc: '/brand/logo.svg' } });
    expect(p).toContain('MODO FOLLOW-UP');
    expect(p).toContain('Lee el plan primero');
    expect(p).not.toContain('justo después de `src/identity.css`');
    expect(p).not.toContain('MODO PÁGINA NUEVA');
    expect(p).toContain('`/images/a.png` (800x600)');
    expect(p).toContain('La marca es "Acme"');
    expect(p).toContain('public/brand/logo.svg');
    expect(agentUserPrompt('cambia el título', [{ path: '/images/a.png', name: 'a.png' }])).toBe('cambia el título\n\nAdjuntos de este mensaje (ya en public/images): a.png → `/images/a.png`');
    expect(agentUserPrompt('hola')).toBe('hola');
  });

  // T1 56644d79 (viabilidad/qa.md): App escrito antes que las secciones dio 18 full-reloads y nada montado hasta el footer.
  test('index.html una vez antes de las secciones; en el follow-up App crece sección por sección con WtSection', () => {
    const p = agentSystemPrompt(base);
    expect(p).toContain('nunca con `import` de un asset');
    expect(p).toContain('`index.html`, una sola vez y antes de App y de las secciones');
    const f = agentSystemPrompt({ ...base, followUp: true });
    expect(f).not.toContain('una sola vez y antes de App');
    expect(f).toContain('recién cuando su archivo existe');
    expect(f).toContain('<WtSection slug="NN-<rol>"><Seccion /></WtSection>');
    expect(f).toContain('`@/wt-section`');
    expect(f).toContain('después de escribirlo, su línea en `src/App.tsx` con `<WtSection slug>`');
  });
});

test('con la tool de imagen el prompt pide generate_image antes de la sección, con el src que devuelve', () => {
  const p = agentSystemPrompt({ ...base, imageTool: true });
  expect(p).toContain('`generate_image`: llámala ANTES de escribir la sección');
  expect(p).toContain('nunca con import');
});

// P1: en dos T1 (56644d79, 48de1230) el agente no escribió App una línea por sección; en el T1 lo monta el sistema.
test('página nueva: App lo monta el sistema y el agente solo escribe secciones; el follow-up sigue editando App', () => {
  for (const p of [agentSystemPrompt(base), agentSystemPrompt({ ...base, skillPreload: 'SKILL' })]) {
    const mode = p.slice(p.indexOf('MODO PÁGINA NUEVA'), p.indexOf('\n', p.indexOf('MODO PÁGINA NUEVA')));
    expect(mode).toContain('escribe sección por sección: Write de la sección → la siguiente sección');
    expect(mode).not.toContain('App');
    expect(p).toContain('`src/App.tsx` lo monta el sistema');
    expect(p).toContain('No escribas ni edites `src/App.tsx` en este turno');
    expect(p).not.toContain('recién cuando su archivo existe');
  }
  expect(agentSystemPrompt({ ...base, imageTool: true })).toContain('Write de la sección (si lleva imagen, `generate_image` antes)');
  const f = agentSystemPrompt({ ...base, followUp: true });
  expect(f).not.toContain('lo monta el sistema');
  expect(f).not.toContain('escribe sección por sección');
});

test('con browser, el agente pulsa los controles que agregó y reporta el error; sin browser no hay regla', () => {
  const p = agentSystemPrompt(base);
  expect(p).toContain('Pulsa lo que agregaste');
  expect(p).toContain('"click"');
  expect(p).toContain('"Pendiente"');
  expect(agentSystemPrompt({ ...base, hasBrowser: false })).not.toContain('Pulsa lo que agregaste');
});

test('el prompt manda medir primero al ancho de la persona y deja 1440 y 375 para los extremos', () => {
  const p = agentSystemPrompt(base);
  expect(p).toContain('sin `viewport` mide al ancho que la persona tiene en su preview');
  expect(p).toContain('{"viewport": 375}');
  expect(agentSystemPrompt({ ...base, hasBrowser: false })).not.toContain('mide al ancho que la persona');
});
