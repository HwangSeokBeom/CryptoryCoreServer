import type { ExchangeId } from '../../core/exchange/exchange.types';

export const REPRESENTATIVE_MARKET_SYMBOLS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'ADA', 'TRX', 'SUI'] as const;

const REPRESENTATIVE_SYMBOL_SET = new Set<string>(REPRESENTATIVE_MARKET_SYMBOLS);
const REPRESENTATIVE_MARKET_SYMBOLS_BY_EXCHANGE: Record<ExchangeId, readonly string[]> = {
  upbit: ['BTC', 'XRP', 'ETH', 'SOL', 'DOGE', 'ADA', 'SUI', 'TRX'],
  bithumb: ['BTC', 'XRP', 'ETH', 'DOGE', 'SOL', 'ADA', 'TRX', 'ETC'],
  coinone: ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'ADA', 'SUI', 'TRX'],
  korbit: ['BTC', 'ETH', 'XRP', 'ADA', 'DOGE', 'SOL', 'ETC', 'TRX'],
  binance: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'BNB', 'SUI'],
} as const;

export const DEFAULT_TOP_SNAPSHOT_LIMIT = 24;
export const DEFAULT_VISIBLE_SNAPSHOT_LIMIT = 72;
export const DEFAULT_COMPARABLE_KIMCHI_SYMBOL_LIMIT = 24;
export const DEFAULT_MARKET_OVERVIEW_LIMIT = 8;
export const DEFAULT_MARKET_LIST_LIMIT = 30;
export const DEFAULT_KIMCHI_REPRESENTATIVE_LIMIT = 8;
export const DEFAULT_KIMCHI_LIST_LIMIT = 30;

export const SNAPSHOT_SCOPE_SPARKLINE_POINT_LIMIT = {
  top: 8,
  visible: 12,
  full: 20,
  symbols: 20,
} as const;

export const PRIORITY_FRESHNESS_TARGET_MS = {
  kimchiTop: 8_000,
  kimchiDefault: 20_000,
  snapshotTop: 10_000,
  snapshotDefault: 30_000,
} as const;

export function isRepresentativeMarketSymbol(symbol: string) {
  return REPRESENTATIVE_SYMBOL_SET.has(symbol);
}

export function getRepresentativeMarketSymbolRank(symbol: string, exchange?: ExchangeId) {
  const orderedSymbols = exchange ? REPRESENTATIVE_MARKET_SYMBOLS_BY_EXCHANGE[exchange] ?? REPRESENTATIVE_MARKET_SYMBOLS : REPRESENTATIVE_MARKET_SYMBOLS;
  const index = orderedSymbols.indexOf(symbol);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

export function compareRepresentativeSymbols(left: string, right: string, exchange?: ExchangeId) {
  return getRepresentativeMarketSymbolRank(left, exchange) - getRepresentativeMarketSymbolRank(right, exchange);
}

export function getRepresentativeSymbolsForExchange(symbols: Iterable<string>, exchange?: ExchangeId) {
  const available = new Set(symbols);
  const orderedSymbols = exchange ? REPRESENTATIVE_MARKET_SYMBOLS_BY_EXCHANGE[exchange] ?? REPRESENTATIVE_MARKET_SYMBOLS : REPRESENTATIVE_MARKET_SYMBOLS;
  return orderedSymbols.filter((symbol) => available.has(symbol));
}

export function getStreamingSilenceThresholdMs(exchange: ExchangeId) {
  switch (exchange) {
    case 'bithumb':
    case 'coinone':
      return 12_000;
    case 'korbit':
      return 18_000;
    case 'upbit':
    case 'binance':
    default:
      return 15_000;
  }
}

export function getPollingFallbackIntervalMs(exchange: ExchangeId) {
  switch (exchange) {
    case 'bithumb':
    case 'coinone':
      return 8_000;
    case 'korbit':
      return 10_000;
    case 'upbit':
    case 'binance':
    default:
      return 15_000;
  }
}
