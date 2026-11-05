// Enhancer de prompt de Stitch: un brief corto se expande en 2-4 frases accionables antes de generar. System prompt
// y ciclo de vida de re-iteracion/stitch-ui/deob-2026-11-02/webcrack/usePromptPreview-DHh074zF/deobfuscated.js
// (webcrack): :22-43 el texto, :44-89 `et()` (uno a la vez, abortable, acumula los chunks y entrega el parcial en
// cada uno), :64 una sola cadena `${F}\n"${prompt}"` sin systemInstruction; PostMessageClient-7-Av4pta :919-928 el
// stream que entrega texto. El modelo lo elige el host de Stitch y no tiene extract: va por la Messages API de
// Anthropic en AI Gateway con stream (https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api,
// "Supported endpoints" y "Optional parameters: stream"), con el mismo cliente que gatewayInfer.

import Anthropic from '@anthropic-ai/sdk';
import { config, type EnhancerProvider } from '../config';
import { gatewayConnection } from './gateway-auth';
import { gatewayModel, spawnCli, type RunCli } from './infer';

// El nombre del producto es lo único que cambia respecto de Stitch: el resto del texto se mantiene.
export const ENHANCER_PROMPT = `You are a UI/UX design prompt enhancer for an AI design tool.

Given a short user prompt, expand it into a detailed, actionable design brief that will produce better initial screen designs. Focus on:
- Specific UI components and layout structure
- Visual style direction (modern, minimal, bold, etc.)
- Key screens or sections to include
- Color and typography suggestions when relevant
- Interactive elements and user flows

CRITICAL REQUIREMENT:
If the input contains instructions referencing uploaded files or URLs (e.g., "Use this design.md", "Use the design system from google.com"), you MUST preserve that instruction phrase verbatim at the very end of the output text.

Write concisely as a direct design prompt (2-4 sentences), not as a conversation. Do not use markdown formatting.

Examples:
Input: "social media app"
Output: "A modern social media app with a clean feed layout featuring card-based posts with user avatars, like/comment actions, and image carousels. Include a bottom navigation bar with Home, Search, Create Post, Notifications, and Profile tabs. Use a light theme with subtle purple accents, rounded corners, and Inter font. The feed should show a mix of text posts, images, and stories at the top."

Input: "fitness tracking dashboard. Use this design.md"
Output: "An intuitive fitness tracker dashboard featuring health activity charts, historical progress grids, and daily goal analytics. Uses simple components with rich design patterns. Use this design.md"

Now enhance this prompt:`;

/** Texto del modelo en chunks; el abort corta la petición. */
export type TextStream = (prompt: string, signal: AbortSignal) => AsyncIterable<string>;

export const enhancerInput = (prompt: string): string => `${ENHANCER_PROMPT}\n"${prompt}"`;

export interface Enhancer {
  /** No hace nada con un prompt vacío o con otro rewrite en curso. `onChunk` recibe el texto acumulado. */
  rewrite(prompt: string, onChunk: (text: string) => void, onDone?: (text: string) => void): void;
  isRewriting(): boolean;
  cancel(): void;
}

export function createEnhancer(stream: TextStream, onError: (err: unknown) => void = () => {}): Enhancer {
  let controller: AbortController | null = null;
  return {
    rewrite(prompt, onChunk, onDone) {
      if (!prompt.trim() || controller) return;
      const own = new AbortController();
      controller = own;
      void (async () => {
        let text = '';
        try {
          for await (const chunk of stream(enhancerInput(prompt), own.signal)) {
            if (own.signal.aborted) break;
            text += chunk;
            onChunk(text);
          }
          if (!own.signal.aborted) onDone?.(text);
        } catch (err) {
          // Como Stitch: un fallo no cambia el prompt, solo se registra.
          if (!own.signal.aborted) onError(err);
        } finally {
          if (controller === own) controller = null;
        }
      })();
    },
    isRewriting: () => controller !== null,
    cancel() {
      controller?.abort();
      controller = null;
    },
  };
}

const MAX_ENHANCED_TOKENS = 1024;

export function gatewayTextStream(model?: string): TextStream {
  const { baseURL, token } = gatewayConnection();
  const client = new Anthropic({ baseURL, authToken: token, maxRetries: 0 });
  const id = gatewayModel(model);
  return async function* (prompt, signal) {
    const events = await client.messages.create({ model: id, max_tokens: MAX_ENHANCED_TOKENS, stream: true, messages: [{ role: 'user', content: prompt }] }, { signal });
    for await (const e of events) {
      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') yield e.delta.text;
    }
  };
}

/** El enhancer del clon limpio: `claude -p` con la sesión local, sin cuentas. El CLI devuelve el texto entero de una vez,
 * así que llega como un solo chunk; la UI ya acumula, solo pierde el efecto de escritura. Mismo piso de aislamiento que
 * claudeCodeInferFree: sin los MCP ni los hooks de quien corre el transport. */
export function cliTextStream(opts: { model?: string; bin?: string; run?: RunCli } = {}): TextStream {
  const run = opts.run ?? spawnCli;
  const bin = opts.bin ?? process.env.WT_COMPOSE_CLI ?? 'claude';
  const model = opts.model ?? process.env.WT_ENHANCER_MODEL ?? 'haiku';
  return async function* (prompt, signal) {
    const text = (await run(bin, ['-p', '--model', model, '--strict-mcp-config', '--setting-sources', 'project'], prompt, signal)).trim();
    if (text) yield text;
  };
}

/** Gateway solo en la variante (WT_ENHANCER_PROVIDER=gateway o el perfil de una distro); el core usa la sesión local. */
export function enhancerStream(provider: EnhancerProvider = config().enhancerProvider): TextStream {
  return provider === 'gateway' ? gatewayTextStream() : cliTextStream();
}
