import pino from 'pino';
import { sanitizeSensitiveText } from '../domains/security/credential-security.service';

const DEFAULT_LOG_ARRAY_MAX = 20;
const DEFAULT_LOG_ARRAY_TRUNCATE_THRESHOLD = 30;

export function truncateForLog<T>(
  items: readonly T[] | undefined,
  max = DEFAULT_LOG_ARRAY_MAX,
  threshold = DEFAULT_LOG_ARRAY_TRUNCATE_THRESHOLD,
) {
  const values = Array.isArray(items) ? [...items] : [];
  if (values.length <= threshold) {
    return values;
  }

  return {
    count: values.length,
    items: values.slice(0, max),
    omittedCount: Math.max(values.length - max, 0),
  };
}

export function summarizeListForLog<T>(items: readonly T[] | undefined, max = DEFAULT_LOG_ARRAY_MAX) {
  const values = Array.isArray(items) ? [...items] : [];
  return {
    count: values.length,
    sample: values.slice(0, max),
    omittedCount: Math.max(values.length - max, 0),
  };
}

function serializeError(error: unknown) {
  if (!(error instanceof Error)) {
    return error;
  }

  const serialized: Record<string, unknown> = {
    type: error.name,
    message: sanitizeSensitiveText(error.message),
    stack: sanitizeSensitiveText(error.stack),
  };

  if ('exchange' in error) {
    serialized.exchange = (error as { exchange?: unknown }).exchange;
  }
  if ('capability' in error) {
    serialized.capability = (error as { capability?: unknown }).capability;
  }
  if ('statusCode' in error) {
    serialized.statusCode = (error as { statusCode?: unknown }).statusCode;
  }
  if ('requestUrl' in error) {
    serialized.requestUrl = sanitizeSensitiveText(String((error as { requestUrl?: unknown }).requestUrl ?? ''));
  }
  if ('kind' in error) {
    serialized.kind = (error as { kind?: unknown }).kind;
  }
  if ('symbol' in error) {
    serialized.symbol = (error as { symbol?: unknown }).symbol;
  }

  return serialized;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  serializers: {
    err: serializeError,
    error: serializeError,
  },
  redact: {
    paths: [
      'apiKey',
      'accessKey',
      'secretKey',
      'accessToken',
      'passphrase',
      'password',
      'privateKey',
      'private_key',
      'clientEmail',
      'client_email',
      'token',
      'fcmToken',
      'jwtToken',
      'idToken',
      'identityToken',
      'authorizationCode',
      'refreshToken',
      'jwtSecret',
      'authorization',
      'authorizationHeader',
      'signature',
      'nonce',
      'headers.authorization',
      'headers.Authorization',
      'headers.X-MBX-APIKEY',
      'headers.X-KAPI-KEY',
      'headers.X-CMC_PRO_API_KEY',
      'headers.x-cmc_pro_api_key',
      'headers.X-COINONE-PAYLOAD',
      'headers.X-COINONE-SIGNATURE',
      '*.apiKey',
      '*.accessKey',
      '*.secretKey',
      '*.accessToken',
      '*.passphrase',
      '*.password',
      '*.privateKey',
      '*.private_key',
      '*.clientEmail',
      '*.client_email',
      '*.token',
      '*.fcmToken',
      '*.jwtToken',
      '*.idToken',
      '*.identityToken',
      '*.authorizationCode',
      '*.refreshToken',
      '*.authorization',
      '*.Authorization',
      '*.authorizationHeader',
      '*.signature',
      '*.nonce',
      'body.apiKey',
      'body.accessKey',
      'body.secretKey',
      'body.accessToken',
      'body.idToken',
      'body.identityToken',
      'body.authorizationCode',
      'body.refreshToken',
      'body.passphrase',
      'body.password',
      'body.privateKey',
      'body.private_key',
      'body.clientEmail',
      'body.client_email',
      'body.fcmToken',
      'body.jwtToken',
      'req.headers.authorization',
      'req.headers.Authorization',
      'req.headers.X-CMC_PRO_API_KEY',
      'req.headers.x-cmc_pro_api_key',
      'request.headers.authorization',
      'request.headers.Authorization',
      'request.headers.X-CMC_PRO_API_KEY',
      'request.headers.x-cmc_pro_api_key',
    ],
    censor: '[REDACTED]',
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
