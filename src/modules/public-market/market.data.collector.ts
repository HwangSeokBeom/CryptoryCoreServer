import WebSocket from 'ws';
import { buildBinancePublicWebSocketUrl } from '../../config/exchange.config';
import { updateSparkline } from '../../exchanges/ExchangeManager';
import { getUsdKrwRate } from '../../exchanges/exchangeRateService';
import {
  normalizeExchangeTimestampFromCandidates,
  toIsoTimestamp,
} from '../../providers/exchanges/provider-utils';
import { logger } from '../../utils/logger';
import { marketEventBus } from './market.event-bus';
import { publicMarketDataStore } from './market.data.store';
import {
  buildUnifiedMarketName,
  fromExchangeMarketSymbol,
  getExchangeQuoteCurrency,
  getSupportedSymbols,
  isSupportedSymbol,
  toExchangeMarketSymbol,
  toUnifiedSymbol,
} from './market.normalization';
import type {
  NormalizedMarketOrderbook,
  NormalizedMarketTicker,
  NormalizedMarketTrade,
  PublicMarketCollectorStatus,
} from './market.types';

const MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_ORDERBOOK_DEPTH = 15;

function safeNumber(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;

  return Number.isFinite(parsed) ? parsed : 0;
}

function roundTo(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sortAsks(asks: Array<{ price: number; qty: number }>) {
  return asks
    .filter((entry) => entry.price > 0 && entry.qty >= 0)
    .sort((left, right) => left.price - right.price)
    .slice(0, DEFAULT_ORDERBOOK_DEPTH);
}

function sortBids(bids: Array<{ price: number; qty: number }>) {
  return bids
    .filter((entry) => entry.price > 0 && entry.qty >= 0)
    .sort((left, right) => right.price - left.price)
    .slice(0, DEFAULT_ORDERBOOK_DEPTH);
}

function buildEventBase(exchange: string, rawSymbol: string, timestamp: number) {
  const symbol = fromExchangeMarketSymbol(exchange, rawSymbol);
  if (!isSupportedSymbol(symbol)) {
    return null;
  }

  const unifiedSymbol = toUnifiedSymbol(symbol);
  return {
    exchange,
    symbol: unifiedSymbol,
    market: buildUnifiedMarketName(exchange, unifiedSymbol),
    baseCurrency: unifiedSymbol,
    quoteCurrency: getExchangeQuoteCurrency(exchange),
    rawSymbol,
    timestamp,
  };
}

function persistTicker(ticker: NormalizedMarketTicker) {
  publicMarketDataStore.upsertTicker(ticker);
  updateSparkline(ticker.symbol, ticker.exchange, ticker.price);
  marketEventBus.emitTicker(ticker);
}

function persistOrderbook(orderbook: NormalizedMarketOrderbook) {
  publicMarketDataStore.upsertOrderbook(orderbook);
  marketEventBus.emitOrderbook(orderbook);
}

function persistTrade(trade: NormalizedMarketTrade) {
  publicMarketDataStore.appendTrade(trade);
  marketEventBus.emitTrade(trade);
}

function logInvalidTradeTimestamp(params: {
  exchange: string;
  raw: unknown;
  reason: string | null;
}) {
  logger.warn(
    {
      domain: 'public-market',
      exchange: params.exchange,
      rawTimestamp: params.raw,
      reason: params.reason,
    },
    `[TradeTimestampAPI] exchange=${params.exchange} invalidTimestamp raw=${String(params.raw)} reason=${params.reason ?? 'unknown'}`,
  );
}

abstract class BasePublicExchangeCollector {
  protected socket: WebSocket | null = null;
  protected reconnectAttempts = 0;
  protected stopped = true;
  protected reconnectTimer: NodeJS.Timeout | null = null;
  protected heartbeatTimer: NodeJS.Timeout | null = null;
  protected lastConnectedAt: number | null = null;
  protected lastMessageAt: number | null = null;
  protected lastError: string | null = null;

  constructor(
    protected readonly exchange: string,
    protected readonly symbols: string[],
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.socket?.terminate();
    this.socket = null;
  }

  protected abstract buildUrl(): string;
  protected abstract subscribe(): void;
  protected abstract handlePayload(payload: unknown): Promise<void>;

  protected startHeartbeat() {
    return;
  }

  protected sendJson(payload: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private connect() {
    const url = this.buildUrl();
    logger.info({ domain: 'public-market', exchange: this.exchange, url }, 'Connecting exchange public websocket');

    this.socket = new WebSocket(url);

    this.socket.on('open', () => {
      this.reconnectAttempts = 0;
      this.lastConnectedAt = Date.now();
      this.lastError = null;
      this.publishStatus(true);
      this.subscribe();
      this.startHeartbeat();
      logger.info({ domain: 'public-market', exchange: this.exchange }, 'Exchange public websocket connected');
    });

    this.socket.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      void this.handleRawMessage(raw);
    });

    this.socket.on('error', (err) => {
      this.lastError = err.message;
      logger.warn(
        { domain: 'public-market', exchange: this.exchange, err },
        'Exchange public websocket error',
      );
    });

    this.socket.on('close', (code, reasonBuffer) => {
      const reason = reasonBuffer.toString();
      logger.warn(
        { domain: 'public-market', exchange: this.exchange, code, reason },
        'Exchange public websocket closed',
      );
      this.publishStatus(false);
      this.scheduleReconnect(reason || `close:${code}`);
    });

    this.socket.on('ping', (data) => {
      this.socket?.pong(data);
    });
  }

  private async handleRawMessage(raw: WebSocket.RawData) {
    const text = raw.toString();
    if (!text) return;

    try {
      const payload = JSON.parse(text);
      await this.handlePayload(payload);
      this.publishStatus(true);
    } catch (err) {
      logger.debug(
        { domain: 'public-market', exchange: this.exchange, err, sample: text.slice(0, 250) },
        'Failed to parse exchange websocket payload',
      );
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped) return;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempts += 1;
    this.lastError = reason;
    this.publishStatus(false);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);

    logger.warn(
      {
        domain: 'public-market',
        exchange: this.exchange,
        reconnectAttempts: this.reconnectAttempts,
        reconnectDelayMs: delay,
        reason,
      },
      'Scheduling exchange public websocket reconnect',
    );
  }

  private publishStatus(connected: boolean) {
    const status: PublicMarketCollectorStatus = {
      exchange: this.exchange,
      connected,
      reconnectAttempts: this.reconnectAttempts,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
    };

    publicMarketDataStore.setCollectorStatus(status);
    marketEventBus.emitStatus(status);
  }
}

