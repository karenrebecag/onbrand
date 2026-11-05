// Una sola forma de escribir el import de un componente del catálogo. La mayoría de Arc exporta con
// nombre, pero hay fuentes (toast, segmented-control y casi todo ui-squircle) que solo traen
// `export default`: importarlas con llaves compila contra un export que no existe.

export interface ModuleExport {
  /** Nombre local del componente: el export nombrado, o el binding del default. */
  export: string;
  importPath: string;
  exportDefault?: boolean;
}

export const importLine = (m: ModuleExport, quote: "'" | '"' = "'"): string =>
  m.exportDefault
    ? `import ${m.export} from ${quote}${m.importPath}${quote};`
    : `import { ${m.export} } from ${quote}${m.importPath}${quote};`;
