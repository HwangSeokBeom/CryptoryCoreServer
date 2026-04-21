import pino from 'pino';

function serializeError(error: unknown) {
  if (!(error instanceof Error)) {
    return error;
  }

  const serialized: Record<string, unknown> = {
    type: error.name,
    message: error.message,
    stack: error.stack,
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
    serialized.requestUrl = (error as { requestUrl?: unknown }).requestUrl;
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
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  serializers: {
    err: serializeError,
    error: serializeError,
  },
  redact: {
    paths: [
      'apiKey',
      'secretKey',
      'accessToken',
      'passphrase',
      'token',
      'jwtSecret',
      'authorization',
      'headers.authorization',
      'headers.Authorization',
      'headers.X-MBX-APIKEY',
      'headers.X-KAPI-KEY',
      'headers.X-COINONE-PAYLOAD',
      'headers.X-COINONE-SIGNATURE',
      '*.apiKey',
      '*.secretKey',
      '*.accessToken',
      '*.passphrase',
      '*.token',
      '*.authorization',
      '*.Authorization',
      '*.signature',
    ],
    censor: '[REDACTED]',
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
