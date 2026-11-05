# Spec — Ranuras de variantes de marca

**Estado:** APROBADA (Karen, 2026-10-27).
**Decisiones de Karen ya tomadas (vía orq, 2026-10-27):** ranuras sí; tope de 3 variantes por componente y 12 por pack; `--brand-highlight` se queda en el contrato.
**Fundamento:** `~/Desktop/web-transformer-sesiones/re-guards/arq-brand-components.md` (RE de v0 design-system-skill-authoring y de los registries de shadcn).

## 1. Objetivo
Que una marca agregue variantes visuales a componentes del DS sin ampliar el contrato para todas las marcas. Las pills de la academia de una marca son el primer caso: hoy obligarían a un token nuevo en `foundation.css`, como pasó con `--whatsapp` en #262.

## 2. Mecanismo
- **Ranura:** un componente del DS publica qué variantes acepta de una marca y qué propiedades puede poner cada una. Las propiedades son custom properties que el componente ya lee, con su default al token de hoy.
  - Badge ya funciona así: cada `tone` fija `--badge-color`, `--badge-foreground`, `--badge-background` y `--badge-border`.
  - Button todavía no: hay que pasar sus variantes a custom properties.
- **La marca declara variantes, no componentes.** No puede pisar una variante base ni un componente entero (eso queda fuera de esta spec, sección 8).

## 3. Contrato de datos
**`extension-points.json`.** Lo genera el DS y viaja con el pin del registry, como `index@<pin>.json`:
```json
{ "badge":  { "prop": "tone",    "slots": ["color", "foreground", "background", "border"], "base": ["neutral", "success", "info", "warning", "danger"] },
  "button": { "prop": "variant", "slots": ["foreground", "background", "border", "hover"],    "base": ["primary", "secondary", "ghost", "danger", "whatsapp"] } }
```
Se genera leyendo el código (`--<componente>-<slot>` en el `.module.css` y la unión del prop en el `.tsx`). Nadie lo escribe a mano.

**En `brand.json`:**
```json
"requires": { "ds": "<pin con el que se validó>" },
"components": {
  "badge": { "variants": { "academy": {
    "use": "Etiquetas y filtros de programas de la academia.",
    "foreground": "var(--foreground)", "background": "var(--surface)", "border": "var(--border-strong)", "color": "var(--foreground)" } } }
}
```

## 4. Validación (fail closed, en `parseBrandPack`)
El pack no se aplica si falla cualquiera de estas reglas:
- el componente existe en `extension-points.json` del pin activo y cada clave es un slot suyo;
- el nombre cumple `^[a-z][a-z0-9-]{1,23}$` y no está en `base`;
- cada valor es `var(--<token del contrato>)`, un hex o `color-mix()` entre esos dos, con el guard de `parseTokens` (`;{}@`, `url(`, `expression(`);
- foreground contra background ≥ 4,5:1 cuando los dos resuelven a hex;
- hay como mucho 3 variantes por componente y 12 por pack;
- `use` es obligatorio, porque es lo que lee el agente;
- `requires.ds` existe; si el pin activo ya no publica un slot que el pack usa, el error nombra el slot.

## 5. Salida de `applyBrand`
- **En `src/identity.css`:** una regla por variante, `[data-brand-variant="academy"]` sobre la clase del componente, que fija sus custom properties. El componente pinta `data-brand-variant` cuando el valor del prop no es base.
- **`src/brand-variants.ts`:**
  - `export type BrandBadgeTone = 'academy'`, uno por componente;
  - el prop del componente pasa a `BadgeTone | BrandBadgeTone`;
  - sin pack el archivo exporta `never`, así que `typecheck` rechaza una variante que el pack no declaró.
- **`brand-skill.ts`:** suma "Variantes de la marca" a `references/components/`, con nombre, componente y `use`. El agente la lee en el paso 5 del orden de lectura (cada componente antes de usarlo), sin paso nuevo.

