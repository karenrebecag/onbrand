// Sector y tono del brief para elegir dirección (catálogo de direcciones, spec §5): palabras clave, no modelo. Un brief
// sin señal devuelve listas vacías y pickDirection usa todo el catálogo; la semilla decide.
const SECTOR: Record<string, readonly string[]> = {
  saas: ['saas', 'software', 'plataforma', 'app', 'aplicación', 'aplicacion', 'crm', 'dashboard', 'api', 'automatiza', 'agentes de ia', 'inteligencia artificial', 'startup', 'herramienta'],
  servicios: ['agencia', 'consultor', 'servicio', 'despacho', 'estudio', 'abogad', 'contador', 'contab', 'asesor', 'freelance', 'mantenimiento'],
  salud: ['clínica', 'clinica', 'salud', 'médic', 'medic', 'dental', 'dentista', 'hospital', 'terapia', 'psicolog', 'nutri', 'veterinari', 'farmacia'],
  educacion: ['curso', 'academia', 'escuela', 'universidad', 'bootcamp', 'clase', 'formación', 'formacion', 'educa', 'tutor', 'capacitación', 'capacitacion', 'diplomado'],
  retail: ['tienda', 'ecommerce', 'e-commerce', 'catálogo', 'catalogo', 'producto', 'venta en línea', 'envíos', 'envios', 'ropa', 'calzado', 'muebles', 'shop', 'carrito'],
  finanzas: ['banco', 'fintech', 'crédito', 'credito', 'préstamo', 'prestamo', 'inversión', 'inversion', 'seguro', 'trading', 'bróker', 'broker', 'pago', 'finanzas', 'cripto', 'hipoteca'],
  hospitalidad: ['hotel', 'restaurante', 'café', 'cafetería', 'cafeteria', 'bar', 'turismo', 'viaje', 'hostal', 'reserva', 'spa', 'resort', 'boutique', 'airbnb', 'eventos'],
  creativo: ['diseño', 'diseno', 'fotograf', 'arquitect', 'portafolio', 'portfolio', 'ilustra', 'música', 'musica', 'arte', 'galería', 'galeria', 'video', 'branding', 'estudio creativo'],
};
const TONE: Record<string, readonly string[]> = {
  sobrio: ['sobrio', 'serio', 'corporativo', 'institucional', 'formal', 'profesional', 'confianza', 'b2b', 'empresas', 'gerentes', 'directores'],
  cercano: ['cercano', 'cálido', 'calido', 'humano', 'familiar', 'amigable', 'comunidad', 'personas', 'pymes', 'local', 'barrio'],
  audaz: ['audaz', 'atrevido', 'disruptiv', 'rebelde', 'bold', 'impacto', 'rompe', 'nueva generación', 'nueva generacion', 'joven', 'urbano'],
  editorial: ['editorial', 'revista', 'historia', 'narrativa', 'manifiesto', 'periodis', 'lectura', 'ensayo', 'cultura', 'artesan'],
  tecnico: ['técnico', 'tecnico', 'developer', 'desarrollador', 'api', 'ingenier', 'datos', 'infraestructura', 'devops', 'open source', 'sdk', 'código', 'codigo'],
  premium: ['premium', 'lujo', 'exclusiv', 'alta gama', 'élite', 'elite', 'sofisticad', 'de autor', 'gourmet', 'vip', 'boutique'],
  amable: ['amable', 'sencillo', 'fácil', 'facil', 'simple', 'sin complicaciones', 'tranquil', 'bienestar', 'cuidado', 'acompaña', 'paso a paso', 'niños', 'ninos', 'mascotas'],
};

const hits = (text: string, table: Record<string, readonly string[]>): string[] =>
  Object.entries(table).filter(([, words]) => words.some((w) => text.includes(w))).map(([k]) => k);

/** Etiquetas del brief en el vocabulario del catálogo: sector (saas, servicios, salud…) y tono (sobrio, cercano…). */
export function briefTags(prompt: string): { sector: string[]; tone: string[] } {
  const text = prompt.toLowerCase();
  return { sector: hits(text, SECTOR), tone: hits(text, TONE) };
}

const IDENTITY_TERM = /\b(colou?r(es)?|acento|paleta|fondo|tipograf[ií]a|fuentes?|radio|esquinas|bordes redondeados|violeta|morado|azul|verde|rojo|naranja|amarillo|rosa|negro|blanco|gris)\b|#[0-9a-f]{3,8}\b/;
const KEEP_IDENTITY = /\bno (cambies|toques|modifiques)\b[^.!?\n]*\b(colou?r|acento|paleta|fondo|tipograf|fuente|radio)/;

/** Un follow-up que nombra color, tipografía o radio: todo follow-up es un pedido de cambio (F1 #389 fue "acento azul",
 * sin verbo). Solo habilita el archivo de tokens en ese turno; dónde va el cambio (global o de una sección) lo sigue
 * diciendo la regla del prompt. */
export function identityRequest(prompt: string): boolean {
  return prompt.toLowerCase().split(/(?<=[.!?\n])\s+/).some((s) => IDENTITY_TERM.test(s) && !KEEP_IDENTITY.test(s));
}
