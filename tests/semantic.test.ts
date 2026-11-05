import { describe, expect, test } from 'bun:test';
import { candidateTokens, roleQuery, semanticMatch, tokenize } from '../src/semantic';
import { scoreCandidate } from '../src/rank';
import type { Brief, Candidate, RoleSpec } from '../src/types';

const base = (over: Partial<Candidate>): Candidate => ({
  slug: 's', name: 'n', category: 'c', tags: [], geometry: 'standard',
  surface: { light: 'base', dark: 'base' }, ...over,
});

describe('semántica — brief es <-> señales en del organismo', () => {
  test('tokenize normaliza acentos, plurales y puentes es->en', () => {
    const t = tokenize('agente de IA que responde chats y recupera carritos');
    expect(t.has('agent')).toBe(true); // agente -> agent
    expect(t.has('ai')).toBe(true); // IA -> ai
    expect(t.has('chat')).toBe(true); // chats -> chat
    expect(t.has('cart')).toBe(true); // carritos -> cart
    expect(t.has('de')).toBe(false); // stopword fuera
  });

  test('un organismo de chat matchea un brief de IA/WhatsApp; uno irrelevante no', () => {
    const q = roleQuery({ summary: 'Agente de IA que responde el WhatsApp y convierte chats en ventas' }, 'features');
    const aiChat = base({ slug: 'ai-chat', keywords: ['ai chat', 'streaming chat interface', 'llm chat ui'] });
    const scatter = base({ slug: 'connected-scatter', keywords: ['connected scatter', 'scatter plot', 'cac', 'ltv'] });
    expect(semanticMatch(q, aiChat).score).toBeGreaterThan(semanticMatch(q, scatter).score);
    expect(semanticMatch(q, aiChat).overlap).toContain('chat');
  });

  test('un candidato sin manifiesto no aporta eje semántico (overlap 0)', () => {
    const q = roleQuery({ summary: 'cualquier cosa de chat' }, 'features');
    expect(candidateTokens(base({ slug: 'relume-layout' }))).toEqual(new Set());
    expect(semanticMatch(q, base({ slug: 'relume-layout' })).score).toBe(0);
  });

  test('la señal semántica sube el score de un organismo on-topic por encima del mismo sin keywords', () => {
    const brief: Brief = { summary: 'Agente de IA que responde el WhatsApp del e-commerce y recupera carritos' };
    const spec: RoleSpec = { role: 'features', category: 'feature-sections', desiredTags: [] };
    const onTopic = scoreCandidate(brief, spec, base({ slug: 'ai-chat', keywords: ['ai chat', 'chat interface', 'ecommerce support', 'cart recovery'] }));
    const mute = scoreCandidate(brief, spec, base({ slug: 'ai-chat-mute' }));
    expect(onTopic.score).toBeGreaterThan(mute.score);
    expect(onTopic.reasons.some((r) => r.startsWith('semántica+'))).toBe(true);
  });
});
