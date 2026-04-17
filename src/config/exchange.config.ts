import { EXCHANGE_METADATA } from '../core/exchange/exchange.metadata';
import type { ExchangeId } from '../core/exchange/exchange.types';
import { env } from './env';

type ExchangeConfig = {
  restBaseUrl: string;
  publicWebSocketUrl: string;
  privateWebSocketUrl?: string;
  publicStreamingEnabled: boolean;
  privateStreamingEnabled: boolean;
  pollingFallbackEnabled: boolean;
  marketDataStaleThresholdMs: number;
};

function getExchangeUrls(exchange: ExchangeId) {
  switch (exchange) {
    case 'upbit':
      return {
        restBaseUrl: env.UPBIT_API_BASE_URL ?? env.UPBIT_REST_BASE_URL ?? EXCHANGE_METADATA.upbit.restBaseUrl,
        publicWebSocketUrl: env.UPBIT_WS_URL ?? env.UPBIT_PUBLIC_WS_URL ?? EXCHANGE_METADATA.upbit.publicWebSocketUrl,
        privateWebSocketUrl: env.UPBIT_PRIVATE_WS_URL ?? EXCHANGE_METADATA.upbit.privateWebSocketUrl,
      };
    case 'bithumb':
      return {
        restBaseUrl: env.BITHUMB_API_BASE_URL ?? env.BITHUMB_REST_BASE_URL ?? EXCHANGE_METADATA.bithumb.restBaseUrl,
        publicWebSocketUrl: env.BITHUMB_WS_URL ?? env.BITHUMB_PUBLIC_WS_URL ?? EXCHANGE_METADATA.bithumb.publicWebSocketUrl,
        privateWebSocketUrl: env.BITHUMB_PRIVATE_WS_URL ?? EXCHANGE_METADATA.bithumb.privateWebSocketUrl,
      };
    case 'coinone':
      return {
        restBaseUrl: env.COINONE_API_BASE_URL ?? env.COINONE_REST_BASE_URL ?? EXCHANGE_METADATA.coinone.restBaseUrl,
        publicWebSocketUrl: env.COINONE_WS_URL ?? env.COINONE_PUBLIC_WS_URL ?? EXCHANGE_METADATA.coinone.publicWebSocketUrl,
        privateWebSocketUrl: env.COINONE_PRIVATE_WS_URL ?? EXCHANGE_METADATA.coinone.privateWebSocketUrl,
      };
    case 'korbit':
      return {
        restBaseUrl: env.KORBIT_API_BASE_URL ?? env.KORBIT_REST_BASE_URL ?? EXCHANGE_METADATA.korbit.restBaseUrl,
        publicWebSocketUrl: env.KORBIT_WS_URL ?? env.KORBIT_PUBLIC_WS_URL ?? EXCHANGE_METADATA.korbit.publicWebSocketUrl,
        privateWebSocketUrl: env.KORBIT_PRIVATE_WS_URL ?? EXCHANGE_METADATA.korbit.privateWebSocketUrl,
      };
    case 'binance':
      return {
        restBaseUrl: env.BINANCE_API_BASE_URL ?? env.BINANCE_REST_BASE_URL ?? EXCHANGE_METADATA.binance.restBaseUrl,
        publicWebSocketUrl: env.BINANCE_WS_URL ?? env.BINANCE_PUBLIC_WS_URL ?? EXCHANGE_METADATA.binance.publicWebSocketUrl,
        privateWebSocketUrl: env.BINANCE_PRIVATE_WS_URL,
      };
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
