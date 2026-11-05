import { expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiHandlers } from '../src/runtime/api-handlers';
import { HttpError } from '../src/runtime/http';

// LOW de QA: el Runtime sin proveedor de conectores respondía 404 {"error":...} y el orquestador sin puerto 501
// connectors-unavailable (#876); se unifican en 501 con code connectors-unavailable para que run-client lea un solo caso.
test('sin proveedor de conectores, la ruta responde 501 connectors-unavailable', async () => {
  const api = new ApiHandlers({ uploads: {} as never, canvasDir: () => '' });
  const err = await api
    .connectors({} as IncomingMessage, {} as ServerResponse, ['connectors', 'accounts'], new URL('http://t/'))
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(501);
  expect((err as HttpError).details).toEqual({ code: 'connectors-unavailable' });
});
