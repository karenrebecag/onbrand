// HACK: el runtime emite parte de los labels en inglés (los pasos `transport:*`, copia de v0) y el builder los pasa al
// español aquí. Trigger: cuando los dueños de esos pasos los emitan en español, esta tabla se borra.

const FIXED: Readonly<Record<string, string>> = {
  'Applying brand': 'Aplicando la marca',
  'Applied brand': 'Aplicó la marca',
  Building: 'Compilando',
  Built: 'Compiló',
  'Checking components': 'Revisando componentes',
  'Checked components': 'Revisó componentes',
  'Checking preview': 'Revisando el preview',
  'Checked preview': 'Revisó el preview',
  'Checking render': 'Revisando el render',
  'Checked render': 'Revisó el render',
  'Fetching Arc sources': 'Trayendo fuentes de Arc',
  'Fetched Arc sources': 'Trajo fuentes de Arc',
  'Installing dependencies': 'Instalando dependencias',
  'Installed dependencies': 'Instaló dependencias',
  'Mounting design system': 'Montando el design system',
  'Mounted design system': 'Montó el design system',
  'Opening registry': 'Abriendo el registry',
  'Opened registry': 'Abrió el registry',
  'Preparing workspace': 'Preparando el workspace',
  'Prepared workspace': 'Preparó el workspace',
  'Preview ready': 'Preview listo',
  'Preview failed': 'Falló el preview',
  'Opening live preview': 'Abriendo el preview',
  'Live preview': 'Preview en vivo',
  'Preview check failed': 'Falló la revisión del preview',
  'Queueing fix': 'Encolando arreglo',
  'Reading agent skill': 'Leyendo el skill del agente',
  'Read agent skill': 'Leyó el skill del agente',
  'Reading registry': 'Leyendo el registry',
  'Read registry': 'Leyó el registry',
  'Registry unavailable': 'Registry no disponible',
  'Restoring version': 'Restaurando versión',
  'Restored version': 'Restauró versión',
  'Saving images': 'Guardando imágenes',
  'Saved images': 'Guardó imágenes',
  'Saving version': 'Guardando versión',
  'Saved version': 'Guardó versión',
  Thinking: 'Pensando',
  // agent-stream deja el nombre crudo de las tools que no traduce; la del harness que carga tools diferidas es la única vista.
  ToolSearch: 'Buscó herramientas',
  'Writing document': 'Escribiendo el documento',
  'Wrote document': 'Escribió el documento',
  'Writing page': 'Escribiendo la página',
  'Wrote page': 'Escribió la página',
}

const PATTERNS: readonly [RegExp, string][] = [
  [/^Writing (.+)$/, 'Escribiendo $1'],
  [/^Wrote (.+)$/, 'Escribió $1'],
  [/^Removing (.+)$/, 'Quitando $1'],
  [/^Removed (.+)$/, 'Quitó $1'],
  [/^Thought for (.+)$/, 'Pensó $1'],
]

/** El label del motor en español; uno que no está en la tabla pasa tal cual (los del agente ya vienen en español). */
export function stepLabelEs(label: string): string {
  const fixed = FIXED[label]
  if (fixed) return fixed
  const hit = PATTERNS.find(([re]) => re.test(label))
  return hit ? label.replace(hit[0], hit[1]) : label
}