class UpbitCollector extends BasePublicExchangeCollector {
  protected buildUrl() {
    return 'wss://api.upbit.com/websocket/v1';
  }

  protected subscribe() {
    const codes = this.symbols.map((symbol) => `KRW-${symbol}`);
    this.sendJson([
      { ticket: `cryptory-upbit-${Date.now()}` },
      { type: 'ticker', codes, is_only_realtime: true },
      { type: 'orderbook', codes, is_only_realtime: true },
      { type: 'trade', codes, is_only_realtime: true },
      { format: 'DEFAULT' },
    ]);
  }

  protected async handlePayload(payload: any) {
    const type = payload.type ?? payload.ty;
    const rawSymbol = String(payload.code ?? payload.cd ?? '');
    const timestamp = safeNumber(payload.trade_timestamp ?? payload.ttms ?? payload.timestamp ?? Date.now());
    const base = buildEventBase(this.exchange, rawSymbol, timestamp);
    if (!base) return;

    if (type === 'ticker') {
      persistTicker({
        ...base,
        channel: 'tickers',
        price: safeNumber(payload.trade_price ?? payload.tp),
        change24h: roundTo(safeNumber(payload.signed_change_rate ?? payload.scr) * 100),
        volume24h: safeNumber(payload.acc_trade_price_24h ?? payload.atp24h),
        high24h: safeNumber(payload.high_price ?? payload.hp),
        low24h: safeNumber(payload.low_price ?? payload.lp),
      });
      return;
    }

    if (type === 'orderbook') {
      const units = payload.orderbook_units ?? payload.obu ?? [];
      const asks = sortAsks(
        units.map((unit: any) => ({
          price: safeNumber(unit.ask_price ?? unit.ap),
          qty: safeNumber(unit.ask_size ?? unit.as),
        })),
      );
      const bids = sortBids(
        units.map((unit: any) => ({
          price: safeNumber(unit.bid_price ?? unit.bp),
          qty: safeNumber(unit.bid_size ?? unit.bs),
        })),
      );

      persistOrderbook({
        ...base,
        channel: 'orderbook',
        asks,
        bids,
        bestAsk: asks[0]?.price ?? 0,
        bestBid: bids[0]?.price ?? 0,
      });
      return;
    }

    if (type === 'trade') {
      const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
        [payload.trade_timestamp, payload.ttms, payload.timestamp],
        { assumeTimezone: 'UTC' },
      );
      if (normalizedTimestamp.timestamp === null) {
        logInvalidTradeTimestamp({
          exchange: this.exchange,
          raw: normalizedTimestamp.raw,
          reason: normalizedTimestamp.reason,
        });
        return;
      }
      const tradeBase = buildEventBase(this.exchange, rawSymbol, normalizedTimestamp.timestamp);
      if (!tradeBase) return;

      persistTrade({
        ...tradeBase,
        channel: 'trades',
        tradeId: String(payload.sequential_id ?? payload.sid ?? `${rawSymbol}:${normalizedTimestamp.timestamp}`),
        price: safeNumber(payload.trade_price ?? payload.tp),
        quantity: safeNumber(payload.trade_volume ?? payload.tv),
        side: String(payload.ask_bid ?? payload.ab).toLowerCase() === 'ask' ? 'sell' : 'buy',
        executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
      });
    }
  }
}

