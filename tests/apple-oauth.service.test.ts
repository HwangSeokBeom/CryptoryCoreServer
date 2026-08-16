import { generateKeyPairSync } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, envMock, fetchMock } = vi.hoisted(() => ({
  prismaMock: {
    authIdentity: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
  envMock: {
    JWT_SECRET: 'apple-oauth-test-encryption-secret',
    APPLE_CLIENT_ID: 'com.hwb.Cryptory',
    APPLE_CLIENT_IDS: ['com.hwb.Cryptory'],
    APPLE_TEAM_ID: 'TEAMID1234',
    APPLE_KEY_ID: 'KEYID12345',
    APPLE_PRIVATE_KEY: '',
  },
  fetchMock: vi.fn(),
}));

vi.mock('../src/config/database', () => ({ prisma: prismaMock }));
vi.mock('../src/config/env', () => ({ env: envMock }));

import {
  captureAppleRefreshToken,
  prepareAppleRevocationForUser,
  revokePreparedAppleAuthorization,
} from '../src/modules/auth/apple-oauth.service';

describe('Apple OAuth account-deletion grant lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    envMock.APPLE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    prismaMock.authIdentity.updateMany.mockResolvedValue({ count: 1 });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('exchanges the one-time code and stores only an encrypted refresh credential', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ refresh_token: 'apple-refresh-secret' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await captureAppleRefreshToken({
      userId: 'apple-user-1',
      authorizationCode: 'one-time-authorization-code',
      tokenAudience: 'com.hwb.Cryptory',
    });

    expect(result).toEqual({ captured: true });
    const update = prismaMock.authIdentity.updateMany.mock.calls[0][0];
    const encrypted = update.data.providerRefreshTokenEncrypted as string;
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain('apple-refresh-secret');
    expect(update.where).toEqual({ userId: 'apple-user-1', provider: 'apple' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://appleid.apple.com/auth/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('decrypts the stored credential and revokes the Apple authorization', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ refresh_token: 'apple-refresh-secret' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await captureAppleRefreshToken({
      userId: 'apple-user-2',
      authorizationCode: 'one-time-authorization-code',
      tokenAudience: 'com.hwb.Cryptory',
    });
    const encrypted = prismaMock.authIdentity.updateMany.mock.calls[0][0]
      .data.providerRefreshTokenEncrypted as string;
    prismaMock.authIdentity.findFirst.mockResolvedValueOnce({
      providerRefreshTokenEncrypted: encrypted,
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const prepared = await prepareAppleRevocationForUser('apple-user-2');
    const result = await revokePreparedAppleAuthorization(prepared);

    expect(prepared.kind).toBe('ready');
    expect(result).toEqual({ appleRevocationStatus: 'revoked' });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://appleid.apple.com/auth/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns manual guidance for a legacy Apple identity without a stored token', async () => {
    prismaMock.authIdentity.findFirst.mockResolvedValueOnce({
      providerRefreshTokenEncrypted: null,
    });

    const prepared = await prepareAppleRevocationForUser('legacy-apple-user');
    const result = await revokePreparedAppleAuthorization(prepared);

    expect(result).toEqual({
      appleRevocationStatus: 'manual_required',
      appleRevocationReason: 'refresh_token_unavailable',
      appleRevocationHelpUrl: 'https://support.apple.com/102571',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not attempt Apple revocation for a non-Apple account', async () => {
    prismaMock.authIdentity.findFirst.mockResolvedValueOnce(null);

    const prepared = await prepareAppleRevocationForUser('email-user');
    const result = await revokePreparedAppleAuthorization(prepared);

    expect(result).toEqual({ appleRevocationStatus: 'not_applicable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
