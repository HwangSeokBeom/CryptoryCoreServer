import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, maskSecret } from '../src/modules/private-account/exchange-connections.crypto';

describe('Exchange Connection Encryption', () => {
  it('round-trips encrypted credentials without exposing plaintext', () => {
    const secret = 'test-exchange-secret-key';
    const encrypted = encryptSecret(secret);

    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it('masks sensitive values for DTO exposure', () => {
    expect(maskSecret('abcdefghijk')).toBe('abc*****ijk');
    expect(maskSecret('abc')).toBe('***');
  });
});
