import { env } from './env';
import type { ExchangeId, UserExchangeCredentials } from '../core/exchange/exchange.types';
import { ExchangeAuthError } from '../core/exchange/errors';

type ExchangeCredentialEnvConfig = {
  apiKeyEnvName: string;
  secretKeyEnvName: string;
  apiKey?: string;
  secretKey?: string;
};

export type ExchangeCredentialSource = 'user_connection' | 'server_env';

function normalizeEnvValue(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getExchangeCredentialEnvConfig(exchange: ExchangeId): ExchangeCredentialEnvConfig {
  switch (exchange) {
    case 'upbit':
      return {
        apiKeyEnvName: 'UPBIT_ACCESS_KEY',
        secretKeyEnvName: 'UPBIT_SECRET_KEY',
        apiKey: normalizeEnvValue(env.UPBIT_ACCESS_KEY),
        secretKey: normalizeEnvValue(env.UPBIT_SECRET_KEY),
      };
    case 'bithumb':
      return {
        apiKeyEnvName: 'BITHUMB_API_KEY',
        secretKeyEnvName: 'BITHUMB_SECRET_KEY',
        apiKey: normalizeEnvValue(env.BITHUMB_API_KEY),
        secretKey: normalizeEnvValue(env.BITHUMB_SECRET_KEY),
      };
    case 'coinone':
      return {
        apiKeyEnvName: 'COINONE_ACCESS_TOKEN',
        secretKeyEnvName: 'COINONE_SECRET_KEY',
        apiKey: normalizeEnvValue(env.COINONE_ACCESS_TOKEN),
        secretKey: normalizeEnvValue(env.COINONE_SECRET_KEY),
      };
    case 'korbit':
      return {
        apiKeyEnvName: 'KORBIT_API_KEY',
        secretKeyEnvName: 'KORBIT_SECRET_KEY',
        apiKey: normalizeEnvValue(env.KORBIT_API_KEY),
        secretKey: normalizeEnvValue(env.KORBIT_SECRET_KEY),
      };
    case 'binance':
      return {
        apiKeyEnvName: 'BINANCE_API_KEY',
        secretKeyEnvName: 'BINANCE_SECRET_KEY',
        apiKey: normalizeEnvValue(env.BINANCE_API_KEY),
        secretKey: normalizeEnvValue(env.BINANCE_SECRET_KEY),
      };
  }
}

function buildMissingCredentialMessage(exchange: ExchangeId, missingEnvNames: string[]) {
  const variableList = missingEnvNames.join(', ');
  return `${exchange} private credentials are required. Connect a user exchange account or configure ${variableList} in the server environment.`;
}

export function getServerExchangeCredentialStatus(exchange: ExchangeId) {
  const config = getExchangeCredentialEnvConfig(exchange);
  const missingEnvNames = [
    !config.apiKey ? config.apiKeyEnvName : null,
    !config.secretKey ? config.secretKeyEnvName : null,
  ].filter((value): value is string => Boolean(value));

  return {
    exchange,
    configured: missingEnvNames.length === 0,
    incomplete: missingEnvNames.length > 0 && missingEnvNames.length < 2,
    missingEnvNames,
  };
}

export function getServerExchangeCredentialAvailability() {
  return {
    upbit: getServerExchangeCredentialStatus('upbit'),
    bithumb: getServerExchangeCredentialStatus('bithumb'),
    coinone: getServerExchangeCredentialStatus('coinone'),
    korbit: getServerExchangeCredentialStatus('korbit'),
    binance: getServerExchangeCredentialStatus('binance'),
  };
}

export function resolveServerExchangeCredentials(exchange: ExchangeId): UserExchangeCredentials | null {
  const config = getExchangeCredentialEnvConfig(exchange);
  const hasApiKey = Boolean(config.apiKey);
  const hasSecretKey = Boolean(config.secretKey);

  if (!hasApiKey && !hasSecretKey) {
    return null;
  }

  if (!hasApiKey || !hasSecretKey) {
    const missingEnvNames = [
      !hasApiKey ? config.apiKeyEnvName : null,
      !hasSecretKey ? config.secretKeyEnvName : null,
    ].filter((value): value is string => Boolean(value));
    throw new ExchangeAuthError(exchange, buildMissingCredentialMessage(exchange, missingEnvNames));
  }

  return {
    exchange,
    apiKey: config.apiKey!,
    secretKey: config.secretKey!,
    passphrase: null,
  };
}

export function getMissingExchangeCredentialError(exchange: ExchangeId) {
  const config = getExchangeCredentialEnvConfig(exchange);
  return new ExchangeAuthError(
    exchange,
    buildMissingCredentialMessage(exchange, [config.apiKeyEnvName, config.secretKeyEnvName]),
  );
}
