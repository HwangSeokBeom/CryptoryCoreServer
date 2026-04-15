import { COIN_MAP } from '../../config/constants';
import { EXCHANGE_METADATA } from './exchange.metadata';
import type { CanonicalMarket, ExchangeId } from './exchange.types';

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

export function toCanonicalSymbol(symbol: string) {
  return normalizeSymbol(symbol);
}

export function isSupportedCanonicalSymbol(symbol: string) {
  return COIN_MAP.has(toCanonicalSymbol(symbol));
}

export function toExchangeSymbol(exchange: ExchangeId, symbol: string) {
  const canonical = toCanonicalSymbol(symbol);

  switch (exchange) {
    case 'upbit':
      return `KRW-${canonical}`;
    case 'bithumb':
      return `${canonical}_KRW`;
    case 'coinone':
      return canonical;
    case 'korbit':
      return `${canonical.toLowerCase()}_krw`;
    case 'binance':
      return `${canonical.toUpperCase()}USDT`;
  }
}

export function fromExchangeSymbol(exchange: ExchangeId, rawSymbol: string) {
  const normalized = rawSymbol.trim();

  switch (exchange) {
    case 'upbit':
      return normalized.replace(/^KRW-|^USDT-/i, '').toUpperCase();
    case 'bithumb':
      return normalized.replace(/_KRW$/i, '').replace(/^KRW-/i, '').toUpperCase();
    case 'coinone':
      return normalized.toUpperCase();
    case 'korbit':
      return normalized.replace(/_krw$/i, '').replace(/_usdt$/i, '').toUpperCase();
    case 'binance':
      return normalized.replace(/USDT$/i, '').toUpperCase();
  }
}

export function toCanonicalMarket(exchange: ExchangeId, symbol: string): CanonicalMarket {
  const canonicalSymbol = toCanonicalSymbol(symbol);
  const quoteCurrency = EXCHANGE_METADATA[exchange].quoteCurrency;
  const coin = COIN_MAP.get(canonicalSymbol);

  return {
    exchange,
    symbol: canonicalSymbol,
    market: `${canonicalSymbol}/${quoteCurrency}`,
    baseCurrency: canonicalSymbol,
    quoteCurrency,
    rawSymbol: toExchangeSymbol(exchange, canonicalSymbol),
    nameKo: coin?.nameKo,
    nameEn: coin?.nameEn,
  };
}
