# S0 Arnés y medición
Estado: APROBADA · Dueño: Orq (código) + QA (casos)

## Objetivo
Que cada ola se cierre contra casos medibles del T1 real, con logs que hoy no se guardan.

## Cambios
1. scripts/v0serve.ts: guarda el stdout/stderr del vite del preview de cada workspace en generated/<root>/logs/<ws>.vite.log. Hoy se pierde (qa.md §límite).
   Fundamento: documentación de Bun, Bun.spawn stdout/stderr (https://bun.sh/docs/api/spawn). No hay extract: es instrumentación propia.
2. Casos del arnés (QA los define en docs/programa-ronda-extracts/arnes.md):
   - A1: cada sección monta antes de que se escriba la siguiente, en orden.
   - A2: a lo sumo 1 full-reload, la de index.html antes de la primera sección, y 0 desde la primera sección hasta message.end.
   - A3: cada elemento nuevo pasa por el cursor y el rectángulo del puente, y la cola se vacía.
   - A4: cada estado de carga de S3 aparece y desaparece en su momento.
   - A5: 0 errores de hooks y 0 pill de error al final.
   - A6: los follow-ups F1a-F1d de 56644d79 siguen pasando.
   - A7 (S5): T1 con generate_image llamado por el agente; la imagen queda en el hero y la aprobación se registra.
3. Medición: un T1 con Sonnet 5.5 high, mismo brief que 56644d79, al cerrar cada ola (gasto local, Orq).

Los umbrales y su fundamento están en arnes.md, sección "Fundamento de los umbrales". Los tiempos se registran como observación y no hacen fallar ningún caso.

## Terminado
El log del vite del preview existe para el próximo T1 y los casos A1-A6 están escritos con su forma de medir.
