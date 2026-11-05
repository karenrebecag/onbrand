import { describe, expect, test } from 'bun:test';
import { lintRaw } from '../src/lint-raw';

describe('lint.raw', () => {
  test('un <button>, un <input>, un style inline y un TODO a mano son hits; con su línea', () => {
    const text = ['<section>', '  <button onClick={go}>Ver</button>', '  <input type="email" />', '  <div style={{ marginLeft: 20 }}>', '  {/* TODO: número real */}', '</section>'].join('\n');
    expect(lintRaw([{ file: 'src/sections/08-cierre.tsx', text }]).map((h) => [h.kind, h.line])).toEqual([['button', 2], ['input', 3], ['style', 4], ['todo', 5]]);
  });

  test('el <button> hijo de un trigger con asChild (el menú móvil de cc7b8016) es del componente: no es hit', () => {
    const text = ['<DrawerTrigger asChild>', '  <button type="button" aria-label="Abrir menú">', '</DrawerTrigger>', '<Action href={WA}>Agenda</Action>'].join('\n');
    expect(lintRaw([{ file: 'src/sections/01-navbar.tsx', text }])).toEqual([]);
  });
});
