// localhost y 127.0.0.1 son el mismo host de loopback, pero el navegador manda el Origin tal cual se abrió la pestaña:
// un builder servido en http://localhost:5173 llega como localhost o como 127.0.0.1 según la URL. guardWrite compara el
// Origin exacto, así que acepta las dos formas del MISMO puerto. No abre otros orígenes: un puerto distinto u otro host
// no entra (la barrera CSRF del transport sigue en pie).

/** El origen dado más su gemelo de loopback (localhost↔127.0.0.1) para el mismo puerto. Un origen que no sea
 *  localhost/127.0.0.1 (p. ej. el Sandbox de una distro) se devuelve solo, sin gemelo. */
export function loopbackTwins(origin: string): string[] {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return [origin]; // no es una URL: se compara literal
  }
  const swap = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname === '127.0.0.1' ? 'localhost' : undefined;
  if (!swap) return [u.origin];
  const twin = new URL(u.href);
  twin.hostname = swap;
  return [u.origin, twin.origin];
}