## 6. Regla de promoción
Una variante o un slot sube al contrato del DS solo si:
- la piden 2 packs o más, o
- es de un canal y no de una marca (como `--whatsapp`).
`--brand-highlight` se queda en el contrato por decisión de Karen.

## 7. Reparto
| Parte | Dueña |
|---|---|
| `extension-points.json`: generador y test de que coincide con el código | Arq |
| Button en el scaffold: variantes como custom properties y `data-brand-variant` | Arq |
| Badge: `data-brand-variant` y la unión con `BrandBadgeTone`. Vive en el vault (ui-react), así que necesita escritura autorizada por Karen | Arq, con el OK de Karen para el vault |
| Validación en `parseBrandPack` y salida de `applyBrand` (CSS + `brand-variants.ts`) | Front |
| `brand-skill.ts`: sección de variantes | Front |
| Publicar `extension-points.json` con el pin | Secondary |
| Variante `academy` de badge en el brand pack de la distro | Front, con el DESIGN.md de Arq |

## 8. Fuera de alcance
Componentes enteros de marca. Si hicieran falta: un item con espacio de nombres `@<marca>/<nombre>` que depende del DS por pin y se valida con typecheck, build y render-gate del starter, como en v0.

## 9. Criterios de aceptación
- **CA1:** sin pack, el render del starter es idéntico al de hoy (snapshot de estilos computados de Button y Badge).
- **CA2:** el pack de la distro con `badge.academy` se aplica, y una página que usa `tone="academy"` pasa `typecheck`; `tone="otra"` no pasa.
- **CA3:** cada regla de la sección 4 tiene un caso que hace fallar el pack con un mensaje que la nombra.
- **CA4:** `extension-points.json` regenerado sobre main no tiene diff con el publicado en el pin.

## 10. Seguridad
El pack es una frontera de confianza: sus valores van a `identity.css`. Lo cubre el guard de `parseTokens`, más la allowlist de slots y nombres. No hay superficie pública nueva.

## Enmienda 1 (APROBADA por Karen, 2026-10-27, en su terminal)
Precisiones técnicas que salieron de la revisión de Front. No cambian las decisiones de Karen; sustituyen lo que contradicen en las secciones 3 a 5.
1. **De dónde salen los extension points:** `parseBrandPack(raw, { extensionPoints })`. Un pack con `components` sin extension points falla cerrado. El runner los baja junto con el pin; Secondary confirma la ruta (`extension-points@<pin>.json`). `readBrandPackItem` valida contra el pin vigente al publicar.
2. **Contraste en los dos temas:** `var(--token)` se resuelve con `tokens` en claro y con `tokensDark` en oscuro, más los defaults del contrato si el pack no los pisa. Si falla en cualquiera de los dos, el pack no se aplica. Un hex fijo que pasa en claro y falla en oscuro tumba el pack a propósito.
3. **Guard:** el de los valores es `cssValue` de `brand.ts` (`UNSAFE_TOKEN_VALUE` más `\`, saltos de línea y comillas impares), no solo el de `parseTokens`. `use` pasa el mismo guard, porque llega al skill.
4. **Selector y clases:** los `.module.css` usan clases con hash, así que `identity.css` no puede nombrar la clase del componente.
   - La regla va sobre `[data-component="<componente>"][data-brand-variant="<nombre>"]`, y el componente pinta los dos atributos.
   - Con un valor que no es base, el componente no aplica ninguna clase de variante base, para que sus custom properties no compitan con las de la marca.
5. **Slots 1:1 con custom properties:** un slot es una propiedad, no un estado. En button, `hover` pasa a ser `hover-background` (`--button-hover-background`). El generador mapea `slot` → `--<componente>-<slot>` sin excepciones.
6. **`base` sale del código:** de la unión del prop en el `.tsx`. Badge (ui-react, verificado en un workspace con el pin vigente) tiene `BadgeTone = "neutral" | "success" | "info" | "warning" | "danger"`.
