import type { ExchangeId } from '../../core/exchange/exchange.types';

export type ExchangeIngestHealthSnapshot = {
  exchange: ExchangeId;
  lastTickerReceivedAt: number | null;
  lastTradeReceivedAt: number | null;
  lastDomesticKimchiPriceUsedAt: number | null;
  lastDomesticKimchiPriceAsOf: number | null;
  lastDomesticKimchiPriceSymbol: string | null;
  trendProjectionRefreshCount: number;
  lastTrendProjectionRefreshAt: number | null;
};

type MutableExchangeIngestHealthSnapshot = ExchangeIngestHealthSnapshot;

function createHealth(exchange: ExchangeId): MutableExchangeIngestHealthSnapshot {
  return {
    exchange,
    lastTickerReceivedAt: null,
    lastTradeReceivedAt: null,
    lastDomesticKimchiPriceUsedAt: null,
    lastDomesticKimchiPriceAsOf: null,
    lastDomesticKimchiPriceSymbol: null,
    trendProjectionRefreshCount: 0,
    lastTrendProjectionRefreshAt: null,
  };
}

class MarketIngestHealthStore {
  private readonly snapshots = new Map<ExchangeId, MutableExchangeIngestHealthSnapshot>();

  noteTickerReceived(exchange: ExchangeId, timestamp: number) {
    const snapshot = this.getMutable(exchange);
    snapshot.lastTickerReceivedAt = timestamp;
  }

  noteTradeReceived(exchange: ExchangeId, timestamp: number) {
    const snapshot = this.getMutable(exchange);
    snapshot.lastTradeReceivedAt = timestamp;
  }

  noteDomesticKimchiPriceUsed(exchange: ExchangeId, params: { symbol: string; asOf: number | null }) {
    const snapshot = this.getMutable(exchange);
    snapshot.lastDomesticKimchiPriceUsedAt = Date.now();
    snapshot.lastDomesticKimchiPriceAsOf = params.asOf;
    snapshot.lastDomesticKimchiPriceSymbol = params.symbol;
  }

  noteTrendProjectionRefresh(exchange: ExchangeId, timestamp: number) {
    const snapshot = this.getMutable(exchange);
    snapshot.trendProjectionRefreshCount += 1;
    snapshot.lastTrendProjectionRefreshAt = timestamp;
  }

  getExchangeHealth(exchange: ExchangeId): ExchangeIngestHealthSnapshot {
    return { ...this.getMutable(exchange) };
  }

  listExchangeHealth(): ExchangeIngestHealthSnapshot[] {
    return Array.from(this.snapshots.values())
      .map((snapshot) => ({ ...snapshot }))
      .sort((left, right) => left.exchange.localeCompare(right.exchange));
  }

  private getMutable(exchange: ExchangeId) {
    const existing = this.snapshots.get(exchange);
    if (existing) {
      return existing;
    }

    const created = createHealth(exchange);
    this.snapshots.set(exchange, created);
    return created;
  }
}

export const marketIngestHealth = new MarketIngestHealthStore();
