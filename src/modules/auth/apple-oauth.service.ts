import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  sign,
} from 'crypto';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const APPLE_TOKEN_HELP_URL = 'https://support.apple.com/102571';
const APPLE_OAUTH_TIMEOUT_MS = 5000;
const APPLE_CLIENT_SECRET_TTL_SECONDS = 5 * 60;
const ENCRYPTION_CONTEXT = 'cryptory:apple-refresh-token:v1';

type AppleStoredCredential = {
  refreshToken: string;
  clientId: string;
};

export type PreparedAppleRevocation =
  | { kind: 'not_applicable' }
  | { kind: 'manual_required'; reason: string }
  | { kind: 'ready'; credential: AppleStoredCredential };

export type AppleRevocationResult = {
  appleRevocationStatus: 'revoked' | 'not_applicable' | 'manual_required';
  appleRevocationReason?: string;
  appleRevocationHelpUrl?: string;
};

function normalizePrivateKey(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/\\n/g, '\n');
}

function resolveClientId(tokenAudience?: string | string[]) {
  const audiences = Array.isArray(tokenAudience)
    ? tokenAudience
    : tokenAudience
      ? [tokenAudience]
      : [];
  return audiences.find((audience) => env.APPLE_CLIENT_IDS.includes(audience))
    ?? env.APPLE_CLIENT_ID
    ?? env.APPLE_CLIENT_IDS[0];
}

function getAppleOAuthConfiguration(clientId: string | undefined) {
  if (!clientId || !env.APPLE_TEAM_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY) {
    return null;
  }
  return {
    clientId,
    teamId: env.APPLE_TEAM_ID,
    keyId: env.APPLE_KEY_ID,
    privateKey: normalizePrivateKey(env.APPLE_PRIVATE_KEY),
  };
}

function encodeJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createAppleClientSecret(config: NonNullable<ReturnType<typeof getAppleOAuthConfiguration>>) {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: 'ES256', kid: config.keyId, typ: 'JWT' });
  const payload = encodeJson({
    iss: config.teamId,
    iat: now,
    exp: now + APPLE_CLIENT_SECRET_TTL_SECONDS,
    aud: 'https://appleid.apple.com',
    sub: config.clientId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: config.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

function credentialEncryptionKey() {
  return createHash('sha256').update(`${env.JWT_SECRET}:${ENCRYPTION_CONTEXT}`).digest();
}

function encryptCredential(credential: AppleStoredCredential) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function decryptCredential(encrypted: string): AppleStoredCredential {
  const [version, ivValue, tagValue, ciphertextValue] = encrypted.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('APPLE_REFRESH_TOKEN_FORMAT_INVALID');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    credentialEncryptionKey(),
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  const credential = JSON.parse(plaintext) as Partial<AppleStoredCredential>;
  if (!credential.refreshToken || !credential.clientId) {
    throw new Error('APPLE_REFRESH_TOKEN_PAYLOAD_INVALID');
  }
  return {
    refreshToken: credential.refreshToken,
    clientId: credential.clientId,
  };
}

async function postToApple(url: string, body: URLSearchParams) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPLE_OAUTH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeAuthorizationCode(params: { authorizationCode: string; clientId: string }) {
  const config = getAppleOAuthConfiguration(params.clientId);
  if (!config) {
    throw new Error('APPLE_OAUTH_CONFIGURATION_UNAVAILABLE');
  }
  const response = await postToApple(APPLE_TOKEN_URL, new URLSearchParams({
    client_id: config.clientId,
    client_secret: createAppleClientSecret(config),
    code: params.authorizationCode,
    grant_type: 'authorization_code',
  }));
  if (!response.ok) {
    throw new Error(`APPLE_AUTHORIZATION_CODE_EXCHANGE_FAILED_${response.status}`);
  }
  const payload = await response.json() as { refresh_token?: unknown };
  if (typeof payload.refresh_token !== 'string' || !payload.refresh_token) {
    throw new Error('APPLE_REFRESH_TOKEN_UNAVAILABLE');
  }
  return payload.refresh_token;
}

export async function captureAppleRefreshToken(params: {
  userId: string;
  authorizationCode?: string;
  tokenAudience?: string | string[];
}) {
  if (!params.authorizationCode) {
    return { captured: false, reason: 'authorization_code_unavailable' } as const;
  }
  const clientId = resolveClientId(params.tokenAudience);
  if (!clientId) {
    return { captured: false, reason: 'client_id_unavailable' } as const;
  }
  try {
    const refreshToken = await exchangeAuthorizationCode({
      authorizationCode: params.authorizationCode,
      clientId,
    });
    const result = await prisma.authIdentity.updateMany({
      where: { userId: params.userId, provider: 'apple' },
      data: {
        providerRefreshTokenEncrypted: encryptCredential({ refreshToken, clientId }),
        providerTokenUpdatedAt: new Date(),
      },
    });
    if (result.count < 1) {
      logger.warn(
        { domain: 'auth', provider: 'apple', action: 'refresh_token_capture', reason: 'identity_not_found' },
        '[AppleOAuth] action=refresh_token_capture outcome=skipped reason=identity_not_found',
      );
      return { captured: false, reason: 'identity_not_found' } as const;
    }
    return { captured: true } as const;
  } catch (error) {
    logger.warn(
      { domain: 'auth', provider: 'apple', action: 'refresh_token_capture', err: error },
      '[AppleOAuth] action=refresh_token_capture outcome=failed',
    );
    return { captured: false, reason: 'exchange_failed' } as const;
  }
}

export async function prepareAppleRevocationForUser(userId: string): Promise<PreparedAppleRevocation> {
  const identity = await prisma.authIdentity.findFirst({
    where: { userId, provider: 'apple' },
    select: { providerRefreshTokenEncrypted: true },
  });
  if (!identity) {
    return { kind: 'not_applicable' };
  }
  if (!identity.providerRefreshTokenEncrypted) {
    return { kind: 'manual_required', reason: 'refresh_token_unavailable' };
  }
  try {
    const credential = decryptCredential(identity.providerRefreshTokenEncrypted);
    if (!getAppleOAuthConfiguration(credential.clientId)) {
      return { kind: 'manual_required', reason: 'oauth_configuration_unavailable' };
    }
    return { kind: 'ready', credential };
  } catch (error) {
    logger.warn(
      { domain: 'auth', provider: 'apple', action: 'prepare_revocation', err: error },
      '[AppleOAuth] action=prepare_revocation outcome=failed',
    );
    return { kind: 'manual_required', reason: 'refresh_token_unreadable' };
  }
}

function manualRevocationResult(reason: string): AppleRevocationResult {
  return {
    appleRevocationStatus: 'manual_required',
    appleRevocationReason: reason,
    appleRevocationHelpUrl: APPLE_TOKEN_HELP_URL,
  };
}

export async function revokePreparedAppleAuthorization(
  prepared: PreparedAppleRevocation,
): Promise<AppleRevocationResult> {
  if (prepared.kind === 'not_applicable') {
    return { appleRevocationStatus: 'not_applicable' };
  }
  if (prepared.kind === 'manual_required') {
    return manualRevocationResult(prepared.reason);
  }

  const config = getAppleOAuthConfiguration(prepared.credential.clientId);
  if (!config) {
    return manualRevocationResult('oauth_configuration_unavailable');
  }
  try {
    const response = await postToApple(APPLE_REVOKE_URL, new URLSearchParams({
      client_id: config.clientId,
      client_secret: createAppleClientSecret(config),
      token: prepared.credential.refreshToken,
      token_type_hint: 'refresh_token',
    }));
    if (!response.ok) {
      throw new Error(`APPLE_TOKEN_REVOCATION_FAILED_${response.status}`);
    }
    return { appleRevocationStatus: 'revoked' };
  } catch (error) {
    logger.warn(
      { domain: 'auth', provider: 'apple', action: 'revoke_authorization', err: error },
      '[AppleOAuth] action=revoke_authorization outcome=failed',
    );
    return manualRevocationResult('revocation_failed');
  }
}
