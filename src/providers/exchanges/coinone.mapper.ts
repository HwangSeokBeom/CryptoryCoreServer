import type { NormalizedTicker } from '../../exchanges/ExchangeAdapter';
import type { ExchangeMarketDescriptor } from '../../core/exchange/exchange.types';
import { safeNumber, safeString } from './provider-utils';

type CoinoneMarketItem = {
  quote_currency?: string;
  target_currency?: string;
  trade_status?: number;
  maintenance_status?: number;
};

type CoinoneTickerItem = {
  quote_currency?: string;
  target_currency?: string;
  timestamp?: number | string;
  high?: string;
  low?: string;
  first?: string;
  last?: string;
  quote_volume?: string;
  target_volume?: string;
  yesterday_last?: string;
};

function normalizeSymbol(value: unknown) {
  return safeString(value).trim().toUpperCase();
}

function isKrwQuote(value: unknown) {
  return safeString(value).trim().toUpperCase() === 'KRW';
}

function parseNumericField(value: unknown, fallback = 0) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }

    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

export function parseCoinoneMarketsResponse(
  payload: { markets?: CoinoneMarketItem[] } | null | undefined,
  allowedSymbols?: ReadonlySet<string>,
) {
  return (payload?.markets ?? [])
    .filter((item) => isKrwQuote(item.quote_currency))
    .map<ExchangeMarketDescriptor | null>((item) => {
      const symbol = normalizeSymbol(item.target_currency);
      if (!symbol) {
        return null;
      }
      if (allowedSymbols && !allowedSymbols.has(symbol)) {
        return null;
      }
      return {
        symbol,
        exchangeSymbol: symbol,
        market: `${symbol}/KRW`,
        baseCurrency: symbol,
        quoteCurrency: 'KRW',
        rawSymbol: symbol,
        tradable: safeNumber(item.trade_status) === 1 && safeNumber(item.maintenance_status) === 0,
      };
    })
    .filter((item): item is ExchangeMarketDescriptor => item !== null)
    .filter((item) => item.tradable)
    .map((item) => ({
      ...item,
    }));
}

export function parseCoinoneTickersResponse(
  payload: { tickers?: CoinoneTickerItem[] } | null | undefined,
  requestedSymbols: string[],
) {
  const requested = Array.from(new Set(requestedSymbols.map(normalizeSymbol).filter(Boolean)));
  const requestedSet = new Set(requested);
  const tickerMap = new Map<string, CoinoneTickerItem>();
  const dropped: Array<{ symbol: string; reason: string }> = [];

  for (const item of payload?.tickers ?? []) {
    if (!isKrwQuote(item.quote_currency)) {
      dropped.push({
        symbol: normalizeSymbol(item.target_currency) || '<unknown>',
        reason: `unexpected quote currency: ${safeString(item.quote_currency) || '<empty>'}`,
      });
      continue;
    }

    const symbol = normalizeSymbol(item.target_currency);
    if (!symbol) {
      dropped.push({ symbol: '<unknown>', reason: 'missing target_currency' });
      continue;
    }

    if (!requestedSet.has(symbol)) {
      continue;
    }

    tickerMap.set(symbol, item);
  }

  const tickers: NormalizedTicker[] = requested.flatMap((symbol) => {
    const item = tickerMap.get(symbol);
    if (!item) {
      dropped.push({ symbol, reason: 'missing from Coinone ticker response' });
      return [];
    }

    const last = parseNumericField(item.last);
    const yesterdayLast = parseNumericField(item.yesterday_last, parseNumericField(item.first, last));
    const change24h = yesterdayLast > 0 ? ((last - yesterdayLast) / yesterdayLast) * 100 : 0;

    return [
      {
        symbol,
        price: last,
        change24h: Math.round(change24h * 100) / 100,
        volume24h: parseNumericField(item.quote_volume),
        high24h: parseNumericField(item.high),
        low24h: parseNumericField(item.low),
        timestamp: parseNumericField(item.timestamp, Date.now()),
      },
    ];
  });

  const missingSymbols = requested.filter((symbol) => !tickerMap.has(symbol));

  return {
    tickers,
    missingSymbols,
    dropped,
  };
}
