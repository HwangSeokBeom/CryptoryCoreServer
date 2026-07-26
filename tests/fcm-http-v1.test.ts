import { generateKeyPairSync, verify } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const payload = {
  alertId: 'alert-test-1',
  exchange: 'upbit',
  symbol: 'BTC',
  quoteCurrency: 'KRW',
  condition: 'ABOVE' as const,
  targetPrice: 100_000_000,
  currentPrice: 100_100_000,
};

beforeEach(() => {
  vi.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'test-jwt-secret',
    NODE_ENV: 'test',
    FCM_ENABLED: 'true',
    FCM_DRY_RUN: 'true',
    FIREBASE_PROJECT_ID: 'cryptory-test',
    FIREBASE_CLIENT_EMAIL: 'firebase@example.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FCM HTTP v1 transport', () => {
  it('mints one OAuth token, sends validate_only, and reuses the cached token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'oauth-access-token-sentinel',
        expires_in: 3_600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: 'projects/cryptory-test/messages/message-1',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: 'projects/cryptory-test/messages/message-2',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { sendPriceAlertPush } = await import('../src/domains/push/fcm.service');
    const first = await sendPriceAlertPush('device-token-sentinel', payload);
    const second = await sendPriceAlertPush('device-token-sentinel', payload);

    expect(first).toMatchObject({
      status: 'SUCCESS',
      providerMessageId: 'projects/cryptory-test/messages/message-1',
    });
    expect(second.status).toBe('SUCCESS');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const oauthRequest = fetchMock.mock.calls[0];
    expect(oauthRequest[0]).toBe('https://oauth2.googleapis.com/token');
    const oauthBody = new URLSearchParams(String(oauthRequest[1]?.body));
    expect(oauthBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = oauthBody.get('assertion');
    expect(assertion).toBeTruthy();
    expect(assertion).not.toContain(privateKey);
    const [headerPart, claimsPart, signaturePart] = assertion!.split('.');
    expect(JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8'));
    expect(claims).toMatchObject({
      iss: 'firebase@example.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
    });
    expect(claims.exp - claims.iat).toBe(3_600);
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${headerPart}.${claimsPart}`),
        publicKey,
        Buffer.from(signaturePart, 'base64url'),
      ),
    ).toBe(true);

    const sendRequest = fetchMock.mock.calls[1];
    expect(sendRequest[0]).toBe('https://fcm.googleapis.com/v1/projects/cryptory-test/messages:send');
    const sendBody = JSON.parse(String(sendRequest[1]?.body));
    expect(sendBody).toMatchObject({
      validate_only: true,
      message: {
        token: 'device-token-sentinel',
        data: {
          type: 'PRICE_ALERT',
          alertId: 'alert-test-1',
        },
      },
    });
    expect(sendRequest[1]?.headers).toMatchObject({
      authorization: 'Bearer oauth-access-token-sentinel',
    });
  });

  it('maps an unregistered HTTP v1 token error without logging credentials', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'oauth-token-private',
        expires_in: 3_600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          status: 'NOT_FOUND',
          message: 'Requested entity was not found.',
          details: [{ errorCode: 'UNREGISTERED' }],
        },
      }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const { logger } = await import('../src/utils/logger');
    const warningSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { isInvalidFcmTokenError, sendPriceAlertPush } = await import('../src/domains/push/fcm.service');
    const result = await sendPriceAlertPush('device-token-private', payload);

    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'UNREGISTERED' });
    expect(isInvalidFcmTokenError(result.errorCode)).toBe(true);
    const serialized = JSON.stringify(warningSpy.mock.calls);
    expect(serialized).not.toContain('device-token-private');
    expect(serialized).not.toContain('oauth-token-private');
    expect(serialized).not.toContain(privateKey);
  });

  it('returns a stable failure without exposing OAuth response details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'private provider detail',
    }), { status: 400 })));

    const { sendPriceAlertPush } = await import('../src/domains/push/fcm.service');
    const result = await sendPriceAlertPush('device-token-private', payload);

    expect(result).toEqual({
      status: 'FAILED',
      errorCode: 'invalid_grant',
      errorMessage: 'FCM send failed',
    });
    expect(JSON.stringify(result)).not.toContain('private provider detail');
  });
});
