import { ExchangeAdapter, NormalizedTicker, NormalizedOrderbook, NormalizedCandle } from './ExchangeAdapter';

const BASE_URL = 'https://api.korbit.co.kr';

function toKorbitSymbol(symbol: string): string {
  return `${symbol.toLowerCase()}_krw`;
}

export class KorbitAdapter implements ExchangeAdapter {
  readonly id = 'korbit';
  readonly name = '코빗';

  async fetchTickers(symbols: string[]): Promise<NormalizedTicker[]> {
    const pairs = symbols.map(toKorbitSymbol).join(',');
    const res = await fetch(`${BASE_URL}/v2/tickers?symbol=${pairs}`);
    if (!res.ok) throw new Error(`Korbit ticker HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const data = json.data || json;
    const now = Date.now();

    if (Array.isArray(data)) {
      return data.map((item: any) => {
        const symbol = item.symbol?.replace('_krw', '').toUpperCase() ||
                       item.currencyPair?.replace('_krw', '').toUpperCase() || '';
        return {
          symbol,
          price: parseFloat(item.close || item.last || '0'),
          change24h: parseFloat(item.priceChangePercent || item.changePercent || '0'),
          volume24h: parseFloat(item.quoteVolume || item.volume || '0'),
          high24h: parseFloat(item.high || '0'),
          low24h: parseFloat(item.low || '0'),
          timestamp: now,
        };
      });
    }

    // Object format response
    return symbols.map((symbol) => {
      const key = toKorbitSymbol(symbol);
      const item = data[key] || {};
      return {
        symbol,
        price: parseFloat(item.close || item.last || '0'),
        change24h: parseFloat(item.priceChangePercent || item.changePercent || '0'),
        volume24h: parseFloat(item.quoteVolume || item.volume || '0'),
        high24h: parseFloat(item.high || '0'),
        low24h: parseFloat(item.low || '0'),
        timestamp: now,
      };
    });
  }

  async fetchOrderbook(symbol: string, _depth = 10): Promise<NormalizedOrderbook> {
    const pair = toKorbitSymbol(symbol);
    const res = await fetch(`${BASE_URL}/v2/orderbook?symbol=${pair}`);
    if (!res.ok) throw new Error(`Korbit orderbook HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const asks = (json.asks || []).map((a: any) => ({
      price: parseFloat(a.price || a[0]),
      qty: parseFloat(a.qty || a[1]),
    }));
    const bids = (json.bids || []).map((b: any) => ({
      price: parseFloat(b.price || b[0]),
      qty: parseFloat(b.qty || b[1]),
    }));
    return {
      asks: asks.reverse(),
      bids,
      currentPrice: asks.length > 0 ? asks[asks.length - 1].price : 0,
    };
  }

  async fetchCandles(symbol: string, period: string, limit = 60): Promise<NormalizedCandle[]> {
    const pair = toKorbitSymbol(symbol);
    const intervalMap: Record<string, string> = {
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
    };
    const interval = intervalMap[period] || '60';

    const res = await fetch(
      `${BASE_URL}/v2/candles?symbol=${pair}&interval=${interval}&limit=${limit}`,
    );
    if (!res.ok) throw new Error(`Korbit candles HTTP ${res.status}`);

    const json = (await res.json()) as any;
    const data = json.data ?? json;

    return data.map((item: any) => ({
      time: item.timestamp ?? Date.now(),
      open: parseFloat(item.open ?? '0'),
      high: parseFloat(item.high ?? '0'),
      low: parseFloat(item.low ?? '0'),
      close: parseFloat(item.close ?? '0'),
      volume: parseFloat(item.volume ?? '0'),
    }));
  }
}
