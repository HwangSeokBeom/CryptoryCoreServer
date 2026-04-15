import { ExchangeAdapter, NormalizedTicker, NormalizedOrderbook, NormalizedCandle } from './ExchangeAdapter';
import { logger } from '../utils/logger';

const BASE_URL = 'https://api.upbit.com';

function toMarket(symbol: string): string {
  return `KRW-${symbol}`;
}

function toMinuteUnit(period: string): number {
  const map: Record<string, number> = {
    '1m': 1,
    '3m': 3,
    '5m': 5,
    '10m': 10,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '4h': 240,
  };

  const parsed = map[period] ?? parseInt(period, 10);
  return Number.isFinite(parsed) ? parsed : 60;
}

export class UpbitAdapter implements ExchangeAdapter {
  readonly id = 'upbit';
  readonly name = '업비트';

  async fetchTickers(symbols: string[]): Promise<NormalizedTicker[]> {
    const markets = symbols.map(toMarket).join(',');
    const res = await fetch(`${BASE_URL}/v1/ticker?markets=${markets}`);
    if (!res.ok) throw new Error(`Upbit ticker HTTP ${res.status}`);
    const data = (await res.json()) as any[];
    return data.map((item) => ({
      symbol: item.market.replace('KRW-', ''),
      price: item.trade_price,
      change24h: Math.round(item.signed_change_rate * 10000) / 100,
      volume24h: Math.round(item.acc_trade_price_24h),
      high24h: item.high_price,
      low24h: item.low_price,
      timestamp: item.trade_timestamp,
    }));
  }

  async fetchOrderbook(symbol: string, _depth = 10): Promise<NormalizedOrderbook> {
    const market = toMarket(symbol);
    const res = await fetch(`${BASE_URL}/v1/orderbook?markets=${market}`);
    if (!res.ok) throw new Error(`Upbit orderbook HTTP ${res.status}`);
    const data = (await res.json()) as any[];
    const item = data[0];
    const asks = item.orderbook_units.map((u: any) => ({
      price: u.ask_price,
      qty: u.ask_size,
    }));
    const bids = item.orderbook_units.map((u: any) => ({
      price: u.bid_price,
      qty: u.bid_size,
    }));
    return {
      asks: asks.reverse(),
      bids,
      currentPrice: item.orderbook_units[0]?.ask_price ?? 0,
    };
  }

  async fetchCandles(symbol: string, period: string, limit = 60): Promise<NormalizedCandle[]> {
    const market = toMarket(symbol);
    let url: string;
    if (period === '1d' || period === 'day') {
      url = `${BASE_URL}/v1/candles/days?market=${market}&count=${limit}`;
    } else if (period === '1w' || period === 'week') {
      url = `${BASE_URL}/v1/candles/weeks?market=${market}&count=${limit}`;
    } else {
      const unit = toMinuteUnit(period);
      url = `${BASE_URL}/v1/candles/minutes/${unit}?market=${market}&count=${limit}`;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Upbit candles HTTP ${res.status}`);
    const data = (await res.json()) as any[];
    return data.reverse().map((item, i) => ({
      time: i,
      open: item.opening_price,
      high: item.high_price,
      low: item.low_price,
      close: item.trade_price,
      volume: item.candle_acc_trade_volume,
    }));
  }
}