class BinanceCollector extends BasePublicExchangeCollector {
  protected buildUrl() {
    const streams = this.symbols.flatMap((symbol) => {
      const pair = `${symbol.toLowerCase()}usdt`;
      return [`${pair}@ticker`, `${pair}@depth20@100ms`, `${pair}@trade`];
    });

    return buildBinancePublicWebSocketUrl(streams);
  }

  protected subscribe() {
    return;
  }

  protected async handlePayload(payload: any) {
    const wrapped = payload.data ?? payload;
    const stream = String(payload.stream ?? '');
    const streamSymbol = stream.split('@')[0]?.toUpperCase();
    const rawSymbol = String(wrapped.s ?? streamSymbol ?? '');
    const type = wrapped.e ?? (stream.includes('@depth') ? 'depth' : '');
    const rate = await getUsdKrwRate();
    const timestamp = safeNumber(wrapped.E ?? wrapped.T ?? Date.now());
    const base = buildEventBase(this.exchange, rawSymbol, timestamp);
    if (!base) return;

    if (type === '24hrTicker') {
      persistTicker({
        ...base,
        channel: 'tickers',
        price: safeNumber(wrapped.c) * rate,
        change24h: roundTo(safeNumber(wrapped.P)),
        volume24h: safeNumber(wrapped.q) * rate,
        high24h: safeNumber(wrapped.h) * rate,
        low24h: safeNumber(wrapped.l) * rate,
      });
      return;
    }

    if (type === 'depth') {
      const asks = sortAsks(
        (wrapped.asks ?? []).map((ask: any) => ({
          price: safeNumber(ask[0]) * rate,
          qty: safeNumber(ask[1]),
        })),
      );
      const bids = sortBids(
        (wrapped.bids ?? []).map((bid: any) => ({
          price: safeNumber(bid[0]) * rate,
          qty: safeNumber(bid[1]),
        })),
      );

      persistOrderbook({
        ...base,
        channel: 'orderbook',
        asks,
        bids,
        bestAsk: asks[0]?.price ?? 0,
        bestBid: bids[0]?.price ?? 0,
      });
      return;
    }

    if (type === 'trade' || type === 'aggTrade') {
      const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
        [wrapped.T, wrapped.E, wrapped.time],
        { assumeTimezone: 'UTC' },
      );
      if (normalizedTimestamp.timestamp === null) {
        logInvalidTradeTimestamp({
          exchange: this.exchange,
          raw: normalizedTimestamp.raw,
          reason: normalizedTimestamp.reason,
        });
        return;
      }
      const tradeBase = buildEventBase(this.exchange, rawSymbol, normalizedTimestamp.timestamp);
      if (!tradeBase) return;

      persistTrade({
        ...tradeBase,
        channel: 'trades',
        tradeId: String(wrapped.t ?? wrapped.a ?? `${rawSymbol}:${normalizedTimestamp.timestamp}`),
        price: safeNumber(wrapped.p) * rate,
        quantity: safeNumber(wrapped.q),
        side: wrapped.m ? 'sell' : 'buy',
        executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
      });
    }
  }
}

