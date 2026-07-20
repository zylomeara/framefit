import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

export function encrypt(plaintext: string, hexKey: string, aad?: string): string {
  const key = Buffer.from(hexKey, 'hex');
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });

  if (aad) {
    cipher.setAAD(Buffer.from(aad, 'utf-8'));
  }

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const result = Buffer.concat([nonce, encrypted, tag]);
  return result.toString('base64');
}

export function decrypt(encoded: string, hexKey: string, aad?: string): string {
  const key = Buffer.from(hexKey, 'hex');
  const data = Buffer.from(encoded, 'base64');

  const nonce = data.subarray(0, NONCE_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const ciphertext = data.subarray(NONCE_LENGTH, data.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  if (aad) {
    decipher.setAAD(Buffer.from(aad, 'utf-8'));
  }

  return decipher.update(ciphertext) + decipher.final('utf-8');
}
