import { EXCHANGE_METADATA } from '../core/exchange/exchange.metadata';
import type { ExchangeId } from '../core/exchange/exchange.types';
import { env } from './env';

type ExchangeConfig = {
  restBaseUrl: string;
  publicRestBaseUrl: string;
  privateRestBaseUrl: string;
  publicWebSocketUrl: string;
  privateWebSocketUrl?: string;
  publicStreamingEnabled: boolean;
  privateStreamingEnabled: boolean;
  pollingFallbackEnabled: boolean;
  marketDataStaleThresholdMs: number;
};

function buildUnifiedUrls(restBaseUrl: string, publicWebSocketUrl: string, privateWebSocketUrl?: string) {
  return {
    restBaseUrl,
    publicRestBaseUrl: restBaseUrl,
    privateRestBaseUrl: restBaseUrl,
    publicWebSocketUrl,
    privateWebSocketUrl,
  };
}

function isBinancePublicDataRestBaseUrl(baseUrl?: string) {
  if (!baseUrl) {
    return false;
  }

  try {
    return new URL(baseUrl).hostname === 'data-api.binance.vision';
  } catch {
    return false;
  }
}

function getExchangeUrls(exchange: ExchangeId) {
  switch (exchange) {
    case 'upbit':
      return buildUnifiedUrls(
        env.UPBIT_API_BASE_URL ?? env.UPBIT_REST_BASE_URL ?? EXCHANGE_METADATA.upbit.restBaseUrl,
        env.UPBIT_WS_URL ?? env.UPBIT_PUBLIC_WS_URL ?? EXCHANGE_METADATA.upbit.publicWebSocketUrl,
        env.UPBIT_PRIVATE_WS_URL ?? EXCHANGE_METADATA.upbit.privateWebSocketUrl,
      );
    case 'bithumb':
      return buildUnifiedUrls(
        env.BITHUMB_API_BASE_URL ?? env.BITHUMB_REST_BASE_URL ?? EXCHANGE_METADATA.bithumb.restBaseUrl,
        env.BITHUMB_WS_URL ?? env.BITHUMB_PUBLIC_WS_URL ?? EXCHANGE_METADATA.bithumb.publicWebSocketUrl,
        env.BITHUMB_PRIVATE_WS_URL ?? EXCHANGE_METADATA.bithumb.privateWebSocketUrl,
      );
    case 'coinone':
      return buildUnifiedUrls(
        env.COINONE_API_BASE_URL ?? env.COINONE_REST_BASE_URL ?? EXCHANGE_METADATA.coinone.restBaseUrl,
        env.COINONE_WS_URL ?? env.COINONE_PUBLIC_WS_URL ?? EXCHANGE_METADATA.coinone.publicWebSocketUrl,
        env.COINONE_PRIVATE_WS_URL ?? EXCHANGE_METADATA.coinone.privateWebSocketUrl,
      );
    case 'korbit':
      return buildUnifiedUrls(
        env.KORBIT_API_BASE_URL ?? env.KORBIT_REST_BASE_URL ?? EXCHANGE_METADATA.korbit.restBaseUrl,
        env.KORBIT_WS_URL ?? env.KORBIT_PUBLIC_WS_URL ?? EXCHANGE_METADATA.korbit.publicWebSocketUrl,
        env.KORBIT_PRIVATE_WS_URL ?? EXCHANGE_METADATA.korbit.privateWebSocketUrl,
      );
    case 'binance':
      {
        const publicRestBaseUrl =
          env.BINANCE_PUBLIC_API_BASE_URL
          ?? env.BINANCE_API_BASE_URL
          ?? env.BINANCE_REST_BASE_URL
          ?? EXCHANGE_METADATA.binance.publicRestBaseUrl
          ?? EXCHANGE_METADATA.binance.restBaseUrl;
        const privateOverride = isBinancePublicDataRestBaseUrl(env.BINANCE_PRIVATE_API_BASE_URL)
          ? undefined
          : env.BINANCE_PRIVATE_API_BASE_URL;
        const legacyPrivateOverride = isBinancePublicDataRestBaseUrl(env.BINANCE_REST_BASE_URL)
          ? undefined
          : env.BINANCE_REST_BASE_URL;
        const privateRestBaseUrl =
          privateOverride
          ?? legacyPrivateOverride
          ?? EXCHANGE_METADATA.binance.privateRestBaseUrl
          ?? EXCHANGE_METADATA.binance.restBaseUrl;
        return {
          restBaseUrl: publicRestBaseUrl,
          publicRestBaseUrl,
          privateRestBaseUrl,
          publicWebSocketUrl:
            env.BINANCE_WS_BASE_URL
            ?? env.BINANCE_WS_URL
            ?? env.BINANCE_PUBLIC_WS_URL
            ?? EXCHANGE_METADATA.binance.publicWebSocketUrl,
          privateWebSocketUrl: env.BINANCE_PRIVATE_WS_URL,
        };
      }
  }
}

export function getExchangeConfig(exchange: ExchangeId): ExchangeConfig {
  const urls = getExchangeUrls(exchange);
  return {
    ...urls,
    publicStreamingEnabled: env.PUBLIC_STREAMING_ENABLED,
    privateStreamingEnabled: env.ENABLE_PRIVATE_WS,
    pollingFallbackEnabled: env.ENABLE_POLLING_FALLBACK,
    marketDataStaleThresholdMs: env.MARKET_DATA_STALE_THRESHOLD_MS,
  };
}

export const fxConfig = {
  baseUrl: env.FX_BASE_URL,
  apiKey: env.EXCHANGE_RATE_API_KEY,
  staleThresholdMs: env.FX_STALE_THRESHOLD_MS,
  timestampSkewThresholdMs: env.FX_TIMESTAMP_SKEW_THRESHOLD_MS,
  fallbackRate: env.USD_KRW_FALLBACK,
};

function normalizeBinanceCombinedStreamBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/stream';
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/g, '');
}

export function buildBinancePublicWebSocketUrl(streams: string[], publicWebSocketUrl = getExchangeConfig('binance').publicWebSocketUrl) {
  const baseUrl = normalizeBinanceCombinedStreamBaseUrl(publicWebSocketUrl);
  return `${baseUrl}?streams=${streams.join('/')}`;
}
