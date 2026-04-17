import { ExchangeAdapter, NormalizedTicker, NormalizedOrderbook, NormalizedCandle } from './ExchangeAdapter';

const BASE_URL = 'https://api.bithumb.com';

function describePayloadShape(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(len=${value.length})`;
  }

  if (!value || typeof value !== 'object') {
    return value === null ? 'null' : typeof value;
  }

  const keys = Object.entries(value as Record<string, unknown>)
    .slice(0, 8)
    .map(([key, child]) => `${key}:${Array.isArray(child) ? 'array' : child === null ? 'null' : typeof child}`);

  return `{${keys.join(',')}}`;
}

function toPayloadSnippet(payload: unknown): string {
  try {
    const text = JSON.stringify(payload);
    return text.length > 280 ? `${text.slice(0, 280)}...` : text;
  } catch {
    return String(payload);
  }
}

function resolveOrderbookPayload(payload: any) {
  const candidates = [payload?.data?.data, payload?.data, payload];
  return candidates.find((candidate) => candidate && typeof candidate === 'object') ?? payload;
}

async function readResponseSnippet(response: Response) {
  const text = await response.text();
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
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

export class BithumbAdapter implements ExchangeAdapter {
  readonly id = 'bithumb';
  readonly name = '빗썸';

  async fetchTickers(symbols: string[]): Promise<NormalizedTicker[]> {
    const res = await fetch(`${BASE_URL}/public/ticker/ALL_KRW`);
    if (!res.ok) throw new Error(`Bithumb ticker HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const data = json.data;
    const now = Date.now();

    return symbols
      .filter((s) => data[s])
      .map((symbol) => {
        const item = data[symbol];
        return {
          symbol,
          price: parseFloat(item.closing_price),
          change24h: parseFloat(item.fluctate_rate_24H || '0'),
          volume24h: parseFloat(item.acc_trade_value_24H || '0'),
          high24h: parseFloat(item.max_price),
          low24h: parseFloat(item.min_price),
          timestamp: now,
        };
      });
  }

  async fetchOrderbook(symbol: string, depth = 10): Promise<NormalizedOrderbook> {
    const res = await fetch(`${BASE_URL}/public/orderbook/${symbol}_KRW?count=${depth}`);
    if (!res.ok) {
      const snippet = await readResponseSnippet(res);
      throw new Error(
        `Bithumb orderbook HTTP ${res.status} for ${symbol}_KRW${snippet ? ` body=${snippet}` : ''}`,
      );
    }

    const json = (await res.json()) as any;
    const data = resolveOrderbookPayload(json);
    if (!Array.isArray(data?.asks) || !Array.isArray(data?.bids)) {
      throw new Error(
        `Bithumb orderbook malformed payload for ${symbol}_KRW: shape=${describePayloadShape(json)} sample=${toPayloadSnippet(json)}`,
      );
    }

    const asks = (data.asks || []).map((a: any) => ({
      price: parseFloat(a.price),
      qty: parseFloat(a.quantity),
    }));
    const bids = (data.bids || []).map((b: any) => ({
      price: parseFloat(b.price),
      qty: parseFloat(b.quantity),
    }));
    return {
      asks: asks.reverse(),
      bids,
      currentPrice: asks.length > 0 ? asks[asks.length - 1].price : 0,
    };
  }

  async fetchCandles(symbol: string, period: string, limit = 60): Promise<NormalizedCandle[]> {
    const market = `KRW-${symbol}`;

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
    if (!res.ok) throw new Error(`Bithumb candles HTTP ${res.status}`);

    const data = (await res.json()) as any[];
    return data.reverse().map((item) => ({
      time: item.timestamp ?? item.candle_date_time_kst ?? Date.now(),
      open: parseFloat(item.opening_price),
      high: parseFloat(item.high_price),
      low: parseFloat(item.low_price),
      close: parseFloat(item.trade_price),
      volume: parseFloat(item.candle_acc_trade_volume),
    }));
  }
}
