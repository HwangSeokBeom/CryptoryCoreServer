import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';
import { env } from '../../config/env';

const AES_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_ENVELOPE_VERSION = 'v1';
const MIN_KEY_MATERIAL_LENGTH = 32;

const SENSITIVE_KEY_PATTERN =
  /(api[-_ ]?key|access[-_ ]?key|secret|token|passphrase|authorization|signature|query[-_ ]?hash|nonce)/i;

function getEncryptionKeyMaterial() {
  const keyMaterial = env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY ?? env.EXCHANGE_CONNECTION_ENCRYPTION_KEY;
  if (!keyMaterial) {
    throw new Error('EXCHANGE_CREDENTIAL_ENCRYPTION_KEY is required for exchange credential encryption');
  }

  if (keyMaterial.length < MIN_KEY_MATERIAL_LENGTH) {
    throw new Error('EXCHANGE_CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters');
  }

  if (env.NODE_ENV === 'production' && /replace-with|changeme|default/i.test(keyMaterial)) {
    throw new Error('EXCHANGE_CREDENTIAL_ENCRYPTION_KEY must be set to a production secret');
  }

  return keyMaterial;
}

function getEncryptionKey() {
  return createHash('sha256').update(getEncryptionKeyMaterial()).digest();
}

export function encryptSensitiveValue(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENCRYPTION_ENVELOPE_VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

export function decryptSensitiveValue(value: string): string {
  const parts = value.split('.');
  const [ivEncoded, authTagEncoded, encryptedEncoded] =
    parts[0] === ENCRYPTION_ENVELOPE_VERSION
      ? parts.slice(1)
      : parts;

  if (!ivEncoded || !authTagEncoded || !encryptedEncoded) {
    throw new Error('Invalid encrypted credential envelope');
  }

  const decipher = createDecipheriv(AES_ALGORITHM, getEncryptionKey(), Buffer.from(ivEncoded, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagEncoded, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, 'base64')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

export function createSensitiveFingerprint(value: string): string {
  return createHmac('sha256', getEncryptionKey())
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function maskSensitiveValue(value: string): string {
  if (value.length <= 6) {
    return '*'.repeat(value.length);
  }

  return `${value.slice(0, 3)}${'*'.repeat(Math.max(value.length - 6, 4))}${value.slice(-3)}`;
}

export function sanitizeSensitiveText(value: string | null | undefined) {
  if (!value) {
    return value ?? null;
  }

  return value
    .replace(/(Bearer\s+)[A-Za-z0-9\-_.=+/]+/gi, '$1[REDACTED]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?key|secret[-_ ]?key|token|authorization|signature|nonce)["'\s:=]+)[^"',\s}]+/gi, '$1[REDACTED]')
    .replace(/([A-Za-z0-9]{3})[A-Za-z0-9_\-]{14,}([A-Za-z0-9]{3})/g, '$1***$2');
}

function sanitizeSensitiveEntry(key: string, value: unknown): unknown {
  const normalizedKey = key.toLowerCase();

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSensitiveEntry(key, item));
  }

  if (value && typeof value === 'object') {
    return sanitizeSensitiveDetails(value as Record<string, unknown>);
  }

  if (typeof value === 'string' && SENSITIVE_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }

  if (
    typeof value === 'string'
    && (
      normalizedKey.includes('message')
      || normalizedKey.includes('error')
      || normalizedKey.includes('reason')
      || normalizedKey === 'raw'
    )
  ) {
    return sanitizeSensitiveText(value);
  }

  return value;
}

export function sanitizeSensitiveDetails(
  details: Record<string, unknown> | undefined | null,
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, sanitizeSensitiveEntry(key, value)]),
  );
}
