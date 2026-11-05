// Parseo de una llave pública Ed25519 desde un env, compartido por signed-verifier (identidad) y serve (preview). La VM
// solo recibe la pública (deploy-sandbox.md §4): este helper rechaza una privada y cualquier curva que no sea Ed25519.

import { createPublicKey, type KeyObject } from 'node:crypto';

/** PEM de una pública Ed25519, con los saltos como "\n" literal de un env de una línea. `label` nombra la var en los
 *  errores. Lanza si viene vacía, si trae una privada o si no es Ed25519 pública. */
export function parsePublicKeyPem(raw: string | undefined, label: string): KeyObject {
  const pem = raw?.replace(/\\n/g, '\n').trim();
  if (!pem) throw new Error(`${label} vacío: falta el PEM de la llave pública Ed25519`);
  // createPublicKey deriva la pública de una privada: aceptarla dejaría la privada dentro de la VM, justo lo que §4 evita.
  if (/-----BEGIN [A-Z ]*PRIVATE/.test(pem)) throw new Error(`${label} trae una llave privada; la VM solo recibe la pública`);
  let key: KeyObject;
  try { key = createPublicKey(pem); } catch { throw new Error(`${label} no es un PEM público válido`); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${label} debe ser Ed25519`);
  return key;
}
