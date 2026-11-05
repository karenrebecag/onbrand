// Rol de una sección a partir de su slug `NN-<rol>[-N]`. Hoja sin imports: la usan los sensores de src/ y section-ops
// del runtime, y src/ no importa de src/runtime/.
// El sufijo `-N` es el de una copia de sectionOp (`04-casos-2`, #723): la copia tiene el rol de su origen. Ningún rol del
// DS termina en número (src/types.ts:7-20); un slug libre del agente que sí (`05-top-10`) pierde ese número en el rol, y el
// rol solo alimenta heurísticas (foco del plan, sugerencias, alcance), no la identidad del archivo.

export const roleOfSlug = (slug: string): string => slug.replace(/^\d+-/, '').replace(/-\d+$/, '');
