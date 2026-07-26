import crypto from 'crypto';
import { env } from '../../config/env';
import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';

export type PriceAlertPushPayload = {
  alertId: string;
  exchange: string;
  symbol: string;
  quoteCurrency: string;
  condition: 'ABOVE' | 'BELOW';
  targetPrice: number;
  currentPrice: number;
};

export type FcmSendResult = {
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
};

type OAuthTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type FcmErrorResponse = {
  error?: {
    status?: string;
    message?: string;
    details?: Array<{ errorCode?: string }>;
  };
};

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

let initialized = false;
let credentialsReady = false;
let cachedAccessToken: { value: string; expiresAt: number } | null = null;

export function hashFcmToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

function maskedClientEmail() {
  const email = env.FIREBASE_CLIENT_EMAIL?.trim();
  if (!email) {
    return null;
  }
  const [name, domain] = email.split('@');
  return `${name.slice(0, 3)}***@${domain ?? 'unknown'}`;
}

export function initializeFcm() {
  if (initialized) {
    return;
  }
  initialized = true;

  if (!env.FCM_ENABLED) {
    logger.info({ domain: 'fcm', enabled: false }, '[FCM] initialized enabled=false');
    return;
  }

  credentialsReady = Boolean(
    env.FIREBASE_PROJECT_ID?.trim()
      && env.FIREBASE_CLIENT_EMAIL?.trim()
      && env.FIREBASE_PRIVATE_KEY?.trim(),
  );
  if (!credentialsReady) {
    logger.warn(
      {
        domain: 'fcm',
        enabled: false,
        reason: 'missing_firebase_admin_env',
        hasProjectId: Boolean(env.FIREBASE_PROJECT_ID),
        clientEmailMasked: maskedClientEmail(),
        hasPrivateKey: Boolean(env.FIREBASE_PRIVATE_KEY),
      },
      '[FCM] initialized enabled=false reason=missing_firebase_admin_env',
    );
    return;
  }

  logger.info(
    {
      domain: 'fcm',
      enabled: true,
      transport: 'http-v1',
      dryRun: env.FCM_DRY_RUN,
      clientEmailMasked: maskedClientEmail(),
    },
    `[FCM] initialized enabled=true transport=http-v1 dryRun=${env.FCM_DRY_RUN}`,
  );
}

export function isInvalidFcmTokenError(code?: string | null) {
  if (!code) {
    return false;
  }
  return [
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
    'UNREGISTERED',
    'INVALID_ARGUMENT',
  ].includes(code);
}

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString('base64url');
}

function createServiceAccountAssertion(nowSeconds: number) {
  const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new Error('FCM service account credentials are unavailable');
  }

  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: clientEmail,
    scope: FCM_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3_600,
  }));
  const unsignedAssertion = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsignedAssertion), privateKey);
  return `${unsignedAssertion}.${base64Url(signature)}`;
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt - TOKEN_EXPIRY_SKEW_MS > now) {
    return cachedAccessToken.value;
  }

  const assertion = createServiceAccountAssertion(Math.floor(now / 1_000));
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readJsonSafely(response) as OAuthTokenResponse;
  if (!response.ok || !payload.access_token) {
    throw Object.assign(new Error('FCM OAuth token request failed'), {
      code: payload.error || `HTTP_${response.status}`,
    });
  }

  const expiresInSeconds = Math.max(60, Number(payload.expires_in) || 3_600);
  cachedAccessToken = {
    value: payload.access_token,
    expiresAt: now + expiresInSeconds * 1_000,
  };
  return payload.access_token;
}

function formatPrice(value: number, quoteCurrency: string) {
  if (quoteCurrency === 'KRW') {
    return `₩${Math.round(value).toLocaleString('ko-KR')}`;
  }
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 8 })} BTC`;
}

function normalizeFcmError(payload: FcmErrorResponse, status: number) {
  return payload.error?.details
    ?.map((detail) => detail.errorCode)
    .find(Boolean)
    || payload.error?.status
    || `HTTP_${status}`;
}

export async function sendPriceAlertPush(token: string, payload: PriceAlertPushPayload): Promise<FcmSendResult> {
  const tokenHash = hashFcmToken(token);
  if (!env.FCM_ENABLED) {
    logger.info({ domain: 'fcm', alertId: payload.alertId, tokenHash }, '[FCM] send skipped enabled=false');
    return { status: 'SKIPPED', errorCode: 'FCM_DISABLED', errorMessage: 'FCM is disabled' };
  }

  initializeFcm();
  if (!credentialsReady || !env.FIREBASE_PROJECT_ID) {
    return {
      status: 'SKIPPED',
      errorCode: 'FCM_NOT_INITIALIZED',
      errorMessage: 'FCM HTTP v1 credentials are not initialized',
    };
  }

  const comparator = payload.condition === 'ABOVE' ? '이상' : '이하';
  const message = {
    token,
    notification: {
      title: `${payload.symbol} 가격 알림`,
      body: `${payload.symbol}가 ${formatPrice(payload.targetPrice, payload.quoteCurrency)} ${comparator}에 도달했습니다.`,
    },
    data: {
      type: 'PRICE_ALERT',
      alertId: payload.alertId,
      exchange: payload.exchange,
      symbol: payload.symbol,
      quoteCurrency: payload.quoteCurrency,
      condition: payload.condition,
      targetPrice: String(payload.targetPrice),
      currentPrice: String(payload.currentPrice),
    },
  };

  try {
    const accessToken = await getAccessToken();
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          validate_only: env.FCM_DRY_RUN,
          message,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const responsePayload = await readJsonSafely(response) as { name?: string } & FcmErrorResponse;
    if (!response.ok) {
      throw Object.assign(new Error('FCM HTTP v1 send failed'), {
        code: normalizeFcmError(responsePayload, response.status),
      });
    }

    logger.info(
      { domain: 'fcm', alertId: payload.alertId, tokenHash },
      `[FCM] send success alertId=${payload.alertId} tokenHash=${tokenHash}`,
    );
    return { status: 'SUCCESS', providerMessageId: responsePayload.name };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : 'FCM_SEND_FAILED';
    logger.warn(
      { domain: 'fcm', alertId: payload.alertId, tokenHash, code },
      `[FCM] send failed code=${code} tokenHash=${tokenHash}`,
    );
    return {
      status: 'FAILED',
      errorCode: code,
      errorMessage: 'FCM send failed',
    };
  }
}

export async function deactivateFcmTokenById(id: string, reason: string) {
  await prisma.fcmToken.updateMany({
    where: { id },
    data: { isActive: false },
  });
  logger.info({ domain: 'push-token', fcmTokenId: id, reason }, '[PushToken] deactivate invalid token');
}
