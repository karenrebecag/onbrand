import { expect, test } from 'bun:test';
import { briefTags, identityRequest } from '../src/brief-tags';

test('el brief de Acme cae en saas con tono sobrio y cercano; un brief sin señal no etiqueta nada', () => {
  expect(briefTags('Landing para Acme (acme.test), plataforma de agentes de IA que venden por WhatsApp. Público: gerentes de ventas de pymes en LATAM.')).toEqual({ sector: ['saas'], tone: ['sobrio', 'cercano'] });
  expect(briefTags('Clínica dental en Monterrey, trato amable y sin complicaciones')).toEqual({ sector: ['salud'], tone: ['amable'] });
  expect(briefTags('Quiero una landing bonita')).toEqual({ sector: [], tone: [] });
});

test('un follow-up que pide color, tipografía o radio es de identidad; copy, secciones y "no cambies los colores" no', () => {
  expect(identityRequest('acento azul, cámbialo en toda la página')).toBe(true);
  expect(identityRequest('Usa #8023FF como color principal y una tipografía más moderna para los títulos.')).toBe(true);
  expect(identityRequest('Cambia el plan Crecimiento por Pro. No cambies los colores.')).toBe(false);
  expect(identityRequest('acento azul')).toBe(true);
  expect(identityRequest('agrega una sección de integraciones entre cómo funciona y casos')).toBe(false);
});
