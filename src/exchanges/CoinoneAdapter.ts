import { ExchangeAdapter, NormalizedTicker, NormalizedOrderbook, NormalizedCandle } from './ExchangeAdapter';
import { ExchangeRequestError } from '../core/exchange/errors';
import { logger } from '../utils/logger';
import { parseCoinoneTickersResponse } from '../providers/exchanges/coinone.mapper';

const BASE_URL = 'https://api.coinone.co.kr';
const TICKER_TIMEOUT_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 3_000;
const SLOW_LOG_MS = 800;

async function fetchJsonWithTimeout(url: string, timeoutMs: number, operation: string) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    logger.debug(
      { domain: 'market-provider', exchange: 'coinone', operation, event: 'fetch_start', url },
      'Coinone adapter fetch start',
    );
    const res = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    const log = latencyMs > SLOW_LOG_MS ? logger.warn.bind(logger) : logger.debug.bind(logger);
    log(
      { domain: 'market-provider', exchange: 'coinone', operation, event: 'fetch_end', latencyMs, slow: latencyMs > SLOW_LOG_MS },
      'Coinone adapter fetch end',
    );

    if (!res.ok) {
      const responseBody = await res.text();
      throw new ExchangeRequestError('coinone', res.status, url, `Coinone ${operation} request failed`, responseBody);
    }

    return (await res.json()) as any;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    logger.warn(
      { domain: 'market-provider', exchange: 'coinone', operation, event: 'fetch_failed', latencyMs, err: error },
      'Coinone adapter fetch failed',
    );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export class CoinoneAdapter implements ExchangeAdapter {
  readonly id = 'coinone';
  readonly name = '코인원';

  async fetchTickers(symbols: string[]): Promise<NormalizedTicker[]> {
    const url = `${BASE_URL}/public/v2/ticker_new/KRW?additional_data=true`;
    const json = await fetchJsonWithTimeout(url, TICKER_TIMEOUT_MS, 'tickers');
    const parsed = parseCoinoneTickersResponse(json, symbols);

    parsed.dropped.forEach(({ symbol, reason }) => {
      logger.debug(
        { domain: 'market-provider', exchange: 'coinone', operation: 'tickers', symbol, reason },
        'Coinone ticker item dropped during normalization',
      );
    });

    if (parsed.missingSymbols.length > 0) {
      logger.debug(
        {
          domain: 'market-provider',
          exchange: 'coinone',
          operation: 'tickers',
          missingSymbols: parsed.missingSymbols,
        },
        'Coinone requested tickers missing from upstream payload',
      );
    }

    return parsed.tickers;
  }

  async fetchOrderbook(symbol: string, depth = 10): Promise<NormalizedOrderbook> {
    const url = `${BASE_URL}/public/v2/orderbook/KRW/${symbol}?size=${depth}`;
    const json = await fetchJsonWithTimeout(url, DEFAULT_TIMEOUT_MS, 'orderbook');
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

    const url = `${BASE_URL}/public/v2/chart/KRW/${symbol}?${params.toString()}`;
    const json = await fetchJsonWithTimeout(url, DEFAULT_TIMEOUT_MS, 'candles');
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
