import type { ExchangeId } from './exchange.types';

const INTERVAL_MAPPINGS: Record<ExchangeId, Record<string, string>> = {
  upbit: {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '10m': '10',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '4h': '240',
    '1d': '1d',
    '1w': '1w',
  },
  bithumb: {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '10m': '10',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '4h': '240',
    '1d': '1d',
    '1w': '1w',
  },
  coinone: {
    '1m': '1m',
    '3m': '3m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1h',
    '4h': '4h',
    '1d': '1d',
  },
  korbit: {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '10m': '10',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '4h': '240',
    '1d': '1440',
    '1w': '10080',
  },
  binance: {
    '1m': '1m',
    '3m': '3m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1h',
    '2h': '2h',
    '4h': '4h',
    '6h': '6h',
    '8h': '8h',
    '12h': '12h',
    '1d': '1d',
    '3d': '3d',
    '1w': '1w',
  },
};

const FALLBACK_ORDER = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '4h', '1d', '1w'];

export function toExchangeInterval(exchange: ExchangeId, interval: string) {
  const mapping = INTERVAL_MAPPINGS[exchange];
  return mapping[interval] ?? null;
}

export function resolveExchangeInterval(exchange: ExchangeId, interval: string) {
  const direct = toExchangeInterval(exchange, interval);
  if (direct) {
    return {
      requestedInterval: interval,
      resolvedInterval: interval,
      exchangeInterval: direct,
      fallbackApplied: false,
    };
  }

  const requestedIndex = FALLBACK_ORDER.indexOf(interval);
  const candidates =
    requestedIndex >= 0
      ? FALLBACK_ORDER.slice(requestedIndex + 1)
      : FALLBACK_ORDER;

  for (const candidate of candidates) {
    const value = toExchangeInterval(exchange, candidate);
    if (value) {
      return {
        requestedInterval: interval,
        resolvedInterval: candidate,
        exchangeInterval: value,
        fallbackApplied: true,
      };
    }
  }

  return null;
}
