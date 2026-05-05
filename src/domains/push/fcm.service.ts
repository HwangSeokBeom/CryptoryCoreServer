import crypto from 'crypto';
import admin from 'firebase-admin';
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

let initialized = false;

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

  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
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

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  }

  logger.info(
    { domain: 'fcm', enabled: true, dryRun: env.FCM_DRY_RUN, clientEmailMasked: maskedClientEmail() },
    `[FCM] initialized enabled=true dryRun=${env.FCM_DRY_RUN}`,
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
  ].includes(code);
}

function formatPrice(value: number, quoteCurrency: string) {
  if (quoteCurrency === 'KRW') {
    return `₩${Math.round(value).toLocaleString('ko-KR')}`;
  }
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 8 })} BTC`;
}

export async function sendPriceAlertPush(token: string, payload: PriceAlertPushPayload): Promise<FcmSendResult> {
  const tokenHash = hashFcmToken(token);
  if (!env.FCM_ENABLED) {
    logger.info({ domain: 'fcm', alertId: payload.alertId, tokenHash }, '[FCM] send skipped enabled=false');
    return { status: 'SKIPPED', errorCode: 'FCM_DISABLED', errorMessage: 'FCM is disabled' };
  }

  if (admin.apps.length === 0) {
    initializeFcm();
  }
  if (admin.apps.length === 0) {
    return { status: 'SKIPPED', errorCode: 'FCM_NOT_INITIALIZED', errorMessage: 'Firebase Admin SDK is not initialized' };
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
    const providerMessageId = await admin.messaging().send(message, env.FCM_DRY_RUN);
    logger.info({ domain: 'fcm', alertId: payload.alertId, tokenHash }, '[FCM] send success alertId=' + payload.alertId + ' tokenHash=' + tokenHash);
    return { status: 'SUCCESS', providerMessageId };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : 'FCM_SEND_FAILED';
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
      { domain: 'fcm', alertId: payload.alertId, tokenHash, code, err: error },
      `[FCM] send failed code=${code} tokenHash=${tokenHash}`,
    );
    return { status: 'FAILED', errorCode: code, errorMessage };
  }
}

export async function deactivateFcmTokenById(id: string, reason: string) {
  await prisma.fcmToken.updateMany({
    where: { id },
    data: { isActive: false },
  });
  logger.info({ domain: 'push-token', fcmTokenId: id, reason }, '[PushToken] deactivate invalid token');
}
