#!/usr/bin/env bun
// Orquestador (docs/spec/deploy-sandbox.md): bun scripts/orchestrator.ts. Necesita un perfil que aporte gateway (WT_PROFILE_MODULE) y
// WT_ORCH_PRIVATE_KEY; sin authenticate usa un IdP por WT_JWT_*, sin sandbox una VM local (solo loopback); ver .env.example. Sale con 2 si algo falta, no arranca a medias.

import { killChildren } from '../src/runtime/children';
import { buildAdapters, loadProfile } from '../src/profile';
import { orchestratorFromEnv } from '../src/orchestrator/main';

// --help antes de cargar el perfil o abrir el puerto.
if (process.argv.includes('--help')) {
  console.log(`Uso: onbrand-orchestrator
Levanta el orquestador. Se configura solo por entorno (ver .env.example):
  WT_PROFILE_MODULE      perfil que aporta el gateway y, si los tiene, identidad y sandbox
  WT_ORCH_PRIVATE_KEY    clave con la que firma
  WT_JWT_*               IdP por JWKS o PEM cuando el perfil no autentica
Sale con 2 si falta algo; no arranca a medias.`);
  process.exit(0);
}

try {
  const boot = orchestratorFromEnv(process.env, buildAdapters(await loadProfile(process.env), process.env, 'orchestrator'));
  await boot.warm();
  const server = Bun.serve({ port: boot.port, hostname: boot.host, fetch: boot.fetch });
  console.log(`orquestador en http://${boot.host}:${server.port}`);
  // Las VM locales son procesos aparte (detached): sin esto sobreviven al orquestador con sus puertos y sus CLI.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void killChildren().finally(() => process.exit(0)); });
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
