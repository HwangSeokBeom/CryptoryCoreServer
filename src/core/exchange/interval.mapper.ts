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

const INTERVAL_ALIASES: Record<string, string> = {
  '1m': '1m',
  '1min': '1m',
  '1mins': '1m',
  '1minute': '1m',
  '1minutes': '1m',
  '3m': '3m',
  '3min': '3m',
  '3mins': '3m',
  '5m': '5m',
  '5min': '5m',
  '5mins': '5m',
  '10m': '10m',
  '10min': '10m',
  '10mins': '10m',
  '15m': '15m',
  '15min': '15m',
  '15mins': '15m',
  '30m': '30m',
  '30min': '30m',
  '30mins': '30m',
  '1h': '1h',
  '1hr': '1h',
  '1hrs': '1h',
  '1hour': '1h',
  '1hours': '1h',
  '60m': '1h',
  '60min': '1h',
  '60mins': '1h',
  '4h': '4h',
  '4hr': '4h',
  '4hrs': '4h',
  '4hour': '4h',
  '4hours': '4h',
  '240m': '4h',
  '240min': '4h',
  '2h': '2h',
  '2hr': '2h',
  '2hrs': '2h',
  '120m': '2h',
  '6h': '6h',
  '6hr': '6h',
  '6hrs': '6h',
  '360m': '6h',
  '8h': '8h',
  '8hr': '8h',
  '8hrs': '8h',
  '480m': '8h',
  '12h': '12h',
  '12hr': '12h',
  '12hrs': '12h',
  '720m': '12h',
  '1d': '1d',
  '1day': '1d',
  '1days': '1d',
  'day': '1d',
  'daily': '1d',
  '24h': '1d',
  '3d': '3d',
  '3day': '3d',
  '3days': '3d',
  '72h': '3d',
  '1w': '1w',
  '1week': '1w',
  '1weeks': '1w',
  'week': '1w',
  'weekly': '1w',
  '7d': '1w',
};

export function normalizeIntervalInput(interval: string) {
  const normalized = interval.trim().toLowerCase().replace(/[\s_]+/g, '');
  if (!normalized) {
    return '';
  }

  return INTERVAL_ALIASES[normalized] ?? normalized;
}

export function toExchangeInterval(exchange: ExchangeId, interval: string) {
  const mapping = INTERVAL_MAPPINGS[exchange];
  return mapping[normalizeIntervalInput(interval)] ?? null;
}

export function resolveExchangeInterval(exchange: ExchangeId, interval: string) {
  const normalizedInterval = normalizeIntervalInput(interval);
  const direct = toExchangeInterval(exchange, normalizedInterval);
  if (direct) {
    return {
      requestedInterval: interval,
      normalizedInterval,
      resolvedInterval: normalizedInterval,
      exchangeInterval: direct,
      fallbackApplied: false,
    };
  }

  const requestedIndex = FALLBACK_ORDER.indexOf(normalizedInterval);
  const candidates =
    requestedIndex >= 0
      ? FALLBACK_ORDER.slice(requestedIndex + 1)
      : FALLBACK_ORDER;

  for (const candidate of candidates) {
    const value = toExchangeInterval(exchange, candidate);
    if (value) {
      return {
        requestedInterval: interval,
        normalizedInterval,
        resolvedInterval: candidate,
        exchangeInterval: value,
        fallbackApplied: true,
      };
    }
  }

  return null;
}
