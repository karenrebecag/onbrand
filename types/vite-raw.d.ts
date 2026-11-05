// Fixtures del builder importadas con `?raw` (vite); en la raíz solo hace falta el tipo.
declare module '*?raw' {
  const text: string;
  export default text;
}
