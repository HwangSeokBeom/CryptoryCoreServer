import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env } from '../../config/env';

const AES_ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
  const baseSecret =
    env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY ??
    env.EXCHANGE_CONNECTION_ENCRYPTION_KEY ??
    env.JWT_SECRET;
  return createHash('sha256').update(baseSecret).digest();
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(value: string): string {
  const [ivEncoded, authTagEncoded, encryptedEncoded] = value.split('.');
  const decipher = createDecipheriv(AES_ALGORITHM, getEncryptionKey(), Buffer.from(ivEncoded, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagEncoded, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, 'base64')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

export function maskSecret(value: string): string {
  if (value.length <= 6) {
    return '*'.repeat(value.length);
  }

  return `${value.slice(0, 3)}${'*'.repeat(Math.max(value.length - 6, 4))}${value.slice(-3)}`;
}
