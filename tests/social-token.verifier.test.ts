import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';

const googleAudience = '142113558371-t5s22ri6gjl5aur76s81910gf2hb8p09.apps.googleusercontent.com';
const appleAudience = 'com.hwb.Cryptory';

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createSignedJwt(payload: Record<string, unknown>) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-id';
  const header = base64UrlJson({ alg: 'RS256', kid, typ: 'JWT' });
  const body = base64UrlJson({
    sub: 'provider-user-1',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...payload,
  });
  const signingInput = `${header}.${body}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  const jwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    kid,
    alg: 'RS256',
    use: 'sig',
  };

  return {
    token: `${signingInput}.${signature}`,
    jwk,
  };
}

async function loadVerifier(keys: Record<string, unknown>[]) {
  vi.resetModules();
  vi.doMock('../src/config/env', () => ({
    env: {
      GOOGLE_CLIENT_IDS: [googleAudience],
      APPLE_CLIENT_IDS: [appleAudience],
    },
  }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ keys }),
  }));
  return import('../src/modules/auth/social-token.verifier');
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/env');
});

describe('social token verifier', () => {
  it('verifies a signed Google ID token with the configured iOS audience', async () => {
    const { token, jwk } = createSignedJwt({
      iss: 'https://accounts.google.com',
      aud: googleAudience,
      email: 'user@example.com',
      email_verified: true,
      name: 'Google User',
    });
    const { verifyGoogleIdToken } = await loadVerifier([jwk]);

    await expect(verifyGoogleIdToken(token)).resolves.toMatchObject({
      provider: 'google',
      sub: 'provider-user-1',
      email: 'user@example.com',
      emailVerified: true,
      name: 'Google User',
    });
  });

  it('rejects a Google ID token audience mismatch with 403', async () => {
    const { token, jwk } = createSignedJwt({
      iss: 'https://accounts.google.com',
      aud: 'other-client-id',
      email: 'user@example.com',
      email_verified: true,
    });
    const { verifyGoogleIdToken } = await loadVerifier([jwk]);

    await expect(verifyGoogleIdToken(token)).rejects.toMatchObject({
      statusCode: 403,
      code: 'SOCIAL_TOKEN_INVALID_AUDIENCE',
    });
  });

  it('rejects a Google ID token without verified email with 403', async () => {
    const { token, jwk } = createSignedJwt({
      iss: 'https://accounts.google.com',
      aud: googleAudience,
      email: 'user@example.com',
      email_verified: false,
    });
    const { verifyGoogleIdToken } = await loadVerifier([jwk]);

    await expect(verifyGoogleIdToken(token)).rejects.toMatchObject({
      statusCode: 403,
      code: 'GOOGLE_EMAIL_NOT_VERIFIED',
    });
  });

  it('verifies a signed Apple identity token with the configured bundle id audience', async () => {
    const { token, jwk } = createSignedJwt({
      iss: 'https://appleid.apple.com',
      aud: appleAudience,
      email: 'apple@example.com',
      email_verified: 'true',
    });
    const { verifyAppleIdentityToken } = await loadVerifier([jwk]);

    await expect(verifyAppleIdentityToken(token)).resolves.toMatchObject({
      provider: 'apple',
      sub: 'provider-user-1',
      email: 'apple@example.com',
      emailVerified: true,
    });
  });

  it('verifies an Apple identity token without email for re-login and App Review accounts', async () => {
    const { token, jwk } = createSignedJwt({
      iss: 'https://appleid.apple.com',
      aud: appleAudience,
    });
    const { verifyAppleIdentityToken } = await loadVerifier([jwk]);

    await expect(verifyAppleIdentityToken(token)).resolves.toMatchObject({
      provider: 'apple',
      sub: 'provider-user-1',
      aud: appleAudience,
      email: undefined,
      emailVerified: false,
    });
  });

  it('extracts Apple login trace fields without requiring token verification', async () => {
    const { token } = createSignedJwt({
      iss: 'https://appleid.apple.com',
      aud: appleAudience,
      email: 'reviewer@privaterelay.appleid.com',
      email_verified: 'true',
    });
    const { inspectAppleIdentityTokenForLogging } = await loadVerifier([]);

    expect(inspectAppleIdentityTokenForLogging(token)).toMatchObject({
      hasIdentityToken: true,
      aud: [appleAudience],
      hasSub: true,
      hasEmail: true,
      isPrivateRelay: true,
      iss: 'https://appleid.apple.com',
    });
  });

  it('rejects an Apple identity token audience mismatch with 403', async () => {
    const { token, jwk } = createSignedJwt({
      iss: 'https://appleid.apple.com',
      aud: 'wrong.bundle.id',
    });
    const { verifyAppleIdentityToken } = await loadVerifier([jwk]);

    await expect(verifyAppleIdentityToken(token)).rejects.toMatchObject({
      statusCode: 403,
      code: 'SOCIAL_TOKEN_INVALID_AUDIENCE',
    });
  });
});
