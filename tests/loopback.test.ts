import { expect, test } from 'bun:test';
import { loopbackTwins } from '../src/runtime/loopback';

test('localhost y 127.0.0.1 del mismo puerto son gemelos; otros no entran', () => {
  expect(loopbackTwins('http://localhost:5173').sort()).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
  expect(loopbackTwins('http://127.0.0.1:5173').sort()).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
});

test('otro puerto u otro host NO es gemelo (la barrera CSRF sigue)', () => {
  const twins = loopbackTwins('http://localhost:5173');
  expect(twins).not.toContain('http://localhost:3000'); // otra app local no entra
  expect(twins).not.toContain('http://127.0.0.1:3000');
});

test('un origen no-loopback (Sandbox de la distro) se devuelve solo, sin gemelo', () => {
  expect(loopbackTwins('https://sb-71uhuh9ri4ix.vercel.run')).toEqual(['https://sb-71uhuh9ri4ix.vercel.run']);
});

test('un valor que no es URL se compara literal, sin romper', () => {
  expect(loopbackTwins('no-es-url')).toEqual(['no-es-url']);
});
