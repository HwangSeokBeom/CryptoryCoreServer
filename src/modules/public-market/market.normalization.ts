import { COINS, COIN_MAP, EXCHANGES, EXCHANGE_MAP } from '../../config/constants';
import type { MarketCatalogEntry } from './market.types';

const DOMESTIC_EXCHANGE_IDS = new Set(['upbit', 'bithumb', 'coinone', 'korbit']);

export function toUnifiedSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function toExchangeMarketSymbol(exchangeId: string, symbol: string): string {
  const unified = toUnifiedSymbol(symbol);

  switch (exchangeId) {
    case 'upbit':
      return `KRW-${unified}`;
    case 'bithumb':
      return `${unified}_KRW`;
    case 'coinone':
      return `${unified}`;
    case 'korbit':
      return `${unified.toLowerCase()}_krw`;
    case 'binance':
      return `${unified.toLowerCase()}usdt`;
    default:
      return unified;
  }
}

export function fromExchangeMarketSymbol(exchangeId: string, rawSymbol: string): string {
  const normalized = rawSymbol.trim();

  switch (exchangeId) {
    case 'upbit':
      return normalized.replace('KRW-', '').replace('USDT-', '').toUpperCase();
    case 'bithumb':
      if (normalized.includes('_')) {
        return normalized.split('_')[0]?.toUpperCase() ?? normalized.toUpperCase();
      }
      return normalized.replace('KRW-', '').toUpperCase();
    case 'coinone':
      return normalized.toUpperCase();
    case 'korbit':
      return normalized.replace('_krw', '').replace('_usdt', '').toUpperCase();
    case 'binance':
      return normalized.replace(/usdt$/i, '').toUpperCase();
    default:
      return normalized.toUpperCase();
  }
}

export function getExchangeQuoteCurrency(exchangeId: string): 'KRW' | 'USDT' {
  return EXCHANGE_MAP.get(exchangeId)?.quoteCurrency ?? 'KRW';
}

export function buildUnifiedMarketName(exchangeId: string, symbol: string): string {
  return `${toUnifiedSymbol(symbol)}/${getExchangeQuoteCurrency(exchangeId)}`;
}

export function isDomesticExchange(exchangeId: string): boolean {
  return DOMESTIC_EXCHANGE_IDS.has(exchangeId);
}

export function getSupportedSymbols(): string[] {
  return COINS.map((coin) => coin.symbol);
}

export function isSupportedSymbol(symbol: string): boolean {
  return COIN_MAP.has(toUnifiedSymbol(symbol));
}

export function getMarketCatalog(): MarketCatalogEntry[] {
  return EXCHANGES.flatMap((exchange) =>
    COINS.map((coin) => ({
      exchange: exchange.id,
      exchangeName: exchange.name,
      symbol: coin.symbol,
      market: buildUnifiedMarketName(exchange.id, coin.symbol),
      baseCurrency: coin.symbol,
      quoteCurrency: exchange.quoteCurrency,
      nameKo: coin.nameKo,
      nameEn: coin.nameEn,
      rawSymbol: toExchangeMarketSymbol(exchange.id, coin.symbol),
    })),
  );
}

export function searchMarketCatalog(query: string): MarketCatalogEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return getMarketCatalog();
  }

  return getMarketCatalog().filter((entry) => {
    return [
      entry.symbol,
      entry.market,
      entry.nameKo,
      entry.nameEn,
      entry.exchange,
      entry.exchangeName,
      entry.rawSymbol,
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
  });
}
