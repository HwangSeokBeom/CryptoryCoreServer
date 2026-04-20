import { ExchangeAdapter, NormalizedTicker, NormalizedOrderbook, NormalizedCandle } from './ExchangeAdapter';
import {
  ExchangeMalformedPayloadError,
  ExchangeRateLimitError,
  ExchangeRequestError,
  ExchangeTemporaryUnavailableError,
  ExchangeUnsupportedSymbolError,
} from '../core/exchange/errors';
import { logger } from '../utils/logger';

const BASE_URL = 'https://api.bithumb.com';
const TICKER_TIMEOUT_MS = 1_500;
const SLOW_LOG_MS = 800;

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

async function fetchWithTimeout(url: string, timeoutMs: number, operation: string) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    logger.debug(
      { domain: 'market-provider', exchange: 'bithumb', operation, event: 'fetch_start', url },
      'Bithumb adapter fetch start',
    );
    const response = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    const log = latencyMs > SLOW_LOG_MS ? logger.warn.bind(logger) : logger.debug.bind(logger);
    log(
      { domain: 'market-provider', exchange: 'bithumb', operation, event: 'fetch_end', latencyMs, slow: latencyMs > SLOW_LOG_MS },
      'Bithumb adapter fetch end',
    );
    return response;
  } catch (error) {
    logger.warn(
      {
        domain: 'market-provider',
        exchange: 'bithumb',
        operation,
        event: 'fetch_failed',
        latencyMs: Date.now() - startedAt,
        err: error,
      },
      'Bithumb adapter fetch failed',
    );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function classifyBithumbPayloadError(symbol: string, payload: any) {
  const status = String(payload?.status ?? '');
  const message = String(payload?.message ?? payload?.error ?? '').trim();
  const snippet = toPayloadSnippet(payload);
  const summary = `Bithumb orderbook ${message || 'upstream error'} for ${symbol}_KRW${snippet ? ` payload=${snippet}` : ''}`;

  if (/상장 코인 아님|unsupported|invalid symbol|not listed/i.test(message)) {
    return new ExchangeUnsupportedSymbolError('bithumb', summary, 200, symbol, snippet);
  }
  if (status === '5600' || /too[_\s-]?many[_\s-]?requests|rate limit/i.test(message)) {
    return new ExchangeRateLimitError('bithumb', summary, 200, symbol, snippet);
  }
  return new ExchangeTemporaryUnavailableError('bithumb', summary, 200, symbol, snippet);
}

export class BithumbAdapter implements ExchangeAdapter {
  readonly id = 'bithumb';
  readonly name = '빗썸';

  async fetchTickers(symbols: string[]): Promise<NormalizedTicker[]> {
    const url = `${BASE_URL}/public/ticker/ALL_KRW`;
    const res = await fetchWithTimeout(url, TICKER_TIMEOUT_MS, 'tickers');
    if (!res.ok) {
      const responseBody = await res.text();
      throw new ExchangeRequestError('bithumb', res.status, url, `Bithumb ticker HTTP ${res.status}`, responseBody);
    }
    const json = (await res.json()) as any;
    if (String(json?.status ?? '') !== '0000') {
      throw classifyBithumbPayloadError('ALL', json);
    }
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
      const message = `Bithumb orderbook HTTP ${res.status} for ${symbol}_KRW${snippet ? ` body=${snippet}` : ''}`;
      if (res.status === 429) {
        throw new ExchangeRateLimitError('bithumb', message, res.status, symbol, snippet);
      }
      if ([408, 425, 500, 502, 503, 504].includes(res.status)) {
        throw new ExchangeTemporaryUnavailableError('bithumb', message, res.status, symbol, snippet);
      }
      throw new Error(message);
    }

    const json = (await res.json()) as any;
    if (String(json?.status ?? '') !== '0000') {
      throw classifyBithumbPayloadError(symbol, json);
    }
    const data = resolveOrderbookPayload(json);
    if (!Array.isArray(data?.asks) || !Array.isArray(data?.bids)) {
      throw new ExchangeMalformedPayloadError(
        'bithumb',
        `Bithumb orderbook malformed payload for ${symbol}_KRW: shape=${describePayloadShape(json)} sample=${toPayloadSnippet(json)}`,
        200,
        symbol,
        toPayloadSnippet(json),
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
      time:
        item.candle_date_time_utc
        ?? item.candle_date_time_kst
        ?? item.timestamp
        ?? Date.now(),
      open: parseFloat(item.opening_price),
      high: parseFloat(item.high_price),
      low: parseFloat(item.low_price),
      close: parseFloat(item.trade_price),
      volume: parseFloat(item.candle_acc_trade_volume),
    }));
  }
}
