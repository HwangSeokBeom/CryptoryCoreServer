import { ExchangeAdapter, NormalizedTicker, NormalizedOrderbook, NormalizedCandle } from './ExchangeAdapter';
import { getUsdKrwRate } from './exchangeRateService';

const BASE_URL = 'https://api.binance.com';

function toBinanceSymbol(symbol: string): string {
  return `${symbol}USDT`;
}

export class BinanceAdapter implements ExchangeAdapter {
  readonly id = 'binance';
  readonly name = '바이낸스';

  async fetchTickers(symbols: string[]): Promise<NormalizedTicker[]> {
    const binanceSymbols = symbols.map(toBinanceSymbol);
    const param = JSON.stringify(binanceSymbols);
    const res = await fetch(`${BASE_URL}/api/v3/ticker/24hr?symbols=${encodeURIComponent(param)}`);
    if (!res.ok) throw new Error(`Binance ticker HTTP ${res.status}`);
    const data = (await res.json()) as any[];
    const rate = await getUsdKrwRate();
    const now = Date.now();

    return data.map((item) => {
      const symbol = item.symbol.replace('USDT', '');
      return {
        symbol,
        price: parseFloat(item.lastPrice) * rate,
        change24h: parseFloat(item.priceChangePercent),
        volume24h: parseFloat(item.quoteVolume) * rate,
        high24h: parseFloat(item.highPrice) * rate,
        low24h: parseFloat(item.lowPrice) * rate,
        timestamp: now,
      };
    });
  }

  async fetchOrderbook(symbol: string, depth = 10): Promise<NormalizedOrderbook> {
    const pair = toBinanceSymbol(symbol);
    const res = await fetch(`${BASE_URL}/api/v3/depth?symbol=${pair}&limit=${depth}`);
    if (!res.ok) throw new Error(`Binance orderbook HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const rate = await getUsdKrwRate();

    const asks = (json.asks || []).map((a: any) => ({
      price: parseFloat(a[0]) * rate,
      qty: parseFloat(a[1]),
    }));
    const bids = (json.bids || []).map((b: any) => ({
      price: parseFloat(b[0]) * rate,
      qty: parseFloat(b[1]),
    }));

    return {
      asks: asks.reverse(),
      bids,
      currentPrice: asks.length > 0 ? asks[asks.length - 1].price : 0,
    };
  }

  async fetchCandles(symbol: string, period: string, limit = 60): Promise<NormalizedCandle[]> {
    const pair = toBinanceSymbol(symbol);
    const intervalMap: Record<string, string> = {
      '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
      '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w',
    };
    const interval = intervalMap[period] || '1h';
    const res = await fetch(`${BASE_URL}/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`);
    if (!res.ok) throw new Error(`Binance candles HTTP ${res.status}`);
    const data = (await res.json()) as any[][];
    const rate = await getUsdKrwRate();

    return data.map((item, i) => ({
      time: i,
      open: parseFloat(item[1]) * rate,
      high: parseFloat(item[2]) * rate,
      low: parseFloat(item[3]) * rate,
      close: parseFloat(item[4]) * rate,
      volume: parseFloat(item[5]),
    }));
  }
}