class BithumbCollector extends BasePublicExchangeCollector {
  private readonly books = new Map<string, { asks: Map<number, number>; bids: Map<number, number> }>();

  protected buildUrl() {
    return 'wss://pubwss.bithumb.com/pub/ws';
  }

  protected subscribe() {
    const symbols = this.symbols.map((symbol) => `${symbol}_KRW`);
    this.sendJson({ type: 'ticker', symbols, tickTypes: ['24H'], isOnlyRealtime: true });
    this.sendJson({ type: 'orderbooksnapshot', symbols });
    this.sendJson({ type: 'orderbookdepth', symbols, isOnlyRealtime: true });
    this.sendJson({ type: 'transaction', symbols, isOnlyRealtime: true });
  }

  protected async handlePayload(payload: any) {
    if (payload.status === '0000') {
      return;
    }

    const type = String(payload.type ?? '');
    const content = payload.content ?? {};

    if (type === 'ticker') {
      const rawSymbol = String(content.symbol ?? '');
      const base = buildEventBase(this.exchange, rawSymbol, Date.now());
      if (!base) return;

      persistTicker({
        ...base,
        channel: 'tickers',
        price: safeNumber(content.closePrice),
        change24h: roundTo(safeNumber(content.chgRate)),
        volume24h: safeNumber(content.value),
        high24h: safeNumber(content.highPrice),
        low24h: safeNumber(content.lowPrice),
      });
      return;
    }

    if (type === 'orderbooksnapshot') {
      const rawSymbol = String(content.symbol ?? '');
      const asks = sortAsks(
        (content.asks ?? []).map((ask: any) => ({
          price: safeNumber(Array.isArray(ask) ? ask[0] : ask.price),
          qty: safeNumber(Array.isArray(ask) ? ask[1] : ask.quantity),
        })),
      );
      const bids = sortBids(
        (content.bids ?? []).map((bid: any) => ({
          price: safeNumber(Array.isArray(bid) ? bid[0] : bid.price),
          qty: safeNumber(Array.isArray(bid) ? bid[1] : bid.quantity),
        })),
      );

      this.books.set(rawSymbol, {
        asks: new Map(asks.map((entry) => [entry.price, entry.qty])),
        bids: new Map(bids.map((entry) => [entry.price, entry.qty])),
      });

      this.emitBook(rawSymbol, safeNumber(content.datetime ?? Date.now()));
      return;
    }

    if (type === 'orderbookdepth') {
      const updates = content.list ?? [];
      for (const update of updates) {
        const rawSymbol = String(update.symbol ?? '');
        const existing = this.books.get(rawSymbol) ?? { asks: new Map<number, number>(), bids: new Map<number, number>() };
        const side = String(update.orderType ?? '').toLowerCase();
        const price = safeNumber(update.price);
        const qty = safeNumber(update.quantity);

        if (side === 'ask') {
          if (qty <= 0) existing.asks.delete(price);
          else existing.asks.set(price, qty);
        } else {
          if (qty <= 0) existing.bids.delete(price);
          else existing.bids.set(price, qty);
        }

        this.books.set(rawSymbol, existing);
      }

      const rawSymbol = String(updates[0]?.symbol ?? '');
      if (rawSymbol) {
        this.emitBook(rawSymbol, safeNumber(content.datetime ?? Date.now()));
      }
      return;
    }

    if (type === 'transaction') {
      const trades = content.list ?? [];
      for (const trade of trades) {
        const rawSymbol = String(trade.symbol ?? '');
        const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
          [trade.contDtm, trade.transaction_date, trade.datetime, content.datetime],
          { assumeTimezone: 'KST' },
        );
        if (normalizedTimestamp.timestamp === null) {
          logInvalidTradeTimestamp({
            exchange: this.exchange,
            raw: normalizedTimestamp.raw,
            reason: normalizedTimestamp.reason,
          });
          continue;
        }
        const base = buildEventBase(this.exchange, rawSymbol, normalizedTimestamp.timestamp);
        if (!base) continue;

        persistTrade({
          ...base,
          channel: 'trades',
          tradeId: String(trade.contNo ?? trade.transaction_date ?? `${rawSymbol}:${normalizedTimestamp.timestamp}`),
          price: safeNumber(trade.contPrice ?? trade.price),
          quantity: safeNumber(trade.contQty ?? trade.quantity),
          side: String(trade.buySellGb ?? '') === '1' ? 'sell' : 'buy',
          executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
        });
      }
    }
  }

  private emitBook(rawSymbol: string, timestamp: number) {
    const book = this.books.get(rawSymbol);
    if (!book) return;

    const base = buildEventBase(this.exchange, rawSymbol, timestamp);
    if (!base) return;

    const asks = sortAsks(Array.from(book.asks.entries()).map(([price, qty]) => ({ price, qty })));
    const bids = sortBids(Array.from(book.bids.entries()).map(([price, qty]) => ({ price, qty })));

    persistOrderbook({
      ...base,
      channel: 'orderbook',
      asks,
      bids,
      bestAsk: asks[0]?.price ?? 0,
      bestBid: bids[0]?.price ?? 0,
    });
  }
}

