import type { ExchangeId } from '../../core/exchange/exchange.types';
import type { NormalizedMarketTicker, NormalizedMarketTrade } from '../../modules/public-market/market.types';
import { marketIngestHealth } from './market.ingest-health';
import { isRepresentativeMarketSymbol } from './market-priority';

export type TrendProjectionPoint = {
  price: number;
  timestamp: number;
};

type TrendSource = 'ticker' | 'trade';

const TREND_BUFFER_LIMIT = 120;

function toKey(exchange: ExchangeId, symbol: string) {
  return `${exchange}:${symbol}`;
}

function resolveMinSampleIntervalMs(symbol: string, source: TrendSource) {
  if (isRepresentativeMarketSymbol(symbol)) {
    return source === 'trade' ? 1_000 : 2_000;
  }

  return source === 'trade' ? 2_500 : 8_000;
}

class MarketTrendProjectionStore {
  private readonly points = new Map<string, TrendProjectionPoint[]>();

  recordTicker(ticker: NormalizedMarketTicker) {
    this.record({
      exchange: ticker.exchange as ExchangeId,
      symbol: ticker.symbol,
      price: ticker.price,
      timestamp: ticker.timestamp,
      source: 'ticker',
    });
  }

  recordTrade(trade: NormalizedMarketTrade) {
    this.record({
      exchange: trade.exchange as ExchangeId,
      symbol: trade.symbol,
      price: trade.price,
      timestamp: trade.timestamp,
      source: 'trade',
    });
  }

  getPoints(exchange: ExchangeId, symbol: string, limit = 20) {
    const buffer = this.points.get(toKey(exchange, symbol)) ?? [];
    return buffer.slice(-Math.max(limit, 0)).map((point) => ({ ...point }));
  }

  private record(params: {
    exchange: ExchangeId;
    symbol: string;
    price: number;
    timestamp: number;
    source: TrendSource;
  }) {
    if (!Number.isFinite(params.price) || params.price <= 0 || !Number.isFinite(params.timestamp) || params.timestamp <= 0) {
      return;
    }

    const key = toKey(params.exchange, params.symbol);
    const buffer = this.points.get(key) ?? [];
    const last = buffer[buffer.length - 1];
    const minSampleIntervalMs = resolveMinSampleIntervalMs(params.symbol, params.source);

    if (!last) {
      buffer.push({ price: params.price, timestamp: params.timestamp });
    } else {
      const elapsedMs = Math.max(params.timestamp - last.timestamp, 0);
      if (elapsedMs >= minSampleIntervalMs) {
        buffer.push({ price: params.price, timestamp: params.timestamp });
      } else {
        last.price = params.price;
        last.timestamp = Math.max(last.timestamp, params.timestamp);
      }
    }

    if (buffer.length > TREND_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - TREND_BUFFER_LIMIT);
    }

    this.points.set(key, buffer);
    marketIngestHealth.noteTrendProjectionRefresh(params.exchange, params.timestamp);
  }
}

export const marketTrendProjectionStore = new MarketTrendProjectionStore();
