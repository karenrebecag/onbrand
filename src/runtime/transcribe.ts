// Transcripción del dictado del builder. El core no transcribe (undefined = el builder no monta el micrófono); un
// perfil de distro enchufa este proveedor por el seam de config (sus defaults o WT_TRANSCRIBE_PROVIDER). Va por el endpoint de
// transcripción de AI Gateway (POST /v4/ai/transcription-model, VERIFIED vercel.com/docs/ai-gateway/modalities/speech-to-text)
// con el mismo auth Bearer que el resto del Gateway: AI_GATEWAY_API_KEY en local/CI o VERCEL_OIDC_TOKEN en el deploy.

import { config, type TranscribeProvider } from '../config';
import { GATEWAY_BASE_URL } from './infer';

/** Función del seam del transport: audio crudo + su tipo declarado -> texto. */
export type Transcribe = (audio: Uint8Array, type: string) => Promise<string>;

const TRANSCRIPTION_PATH = '/v4/ai/transcription-model';
const DEFAULT_MODEL = 'openai/whisper-1';
// El dictado es un clip corto; un tope evita que una petición colgada bloquee la key.
const TIMEOUT_MS = 60_000;

export function gatewayTranscribe(model = process.env.WT_TRANSCRIBE_MODEL ?? DEFAULT_MODEL): Transcribe {
  return async (audio, type) => {
    // El token se lee al transcribir, no al arrancar: una distro sin la key no debe tirar el server, solo fallar el dictado.
    const token = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;
    if (!token) throw new Error('gateway: falta AI_GATEWAY_API_KEY o VERCEL_OIDC_TOKEN');
    const res = await fetch(`${GATEWAY_BASE_URL}${TRANSCRIPTION_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'ai-gateway-protocol-version': '0.0.1',
        'ai-transcription-model-specification-version': '4',
        'ai-model-id': model,
      },
      body: JSON.stringify({ audio: Buffer.from(audio).toString('base64'), mediaType: type }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`transcripción: HTTP ${res.status}`);
    const body = (await res.json()) as { text?: unknown };
    if (typeof body.text !== 'string') throw new Error('transcripción: respuesta sin texto');
    return body.text;
  };
}

/** El proveedor del perfil activo. `none` (core) deja el seam sin inyectar: el transport responde "no soportado" y el
 * builder no monta el micrófono. */
export function transcribeProvider(provider: TranscribeProvider = config().transcribeProvider): Transcribe | undefined {
  return provider === 'gateway' ? gatewayTranscribe() : undefined;
}
