// Medición en el navegador de los sensores de página (src/page-sensors.ts decide). Es un script clásico,
// sin imports, para que corra igual en Playwright (nuestro dist) y en el Chrome de Karen sobre el preview
// de v0 (chrome-devtools evaluate_script). Un solo código en los dos lados es lo que hace válida la
// calibración. Instala window.__wtSensors: pre() antes de bajar (lo oculto que espera un reveal), post()
// después (lo que quedó), run() hace las dos con el recorrido en medio.
(() => {
  // Sin data-wt-role (v0) las secciones son los landmarks de primer nivel.
  const sections = () => {
    const wrapped = [...document.querySelectorAll('[data-wt-role]')];
    if (wrapped.length) return wrapped.map((el, i) => ({ el, key: el.getAttribute('data-wt-slug') || String(i), role: el.getAttribute('data-wt-role') || '?' }));
    const top = [...document.querySelectorAll('header,section,footer')].filter((e) => !e.parentElement.closest('header,section,footer'));
    return top.map((el, i) => {
      const tag = el.tagName.toLowerCase();
      const role = tag === 'section' ? (el.id || el.classList[0] || 'section') : tag;
      return { el, key: `${String(i + 1).padStart(2, '0')}-${role}`, role };
    });
  };

  // El envoltorio display:contents no tiene caja: la de la sección es la unión de sus descendientes.
  const boxOf = (el) => {
    const own = el.getBoundingClientRect();
    if (own.width && own.height) return own;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const k of el.querySelectorAll('*')) {
      const q = k.getBoundingClientRect();
      if (!q.width || !q.height) continue;
      l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    }
    return r > l ? { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t } : own;
  };

  const shown = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
  };

  const srOnly = (el) => {
    const cs = getComputedStyle(el);
    return cs.position === 'absolute' && (cs.clipPath === 'inset(50%)' || (cs.width === '1px' && cs.height === '1px'));
  };

  // Visible para una persona: con caja, sin opacidad cero en él ni en un ancestro.
  const seenNow = (el) => {
    if (!shown(el) || srOnly(el)) return false;
    for (let a = el; a && a !== document.body; a = a.parentElement) if (Number(getComputedStyle(a).opacity) < 0.05) return false;
    return true;
  };

  const textOf = (el) => {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest('script,style,noscript') || !seenNow(p)) continue;
      out.push(n.nodeValue);
    }
    return out.join(' ').replace(/\s+/g, ' ').trim();
  };

  // Fragmentos: el texto de cada caja de bloque que no contiene otra caja de bloque con texto (un párrafo, un título,
  // una celda de tarjeta). Con innerText un contador por dígitos ("3", "8", "%") vuelve a leerse "38%", y la
  // tarjeta en inglés dentro de una sección en español queda aparte para que el idioma se decida por fragmento.
  const MAX_FRAGMENTS = 400;
  const fragmentsOf = (root) => {
    const isBox = (e) => { const d = getComputedStyle(e).display; return d !== 'none' && d !== 'contents' && !d.startsWith('inline'); };
    const all = [root, ...root.querySelectorAll('*')].filter((e) => !e.closest('script,style,noscript,svg'));
    const nested = new Set();
    const out = [];
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i];
      const box = isBox(e);
      if (nested.has(e)) { if (e.parentElement) nested.add(e.parentElement); continue; }
      const t = box && seenNow(e) ? (e.innerText || '').replace(/\s+/g, ' ').trim() : '';
      if (t) { out.push(t.slice(0, 400)); if (e.parentElement) nested.add(e.parentElement); }
    }
    return out.reverse().slice(0, MAX_FRAGMENTS);
  };

  // Una colección es un contenedor grid o flex con wrap cuyos hijos visibles son items del mismo tipo
  // y ancho parecido. Las filas salen de la posición real de cada item, no del CSS declarado.
  const collections = (root) => {
    const out = [];
    for (const c of root.querySelectorAll('*')) {
      const cs = getComputedStyle(c);
      const grid = cs.display.includes('grid');
      const wrap = cs.display.includes('flex') && cs.flexWrap === 'wrap' && cs.flexDirection.startsWith('row');
      if (!grid && !wrap) continue;
      const items = [...c.children].filter((k) => shown(k) && !srOnly(k) && getComputedStyle(k).position !== 'absolute');
      if (items.length < 3) continue;
      if (new Set(items.map((k) => k.tagName)).size !== 1) continue;
      const rects = items.map((k) => k.getBoundingClientRect());
      const widths = rects.map((r) => r.width);
      if (Math.min(...widths) <= 0 || Math.max(...widths) / Math.min(...widths) > 1.15) continue;
      const rows = [];
      for (const r of rects) {
        const row = rows.find((x) => Math.abs(x.top - r.top) <= 4);
        if (row) row.count += 1; else rows.push({ top: r.top, count: 1 });
      }
      rows.sort((a, b) => a.top - b.top);
      // Un flex-wrap de items que se miden por su contenido (enlaces legales, chips: flex-grow 0, basis auto,
      // sin ancho propio) es texto que fluye: que el último quede solo en su fila no es una colección
      // incompleta (falso positivo de site-footer a 375, legales en 2+1). Cuenta si el contenedor reparte
      // el ancho entre ellos (grow, basis o width fijados), como un grid.
      // HACK: el width por clase CSS (.card{width:300px} con basis auto) no se distingue de auto y esa colección
      // queda fuera (falso negativo). Comparar anchos de items no-texto cuando aparezca un bloque de tarjetas en flex-wrap.
      if (wrap && items.every((k) => { const ks = getComputedStyle(k); return Number(ks.flexGrow) === 0 && ks.flexBasis === 'auto' && !k.style.width && !/%|calc/.test(ks.maxWidth); })) continue;
      out.push({ items: items.length, rows: rows.map((r) => r.count), tag: items[0].tagName.toLowerCase(), cls: String(c.className).slice(0, 60) });
    }
    return out;
  };

  // Alineación de la cabecera: text-align computado o, si el bloque es más angosto que su contenedor,
  // la posición de su caja dentro de él.
  const headerAlign = (root) => {
    const h = [...root.querySelectorAll('h1,h2')].find(seenNow);
    if (!h) return null;
    const cs = getComputedStyle(h);
    if (cs.textAlign === 'center') return { align: 'center', text: h.textContent.trim().slice(0, 60) };
    // Se mide el texto (Range), no la caja del h2: un h2 de ancho completo dentro de un contenedor con
    // padding simétrico tiene la caja centrada aunque su texto arranque a la izquierda (logos a 375 en 8ae26d51).
    const range = document.createRange();
    range.selectNodeContents(h);
    const tb = range.getBoundingClientRect();
    let box = null;
    for (let a = h.parentElement; a && a !== document.body; a = a.parentElement) {
      const r = a.getBoundingClientRect();
      if (r.width > tb.width + 32) {
        const cs = getComputedStyle(a);
        box = { left: r.left + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.paddingRight) };
        break;
      }
    }
    if (box) {
      const left = tb.left - box.left, right = box.right - tb.right;
      if (left > 16 && Math.abs(left - right) <= 4) return { align: 'center', text: h.textContent.trim().slice(0, 60) };
    }
    // El borde izquierdo del texto es lo que lee section.gutter: el margen, no la alineación.
    return { align: 'start', text: h.textContent.trim().slice(0, 60), left: Math.round(tb.left) };
  };

  const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont', 'emoji', 'math']);
  const firstFamily = (el) => getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');

  const fonts = () => {
    const faces = [...document.fonts].map((f) => ({ family: f.family.replace(/^["']|["']$/g, ''), status: f.status }));
    const used = new Map();
    for (const el of [document.body, ...document.querySelectorAll('h1,h2,h3,p,a,button,li')]) {
      if (!seenNow(el)) continue;
      const fam = firstFamily(el);
      used.set(fam, (used.get(fam) || 0) + 1);
    }
    return [...used.entries()].map(([family, count]) => ({
      family,
      count,
      generic: GENERIC.has(family.toLowerCase()),
      loaded: faces.some((f) => f.family.toLowerCase() === family.toLowerCase() && f.status === 'loaded'),
      declared: faces.some((f) => f.family.toLowerCase() === family.toLowerCase()),
    }));
  };

  // Lo que espera un reveal: invisible por opacidad, con caja y texto o imagen. Se guarda el elemento
  // más alto de cada rama para no contar a sus hijos.
  const hiddenNow = (root) => {
    const out = [];
    for (const el of root.querySelectorAll('*')) {
      if (!shown(el) || srOnly(el)) continue;
      if (Number(getComputedStyle(el).opacity) >= 0.05) continue;
      if (out.some((o) => o.contains(el))) continue;
      // Sin texto ni imagen cuenta igual si tiene superficie: la escena decorativa de un CTA también entra animada.
      const r = el.getBoundingClientRect();
      if (!el.textContent.trim() && !el.querySelector('img,svg') && r.width * r.height < MIN_SCENE_PX) continue;
      out.push(el);
    }
    return out;
  };

  const MIN_SCENE_PX = 40 * 40;
  const state = { pre: null, expanded: {} };
  // Texto accesible que no es nodo de texto: un label que el bloque pone como aria-label también llegó.
  const ATTRS = ['aria-label', 'alt', 'title', 'placeholder'];
  const domTextOf = (el, key) => {
    const attrs = [...el.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))].flatMap((e) => ATTRS.map((a) => e.getAttribute(a) || ''));
    return [el.textContent || '', ...attrs, ...(state.expanded[key] || [])].join(' ').replace(/\s+/g, ' ').trim().slice(0, 60000);
  };

  // Lo que un desplegable cerrado no monta (Radix desmonta el contenido): se abre cada uno, se lee y se
  // vuelve a cerrar, para que el sensor de contenido no confunda "cerrado" con "no emitido".
  // El texto de partida va primero: en un acordeón de uno abierto (multiple=false), abrir otro desmonta el
  // que venía abierto y su respuesta no estaría en ninguna lectura posterior.
  const expandAll = async () => {
    for (const s of sections()) {
      const texts = [s.el.textContent || ''];
      for (const b of [...s.el.querySelectorAll('[aria-expanded="false"]')]) {
        if (!shown(b)) continue;
        b.click();
        await new Promise((r) => setTimeout(r, 120));
        texts.push(s.el.textContent || '');
        if (b.getAttribute('aria-expanded') === 'true') { b.click(); await new Promise((r) => setTimeout(r, 60)); }
      }
      state.expanded[s.key] = texts;
    }
  };

  // Enlaces e imágenes de la sección, para los sensores de intención (src/intent-sensors.ts): a dónde lleva cada
  // enlace y si su ancla existe; qué imagen se cargó, con sus dimensiones reales (un adjunto se reconoce por
  // ellas aunque cambie su nombre).
  const linksOf = (root) => [...root.querySelectorAll('a[href]')].filter(shown).map((a) => {
    const href = a.getAttribute('href') || '';
    const id = href.startsWith('#') ? decodeURIComponent(href.slice(1)) : '';
    return { href, text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80), target: id ? !!document.getElementById(id) : null };
  });
  // Una imagen lisa (un placeholder gris, como los de Relume) carga con naturalWidth > 0 como una foto: se
  // muestrea a 16x16 y cuenta como lisa si ningún canal varía más de FLAT_RANGE. Por debajo de 120 px (logos,
  // avatares) no se mide. Una imagen de otro origen ensucia el canvas y queda en null.
  const FLAT_RANGE = 6;
  const flatOf = (i) => {
    if (i.getBoundingClientRect().width < 120) return null;
    try {
      const c = document.createElement('canvas'); c.width = 16; c.height = 16;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(i, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data;
      const lo = [255, 255, 255, 255]; const hi = [0, 0, 0, 0];
      for (let p = 0; p < d.length; p += 4) for (let k = 0; k < 4; k++) { lo[k] = Math.min(lo[k], d[p + k]); hi[k] = Math.max(hi[k], d[p + k]); }
      return hi.every((h, k) => h - lo[k] <= FLAT_RANGE);
    } catch { return null; }
  };
  const imagesOf = (root) => [...root.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 0).map((i) => ({ src: (i.currentSrc || i.getAttribute('src') || '').slice(0, 300), alt: i.getAttribute('alt') || '', width: i.naturalWidth, height: i.naturalHeight, flat: flatOf(i) }));

  // El fondo que se pinta de verdad detrás de la sección: el primer color opaco desde su primer hijo con caja
  // hacia arriba. Con display:contents el wrapper no pinta; lo hace lo que lleva dentro.
  // Los tokens llegan en oklch o color-mix: el canvas los resuelve a rgb para que el decisor compare canales.
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const toRgb = (c) => {
    if (!c) return null;
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a === 0 ? null : `rgb(${r}, ${g}, ${b})`;
  };
  const bgAt = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = toRgb(getComputedStyle(e).backgroundColor);
      if (c) return c;
    }
    return 'rgb(255, 255, 255)';
  };
  const surfaceOf = (el) => {
    const inner = getComputedStyle(el).display === 'contents' ? [...el.children].find((k) => k.getBoundingClientRect().height > 0) || el : el;
    return { declared: el.getAttribute('data-wt-surface'), bg: bgAt(inner), page: bgAt(document.body) };
  };

  // Contrato de Section (F1, #224): la sección de contenido es un .l-section con un .l-container hijo directo, y el
  // container queda centrado (margen izquierdo = derecho respecto del viewport, ±1). Solo en páginas con
  // data-wt-role: v0 y Stitch no usan nuestro layout y no se les afirma. `Section bare` monta un bloque que trae su
  // propio contenedor (ADR 0011 enmienda 1): el contrato no se le afirma, y su margen lo sigue midiendo section.gutter.
  const layoutOf = (el) => {
    if (!el.hasAttribute('data-wt-role') || el.matches('.l-bare')) return null;
    const sec = el.matches('.l-section') ? el : el.querySelector(':scope > .l-section');
    const box = sec && [...sec.children].find((k) => k.matches('.l-container'));
    if (!box) return { section: !!sec, container: false, margins: null };
    const r = box.getBoundingClientRect();
    return { section: true, container: true, margins: { left: Math.round(r.left), right: Math.round(document.documentElement.clientWidth - r.right) } };
  };

  // Riqueza por forma (Q3), no por atributos: el mockup de chat de v0, Stitch, Lovable y el nuestro no lleva
  // figure, role=img ni aria-hidden, y el contador anterior daba 0 en los cuatro. Lo que v0 cuenta como visual
  // (V2 del RE): mockup del producto, iconografía funcional, diagrama de pasos y cifras grandes; más las fotos.
  const big = (e, n) => { const r = e.getBoundingClientRect(); return r.width >= n && r.height >= n; };
  const filled = (e) => { const c = getComputedStyle(e).backgroundColor; return c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c); };
  // Burbuja: caja con fondo propio, esquinas redondeadas y texto, más angosta que su contenedor.
  const bubble = (e, w) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.width < w * 0.85 && filled(e) && parseFloat(getComputedStyle(e).borderTopLeftRadius) >= 6 && e.textContent.trim().length > 0 && seenNow(e); };
  // HACK: el mockup se reconoce como chat (3 burbujas apiladas con dos bordes distintos). Un dashboard o una
  // tarjeta de producto no cuentan; sumar formas cuando un generador las use como visual principal.
  const mockupsOf = (root) => {
    let n = 0;
    for (const c of root.querySelectorAll('div,article,aside,figure')) {
      const r = c.getBoundingClientRect();
      if (r.width < 200 || r.height < 150 || c.querySelector('h1,h2')) continue;
      const bs = [...c.querySelectorAll('div,p,span')].filter((b) => bubble(b, r.width) && ![...b.querySelectorAll('div,p,span')].some((k) => bubble(k, r.width)));
      if (bs.length < 3) continue;
      const rects = bs.map((b) => b.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      const stacked = rects.every((q, i) => i === 0 || q.top >= rects[i - 1].top + 8);
      const edges = new Set(rects.map((q) => Math.round(q.left / 16))).size > 1 || new Set(rects.map((q) => Math.round(q.right / 16))).size > 1;
      if (stacked && edges) { n += 1; break; }
    }
    return n;
  };
  const visualsOf = (root) => {
    const body = parseFloat(getComputedStyle(document.body).fontSize) || 16;
    const photos = [...root.querySelectorAll('img,picture,video,canvas')].filter((e) => seenNow(e) && big(e, 48)).length;
    // Icono funcional: svg o glifo de fuente de iconos de 16 a 64 px junto a texto. Dentro de un control (chevron
    // del acordeón, flecha del botón) o de un li (el check de una lista de plan) es adorno, no iconografía.
    const iconEls = [...root.querySelectorAll('svg,[class*="material-symbols"],[class*="icon"]')].filter((e) => {
      if (!seenNow(e) || e.parentElement.closest('svg') || e.closest('button,a,summary,li')) return false;
      const r = e.getBoundingClientRect();
      return r.width >= 16 && r.width <= 64 && r.height >= 16 && r.height <= 64 && (e.closest('li,article,div') || root).textContent.trim().length > 20;
    });
    // El mismo glifo 4 veces o más es viñeta de lista (los checks de un plan en divs, Stitch), no iconografía.
    const glyph = (e) => (e.tagName.toLowerCase() === 'svg' ? e.innerHTML : e.textContent.trim());
    const repeats = new Map();
    for (const e of iconEls) repeats.set(glyph(e), (repeats.get(glyph(e)) || 0) + 1);
    const icons = iconEls.filter((e) => repeats.get(glyph(e)) < 4).length;
    // Pasos: 3 marcadores de secuencia o más ("01", "2", "Paso 3") como hoja de texto propia.
    const leaves = [...root.querySelectorAll('*')].filter((e) => !e.children.length && seenNow(e));
    const marker = (e) => /^(0?\d|paso \d|step \d|etapa \d)\.?$/i.test(e.textContent.trim());
    const steps = leaves.filter(marker).length;
    // Cifra grande: hoja con dígito al doble del cuerpo o más ("+42%", "3.2x"). El precio de un plan y el número
    // de un paso no son dato de impacto: ya cuentan como precio y como pasos.
    const figures = leaves.filter((e) => /\d/.test(e.textContent) && !marker(e) && !/[$€£]|US\$|\/mes|\/mo/.test(e.textContent) && e.textContent.trim().length <= 16 && parseFloat(getComputedStyle(e).fontSize) >= body * 2).length;
    const interactive = root.querySelectorAll('[aria-expanded],details,[role="tab"],[role="switch"],[aria-pressed],select,input[type="checkbox"],input[type="radio"]').length
      // Acordeón sin aria-expanded (Stitch): un botón cuyo hermano siguiente está oculto.
      + [...root.querySelectorAll('button:not([aria-expanded])')].filter((b) => b.nextElementSibling && !shown(b.nextElementSibling) && b.nextElementSibling.textContent.trim()).length;
    return { photos, mockups: mockupsOf(root), icons, steps: steps >= 3 ? steps : 0, figures, interactive };
  };

  // section.detail: además del elemento focal, la sección trae un detalle de soporte que la ancla (Stitch, RE
  // 2026-10-26: cada tarjeta cierra con un chip o una métrica). Soporte = chip (caja con fondo y radio, texto corto
  // en letra chica), etiqueta con icono chico (≤ 20 px junto a ≤ 40 caracteres) o nota en letra chica (≤ 0,875 del cuerpo).
  const supportOf = (root) => {
    const body = parseFloat(getComputedStyle(document.body).fontSize) || 16;
    const small = (e) => parseFloat(getComputedStyle(e).fontSize) <= body * 0.875;
    const inControl = (e) => e.closest('button,a,summary,input,select,nav');
    const chips = [...root.querySelectorAll('span,div,p,li')].filter((e) => {
      const t = e.textContent.trim(); const r = e.getBoundingClientRect();
      return t.length > 1 && t.length <= 40 && r.height <= 36 && !inControl(e) && seenNow(e) && filled(e) && parseFloat(getComputedStyle(e).borderTopLeftRadius) >= 4 && small(e) && ![...e.children].some((k) => filled(k) && k.textContent.trim() === t);
    }).length;
    const iconLabels = [...root.querySelectorAll('svg,[class*="material-symbols"]')].filter((e) => {
      const r = e.getBoundingClientRect(); const row = e.parentElement;
      return seenNow(e) && r.width <= 20 && r.height <= 20 && !inControl(e) && row && row.textContent.trim().length > 1 && row.textContent.trim().length <= 40;
    }).length;
    const notes = [...root.querySelectorAll('p,span,small')].filter((e) => {
      const t = e.textContent.trim();
      return !e.children.length && t.length >= 8 && t.length <= 90 && !inControl(e) && seenNow(e) && small(e);
    }).length;
    // Acción focal: un enlace o botón con fondo propio de 40 px o más (el CTA del cierre).
    const action = [...root.querySelectorAll('a,button')].some((e) => seenNow(e) && filled(e) && e.getBoundingClientRect().height >= 36);
    return { chips, iconLabels, notes, action };
  };

  // brand.logo: cada logo con el texto que lo acompaña en su enlace o en su fila, y su proporción. Si es wordmark lo
  // decide brand-sensors: el logoKind del pack o, sin él, la proporción (WORDMARK_RATIO).
  const logosOf = (root) => [...root.querySelectorAll('img,svg')].filter((e) => seenNow(e) && !e.parentElement.closest('svg')).flatMap((e) => {
    const r = e.getBoundingClientRect();
    if (r.height < 8 || r.width > 320) return [];
    const box = e.closest('a') || e.parentElement;
    const text = (box.innerText || '').replace(/\s+/g, ' ').trim();
    return text && text.length <= 40 ? [{ src: (e.getAttribute('src') || 'svg').slice(0, 200), text, ratio: Math.round((r.width / r.height) * 100) / 100 }] : [];
  });

  // button.unified: fondo, borde y radio de cada acción con fondo propio. Tabs, toggles y acordeones no son acciones.
  // El radio se topa a la mitad del alto: 9999px y 20px pintan la misma píldora en un botón de 40.
  const actionsOf = (root) => [...root.querySelectorAll('a[href],button')].filter((e) => {
    if (!seenNow(e) || e.matches('[role=tab],[aria-pressed],[aria-selected],[aria-expanded]')) return false;
    const r = e.getBoundingClientRect(); const t = (e.innerText || '').trim();
    return t.length > 1 && t.length <= 60 && r.height >= 28 && r.height <= 72 && filled(e);
  }).map((e) => {
    // Un borde del mismo color que el fondo no se ve: cuenta como sin borde.
    const cs = getComputedStyle(e); const bw = parseFloat(cs.borderTopWidth) || 0; const bc = toRgb(cs.borderTopColor); const bg = toRgb(cs.backgroundColor);
    return { text: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 40), bg, border: bw > 0 && bc && bc !== bg ? `${bw}px ${bc}` : 'none', radius: Math.round(Math.min(parseFloat(cs.borderTopLeftRadius) || 0, e.getBoundingClientRect().height / 2)) };
  });

  // portrait.empty: un retrato que pinta iniciales (1-3 mayúsculas solas en su caja) de 96 px o más, sin imagen dentro.
  // Un avatar chico con iniciales junto al nombre es un patrón válido; un panel de retrato con iniciales es un slot vacío.
  const PORTRAIT_MIN = 96;
  const initialsOf = (root) => [...root.querySelectorAll('span,div')].filter((e) => {
    const t = e.textContent.trim();
    if (!/^\p{Lu}{1,3}$/u.test(t) || e.children.length || !seenNow(e)) return false;
    const box = e.parentElement; const r = box.getBoundingClientRect();
    return box.textContent.trim() === t && r.width >= PORTRAIT_MIN && r.height >= PORTRAIT_MIN && !box.querySelector('img,picture,video');
  }).map((e) => e.textContent.trim());

  // icon.rendered: un icono de trazo (sus formas declaran stroke) que pinta relleno es un glifo roto: sin
  // fill="none" el relleno por defecto es negro y el reloj o el globo salen como discos (c9c5a540, pin a9f27fc8).
  // Un svg visible sin ninguna forma que pinte es un glifo que no llegó.
  const SHAPES = 'path,circle,rect,line,polyline,polygon,ellipse';
  const paints = (v) => v && v !== 'none' && !/rgba\(.*,\s*0\)$/.test(v);
  const brokenIconsOf = (root) => [...root.querySelectorAll('svg')].filter((svg) => {
    if (!seenNow(svg) || svg.parentElement.closest('svg')) return false;
    const r = svg.getBoundingClientRect();
    if (r.width < 12 || r.width > 64 || r.height < 12 || r.height > 64) return false;
    const shapes = [...svg.querySelectorAll(SHAPES)];
    if (!shapes.some((e) => paints(getComputedStyle(e).fill) || paints(getComputedStyle(e).stroke))) return true;
    const outline = shapes.some((e) => e.hasAttribute('stroke') || e.closest('[stroke]'));
    // Un fill escrito en la forma o en el svg es decisión del icono (el play sólido de lucide en v0), no un olvido.
    return outline && shapes.some((e) => e.tagName.toLowerCase() !== 'line' && paints(getComputedStyle(e).fill) && !e.closest('[fill]'));
  }).map((svg) => (svg.closest('li,article,div') || root).textContent.trim().slice(0, 40));

  const highlightAreas = () => {
    const accent = toRgb(getComputedStyle(document.documentElement).getPropertyValue('--brand-highlight').trim());
    const want = accent && (accent.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    if (!want || want.length < 3) return [];
    return [...document.querySelectorAll('body *')].filter(shown).flatMap((el) => {
      const bg = toRgb(getComputedStyle(el).backgroundColor);
      const got = bg && (bg.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
      if (!got || got[3] === 0 || Math.max(...want.map((v, i) => Math.abs(v - got[i]))) > 24) return [];
      const r = el.getBoundingClientRect();
      const section = el.closest('[data-wt-role],header,section,footer');
      return [{ tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60), bg, area: Math.round(r.width * r.height), section: section ? section.getAttribute('data-wt-slug') || section.getAttribute('data-wt-role') || section.tagName.toLowerCase() : '-' }];
    });
  };

  const pre = () => {
    state.pre = sections().map((s) => ({ key: s.key, hidden: hiddenNow(s.el) }));
    return state.pre.map((s) => ({ key: s.key, hidden: s.hidden.length }));
  };

  const post = () => {
    const viewport = document.documentElement.clientWidth;
    return {
      viewport,
      lang: document.documentElement.getAttribute('lang') || '',
      title: document.title,
      // Ancho del documento contra el del viewport: un bloque que no se encoge a 375 empuja la página de lado.
      overflow: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      fonts: fonts(),
      // El acento que resuelve la página (la variable del DS) y el preset del <html>; lo compara brand-sensors.
      accent: { attr: document.documentElement.getAttribute('data-accent'), rgb: toRgb(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()) },
      // Superficies pintadas con el color de identidad (--brand-highlight) y su área: brand-sensors decide si la marca lo
      // permite en áreas grandes. Solo viajan las cercanas a ese color, para no mandar todo el DOM.
      highlightAreas: highlightAreas(),
      animations: document.getAnimations ? document.getAnimations().length : 0,
      sections: sections().map((s) => {
        const before = (state.pre || []).find((p) => p.key === s.key);
        const revealed = before ? before.hidden.filter((el) => el.isConnected && seenNow(el)).length : 0;
        const box = boxOf(s.el);
        return {
          key: s.key,
          role: s.role,
          frame: ['header', 'footer', 'nav'].includes(s.role) || ['HEADER', 'FOOTER', 'NAV'].includes(s.el.tagName),
          height: Math.round(box.height),
          header: headerAlign(s.el),
          collections: collections(s.el),
          links: linksOf(s.el),
          images: imagesOf(s.el),
          visuals: visualsOf(s.el),
          support: supportOf(s.el),
          surface: surfaceOf(s.el),
          brokenIcons: brokenIconsOf(s.el),
          logos: logosOf(s.el),
          actions: actionsOf(s.el),
          initials: initialsOf(s.el),
          layout: layoutOf(s.el),
          hiddenBefore: before ? before.hidden.length : 0,
          revealed,
          text: textOf(s.el).slice(0, 20000),
          fragments: fragmentsOf(s.el),
          // Todo el texto del DOM, visible o no: un acordeón cerrado o un tab inactivo tienen su texto aquí.
          // Lo que falta incluso de aquí no se emitió o el bloque no lo pinta.
          domText: domTextOf(s.el, s.key),
        };
      }),
    };
  };

  const run = async () => {
    pre();
    for (let y = 0; y <= document.documentElement.scrollHeight; y += 300) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
    await new Promise((r) => setTimeout(r, 1200));
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await expandAll();
    scrollTo(0, 0);
    return post();
  };

  window.__wtSensors = { pre, post, run };
})();