class CoinoneCollector extends BasePublicExchangeCollector {
  protected buildUrl() {
    return 'wss://stream.coinone.co.kr';
  }

  protected subscribe() {
    for (const symbol of this.symbols) {
      const topic = {
        quote_currency: 'KRW',
        target_currency: symbol,
      };

      this.sendJson({ request_type: 'SUBSCRIBE', channel: 'TICKER', topic, format: 'DEFAULT' });
      this.sendJson({ request_type: 'SUBSCRIBE', channel: 'ORDERBOOK', topic, format: 'DEFAULT' });
      this.sendJson({ request_type: 'SUBSCRIBE', channel: 'TRADE', topic, format: 'DEFAULT' });
    }
  }

  protected startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.sendJson({ request_type: 'PING' });
    }, 15 * 60 * 1000);
  }

  protected async handlePayload(payload: any) {
    const channel = String(payload.channel ?? payload.c ?? '').toUpperCase();
    const data = payload.data ?? payload.d ?? {};
    const rawSymbol = String(data.target_currency ?? data.tc ?? '');
    const timestamp = safeNumber(data.timestamp ?? data.ts ?? Date.now());
    const base = buildEventBase(this.exchange, rawSymbol, timestamp);
    if (!base) return;

    if (channel === 'TICKER') {
      const price = safeNumber(data.last ?? data.close ?? data.price);
      const yesterdayLast = safeNumber(data.yesterday_last ?? data.prev_close ?? data.open);
      const change24h =
        yesterdayLast > 0 ? ((price - yesterdayLast) / yesterdayLast) * 100 : safeNumber(data.change_rate ?? 0);

      persistTicker({
        ...base,
        channel: 'tickers',
        price,
        change24h: roundTo(change24h),
        volume24h: safeNumber(data.quote_volume ?? data.volume ?? 0),
        high24h: safeNumber(data.high ?? data.high_price),
        low24h: safeNumber(data.low ?? data.low_price),
      });
      return;
    }

    if (channel === 'ORDERBOOK') {
      const asks = sortAsks(
        (data.asks ?? []).map((ask: any) => ({
          price: safeNumber(ask.price ?? ask[0]),
          qty: safeNumber(ask.qty ?? ask.quantity ?? ask[1]),
        })),
      );
      const bids = sortBids(
        (data.bids ?? []).map((bid: any) => ({
          price: safeNumber(bid.price ?? bid[0]),
          qty: safeNumber(bid.qty ?? bid.quantity ?? bid[1]),
        })),
      );

      persistOrderbook({
        ...base,
        channel: 'orderbook',
        asks,
        bids,
        bestAsk: asks[0]?.price ?? 0,
        bestBid: bids[0]?.price ?? 0,
      });
      return;
    }

    if (channel === 'TRADE') {
      const trades = Array.isArray(data) ? data : Array.isArray(data.trades) ? data.trades : [data];
      for (const trade of trades) {
        const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
          [trade.timestamp, trade.ts, data.timestamp, data.ts],
          { assumeTimezone: 'UTC' },
        );
        if (normalizedTimestamp.timestamp === null) {
          logInvalidTradeTimestamp({
            exchange: this.exchange,
            raw: normalizedTimestamp.raw,
            reason: normalizedTimestamp.reason,
          });
          continue;
        }
        const tradeBase = buildEventBase(this.exchange, rawSymbol, normalizedTimestamp.timestamp);
        if (!tradeBase) continue;

        persistTrade({
          ...tradeBase,
          channel: 'trades',
          tradeId: String(trade.id ?? trade.trade_id ?? `${rawSymbol}:${normalizedTimestamp.timestamp}`),
          price: safeNumber(trade.price ?? trade.last),
          quantity: safeNumber(trade.qty ?? trade.quantity),
          side: trade.is_buy === true || trade.side === 'BUY' ? 'buy' : 'sell',
          timestamp: normalizedTimestamp.timestamp,
          executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
        });
      }
    }
  }
}

