import { ExchangeAdapter, NormalizedTicker, NormalizedOrderbook, NormalizedCandle } from './ExchangeAdapter';

const BASE_URL = 'https://api.coinone.co.kr';

export class CoinoneAdapter implements ExchangeAdapter {
  readonly id = 'coinone';
  readonly name = '코인원';

  async fetchTickers(symbols: string[]): Promise<NormalizedTicker[]> {
    const res = await fetch(`${BASE_URL}/public/v2/ticker_new/KRW/ALL`);
    if (!res.ok) throw new Error(`Coinone ticker HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const tickers = json.tickers || [];
    const now = Date.now();

    const tickerMap = new Map<string, any>();
    for (const t of tickers) {
      tickerMap.set(t.target_currency?.toUpperCase(), t);
    }

    return symbols
      .filter((s) => tickerMap.has(s))
      .map((symbol) => {
        const item = tickerMap.get(symbol)!;
        const last = parseFloat(item.last);
        const yesterdayLast = parseFloat(item.yesterday_last || item.last);
        const change24h = yesterdayLast > 0 ? ((last - yesterdayLast) / yesterdayLast) * 100 : 0;
        return {
          symbol,
          price: last,
          change24h: Math.round(change24h * 100) / 100,
          volume24h: parseFloat(item.quote_volume || '0'),
          high24h: parseFloat(item.high || '0'),
          low24h: parseFloat(item.low || '0'),
          timestamp: now,
        };
      });
  }

  async fetchOrderbook(symbol: string, depth = 10): Promise<NormalizedOrderbook> {
    const res = await fetch(`${BASE_URL}/public/v2/orderbook/KRW/${symbol}?size=${depth}`);
    if (!res.ok) throw new Error(`Coinone orderbook HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const asks = (json.asks || []).map((a: any) => ({
      price: parseFloat(a.price),
      qty: parseFloat(a.qty),
    }));
    const bids = (json.bids || []).map((b: any) => ({
      price: parseFloat(b.price),
      qty: parseFloat(b.qty),
    }));
    return {
      asks: asks.reverse(),
      bids,
      currentPrice: asks.length > 0 ? asks[asks.length - 1].price : 0,
    };
  }

  async fetchCandles(symbol: string, period: string, limit = 60): Promise<NormalizedCandle[]> {
    const params = new URLSearchParams({
      interval: period,
      size: limit.toString(),
    });

    const res = await fetch(`${BASE_URL}/public/v2/chart/KRW/${symbol}?${params.toString()}`);
    if (!res.ok) throw new Error(`Coinone candles HTTP ${res.status}`);

    const json = (await res.json()) as any;
    const data = json.chart ?? json.data?.chart ?? json.data ?? [];

    return data.map((item: any) => ({
      time: item.timestamp ?? item.time ?? Date.now(),
      open: parseFloat(item.open ?? item.open_price ?? '0'),
      high: parseFloat(item.high ?? item.high_price ?? '0'),
      low: parseFloat(item.low ?? item.low_price ?? '0'),
      close: parseFloat(item.close ?? item.close_price ?? '0'),
      volume: parseFloat(item.target_volume ?? item.volume ?? '0'),
    }));
  }
}
