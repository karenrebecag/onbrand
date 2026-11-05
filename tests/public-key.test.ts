// parsePublicKeyPem: el helper común de signed-verifier (identidad) y serve (preview). La VM solo recibe la pública:
// rechaza una privada, una cadena vacía y una curva que no sea Ed25519; acepta el PEM con "\n" literal de un env.
import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { parsePublicKeyPem } from '../src/runtime/public-key';

const ed = generateKeyPairSync('ed25519');
const pub = ed.publicKey.export({ type: 'spki', format: 'pem' }).toString();

test('acepta una pública Ed25519, incluso con los saltos como "\\n" literal', () => {
  expect(parsePublicKeyPem(pub, 'K').asymmetricKeyType).toBe('ed25519');
  expect(parsePublicKeyPem(pub.replace(/\n/g, '\\n'), 'K').asymmetricKeyType).toBe('ed25519');
});

test('rechaza una llave privada, una cadena vacía y otra curva, nombrando la var', () => {
  const priv = ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  expect(() => parsePublicKeyPem(priv, 'K')).toThrow('privada');
  expect(() => parsePublicKeyPem('', 'K')).toThrow('K');
  expect(() => parsePublicKeyPem(undefined, 'K')).toThrow('K');
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  expect(() => parsePublicKeyPem(ec, 'K')).toThrow('Ed25519');
});
