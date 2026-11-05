// Los tests que importan componentes del builder arrastran sus *.module.css; en el builder lo declara vite/client,
// que no existe en la raíz. Solo el tipo: el CSS nunca se evalúa en los tests.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
// section-contract importa layout.tsx del scaffold, que trae su CSS como import de efecto: basta con que el módulo exista.
declare module '*.css';
