# ADR 0002: El pool del router admite items `fidelity-ok` sin `verified`

Estado: BORRADOR (pendiente de firma de Karen) | Fecha: 2026-10-16
Origen: spec `docs/spec/porter-1765.md` (RF12) y su brief `docs/research/porter-1765.md` (APROBADO).

## Contexto

El brief `docs/research/runner-e2e-arquitectura.md:110` fija que el pool de emisión del motor solo
admite candidatos `verified: true` — una persona vio el render y lo firmó. Esa regla mantiene alta la
calidad del pool verificado, pero deja fuera los 1765 items que el porter de lote produce: ninguno
lleva `verified`, porque `verified` es un juicio humano y el lote no firma renders.

El porter (spec porter-1765) verifica cada item con su propia cadena automática y lo deja en un
`port.state` (RF12): `ported → built → rendered → fidelity-ok → verified-sample`. `fidelity-ok`
significa que el render portado casa con el original dentro de tolerancia, tiene todos sus slots y no
desborda — un gate automático fuerte, aunque no sea el ojo de Karen. Sin una vía de entrada al pool,
todo ese trabajo quedaría inerte hasta una revisión humana item a item, justo lo que el lote evita.

## Decisión

1. El pool **unverified** del router (el que da variedad entre secciones) admite un item si cumple
   **cualquiera** de: `verified: true`, `gate.ok === true` (ingest), o
   `port.state ∈ {fidelity-ok, verified-sample}` (lote). Contradice a propósito
   runner-e2e-arquitectura:110, que exigía `verified` para el pool.
2. El pool **verificado** (`verifiedCandidatesByRole`) NO cambia: sigue exigiendo `verified: true`.
   El lote **nunca** escribe `verified`; ese campo sigue siendo el render visto por una persona.
3. El desempate de calidad prefiere `verified` > `verified-sample` > `fidelity-ok` > `gate.ok`, para
   que, a igualdad de puntaje de intención, gane el candidato con la validación más fuerte.
4. `gate.ok` se conserva como vía de entrada durante la transición (hay tests y un pool que dependen
   de él). Cuando el lote cubra el catálogo, Karen decide si `gate.ok` se retira en favor de
   `port.state`; este ADR no lo retira.

## Consecuencias

- El pool gana cientos de secciones portadas sin esperar revisión humana, con un gate automático
  explícito y trazable (`port.state` + su motivo de cuarentena si cae).
- El contrato `verified` queda intacto: no se diluye, no lo toca el lote, y sigue siendo el nivel más
  alto del desempate. Un item `fidelity-ok` que luego Karen firma pasa a `verified` por la vía normal.
- Riesgo: un `fidelity-ok` con un defecto que el gate automático no vio entra al pool. Se acota con la
  muestra del 5% (RF17), que calibra las tolerancias contra el juicio de Karen antes de confiar en el
  estado a escala.

## Alternativas descartadas

- **Marcar el lote como `verified`.** Diluye el contrato y borra la distinción entre gate automático y
  ojo humano. Descartada: `verified` tiene que seguir significando lo que significa.
- **Un pool separado por `port.state`, aparte del unverified.** Duplica la lógica de ruteo y el
  desempate sin ganar nada: el estado ya ordena la calidad dentro de un solo pool.