class KorbitCollector extends BasePublicExchangeCollector {
  protected buildUrl() {
    return 'wss://ws-api.korbit.co.kr/v2/public';
  }

  protected subscribe() {
    const symbols = this.symbols.map((symbol) => `${symbol.toLowerCase()}_krw`);
    this.sendJson([
      { method: 'subscribe', type: 'ticker', symbols },
      { method: 'subscribe', type: 'orderbook', symbols },
      { method: 'subscribe', type: 'trade', symbols },
    ]);
  }

  protected async handlePayload(payload: any) {
    const type = String(payload.type ?? '');
    const rawSymbol = String(payload.symbol ?? '');
    const timestamp = safeNumber(payload.timestamp ?? payload.data?.timestamp ?? Date.now());
    const base = buildEventBase(this.exchange, rawSymbol, timestamp);
    if (!base) return;

    if (type === 'ticker') {
      const data = payload.data ?? {};
      persistTicker({
        ...base,
        channel: 'tickers',
        price: safeNumber(data.close),
        change24h: roundTo(safeNumber(data.priceChangePercent)),
        volume24h: safeNumber(data.quoteVolume),
        high24h: safeNumber(data.high),
        low24h: safeNumber(data.low),
        timestamp: safeNumber(data.lastTradedAt ?? timestamp),
      });
      return;
    }

    if (type === 'orderbook') {
      const data = payload.data ?? {};
      const asks = sortAsks(
        (data.asks ?? []).map((ask: any) => ({
          price: safeNumber(ask.price ?? ask[0]),
          qty: safeNumber(ask.qty ?? ask.amount ?? ask[1]),
        })),
      );
      const bids = sortBids(
        (data.bids ?? []).map((bid: any) => ({
          price: safeNumber(bid.price ?? bid[0]),
          qty: safeNumber(bid.qty ?? bid.amount ?? bid[1]),
        })),
      );

      persistOrderbook({
        ...base,
        channel: 'orderbook',
        asks,
        bids,
        bestAsk: asks[0]?.price ?? 0,
        bestBid: bids[0]?.price ?? 0,
        timestamp: safeNumber(data.timestamp ?? timestamp),
      });
      return;
    }

    if (type === 'trade') {
      const trades = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.data?.trades) ? payload.data.trades : [payload.data];
      for (const trade of trades) {
        const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
          [trade.timestamp, payload.timestamp, payload.data?.timestamp],
          { assumeTimezone: 'UTC' },
        );
        if (normalizedTimestamp.timestamp === null) {
          logInvalidTradeTimestamp({
            exchange: this.exchange,
            raw: normalizedTimestamp.raw,
            reason: normalizedTimestamp.reason,
          });
          continue;
        }
        const tradeBase = buildEventBase(this.exchange, rawSymbol, normalizedTimestamp.timestamp);
        if (!tradeBase) continue;

        persistTrade({
          ...tradeBase,
          channel: 'trades',
          tradeId: String(trade.id ?? trade.tradeId ?? `${rawSymbol}:${normalizedTimestamp.timestamp}`),
          price: safeNumber(trade.price),
          quantity: safeNumber(trade.amount ?? trade.qty),
          side: String(trade.takerSide ?? trade.side ?? '').toLowerCase() === 'buy' ? 'buy' : 'sell',
          executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
        });
      }
    }
  }
}

class PublicMarketDataCollector {
  private readonly collectors = [
    new UpbitCollector('upbit', getSupportedSymbols()),
    new BithumbCollector('bithumb', getSupportedSymbols()),
    new CoinoneCollector('coinone', getSupportedSymbols()),
    new KorbitCollector('korbit', getSupportedSymbols()),
    new BinanceCollector('binance', getSupportedSymbols()),
  ];

  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.collectors.forEach((collector) => collector.start());
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.collectors.forEach((collector) => collector.stop());
  }
}

export const publicMarketDataCollector = new PublicMarketDataCollector();
