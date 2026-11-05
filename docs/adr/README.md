# ADRs de web-transformer

Decisiones de arquitectura que desvían del estándar fijado por los briefs APROBADOS en
`docs/research/`. Un ADR nace BORRADOR y solo Karen lo pasa a APROBADO (o lo rechaza); un agente
nunca escribe ese estado.

| n | Título | Estado | Fecha |
|---|---|---|---|
| 0001 | [Dos capas: layout (Relume) + inner (Arc)](0001-dos-capas-layout-inner.md) | BORRADOR | 2026-10-15 |
| 0002 | [El pool del router admite items fidelity-ok sin verified](0002-pool-fidelity-ok.md) | BORRADOR | 2026-10-16 |
| 0003 | [Brand Profile determinista sesga la composición](0003-brand-profile-determinista.md) | APROBADO | 2026-10-16 |
| 0004 | [Marca vs shortlist del router: slot reservado](0004-marca-vs-shortlist-router.md) | APROBADO | 2026-10-18 |
| 0005 | [Primera divergencia vs Arc: hero-signup forkeado con prueba social opcional](0005-fork-hero-signup-proof-opcional.md) | ACEPTADO | 2026-10-21 |
| 0006 | [Divergencia de lote: texto visible fijo a props y fuera la media de demo](0006-texto-y-media-de-demo-en-componentes.md) | APROBADO (firmado por QA con autorización de Karen) | 2026-10-22 |
| 0007 | [animated-counter respeta el espacio de prefix y suffix](0007-animated-counter-espacio-suffix.md) | APROBADO (firmado por QA con autorización de Karen) | 2026-10-22 |
| 0008 | [PageContract, el plan de página como dato que viaja](0008-page-contract.md) | APROBADO (Karen, 2026-10-23) | 2026-10-23 |
| 0009 | [Contrato de bloque: la página decide lo que el port tenía congelado](0009-contrato-de-bloque.md) | APROBADO (Karen) | 2026-10-23 |
| 0010 | [El plan decide las secciones de la página](0010-plan-decide-secciones.md) | APROBADO | 2026-10-23 |
| 0011 | [El agente escribe la página como v0; el DS es gramática, no catálogo](0011-agente-escribe-como-v0.md) | APROBADO (Karen, 2026-10-24) | 2026-10-24 |
| 0012 | [El plan de página vuelve, como texto que el agente escribe en su turno](0012-plan-de-pagina-como-artefacto.md) | APROBADO | 2026-10-27 |
| 0013 | [Modelo de ejecución: la corrida es durable, el preview es desechable](0013-modelo-de-ejecucion.md) | [KAREN:chat 2026-11-02] D1-D5; D6 abierta | 2026-11-02 |
| 0014 | [Transport conserva el ciclo de corrida y delega en colaboradores con deps explícitas](0014-transport-colaboradores.md) | PROPUESTO | 2026-11-04 |
| 0015 | [`src/v0` pasa a `src/runtime` y `Transport` pasa a `Runtime`](0015-runtime-rename.md) | [KAREN:chat 2026-11-04 "vamos con runtime"] | 2026-11-04 |
| 0016 | [En el deploy, el loop del agente corre como CLI dentro del Sandbox de cada chat](0016-donde-corre-el-loop.md) | [KAREN:chat 2026-11-04 "vamos con propuesta de Arq"]; cierra D6 de 0013 | 2026-11-04 |
| 0017 | [onbrand es un core agnóstico; cada distribución es un repo aparte](0017-cableado-core-perfil.md) | PROPUESTO | 2026-11-05 |
