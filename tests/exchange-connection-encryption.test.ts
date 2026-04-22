import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://cryptory:cryptory@localhost:5432/cryptory';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SECRET ??= 'super-secret-jwt-value';
process.env.NODE_ENV ??= 'test';
process.env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY ??= 'test-exchange-credential-encryption-key-32';

describe('Exchange Connection Encryption', () => {
  it('round-trips encrypted credentials without exposing plaintext', async () => {
    const { decryptSecret, encryptSecret } = await import('../src/modules/private-account/exchange-connections.crypto');
    const secret = 'test-exchange-secret-key';
    const encrypted = encryptSecret(secret);

    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it('creates stable keyed fingerprints without storing the access key', async () => {
    const { createFingerprint } = await import('../src/modules/private-account/exchange-connections.crypto');

    expect(createFingerprint('access-key-1')).toBe(createFingerprint('access-key-1'));
    expect(createFingerprint('access-key-1')).not.toContain('access-key-1');
    expect(createFingerprint('access-key-1')).not.toBe(createFingerprint('access-key-2'));
  });

  it('masks sensitive values for DTO exposure', async () => {
    const { maskSecret } = await import('../src/modules/private-account/exchange-connections.crypto');

    expect(maskSecret('abcdefghijk')).toBe('abc*****ijk');
    expect(maskSecret('abc')).toBe('***');
  });
});
