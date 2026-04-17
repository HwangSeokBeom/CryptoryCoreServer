import { ExchangeAdapter, NormalizedTicker, NormalizedOrderbook, NormalizedCandle } from './ExchangeAdapter';

const BASE_URL = 'https://api.korbit.co.kr';

function toKorbitSymbol(symbol: string): string {
  const normalized = symbol.trim().toLowerCase();

  if (/^[a-z0-9]+_(krw|usdt)$/.test(normalized)) {
    return normalized;
  }

  if (normalized.includes('/')) {
    const [base, quote] = normalized.split('/');
    return `${base}_${quote || 'krw'}`;
  }

  if (normalized.startsWith('krw-')) {
    return `${normalized.replace(/^krw-/, '')}_krw`;
  }

  return `${normalized}_krw`;
}

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

async function readResponseSnippet(response: Response) {
  const text = await response.text();
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
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
    if (!res.ok) {
      const snippet = await readResponseSnippet(res);
      throw new Error(`Korbit orderbook HTTP ${res.status} for symbol=${pair}${snippet ? ` body=${snippet}` : ''}`);
    }

    const json = (await res.json()) as any;
    const data = json.data ?? json;
    if (!Array.isArray(data?.asks) || !Array.isArray(data?.bids)) {
      throw new Error(
        `Korbit orderbook malformed payload for symbol=${pair}: shape=${describePayloadShape(json)} sample=${toPayloadSnippet(json)}`,
      );
    }

    const asks = (data.asks || []).map((a: any) => ({
      price: parseFloat(a.price || a[0]),
      qty: parseFloat(a.qty || a[1]),
    }));
    const bids = (data.bids || []).map((b: any) => ({
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
