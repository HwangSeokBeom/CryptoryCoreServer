import { COIN_MAP } from '../../config/constants';
import { EXCHANGE_METADATA } from './exchange.metadata';
import type { CanonicalMarket, ExchangeId } from './exchange.types';

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase().replace(/\s+/g, '');
}

export function toCanonicalSymbol(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    return '';
  }

  const exchangePrefixMatch = normalized.match(/^(KRW|USDT)[-_/]([A-Z0-9]+)$/i);
  if (exchangePrefixMatch) {
    return exchangePrefixMatch[2];
  }

  const exchangeSuffixMatch = normalized.match(/^([A-Z0-9]+)[-_/](KRW|USDT)$/i);
  if (exchangeSuffixMatch) {
    return exchangeSuffixMatch[1];
  }

  if (/^[A-Z0-9]+USDT$/i.test(normalized) && normalized.length > 4) {
    return normalized.slice(0, -4);
  }

  if (/^(KRW|USDT)[A-Z0-9]+$/i.test(normalized)) {
    const prefixLength = normalized.startsWith('KRW') ? 3 : 4;
    const candidate = normalized.slice(prefixLength);
    if (COIN_MAP.has(candidate)) {
      return candidate;
    }
  }

  if (/^[A-Z0-9]+(KRW|USDT)$/i.test(normalized)) {
    const suffixLength = normalized.endsWith('KRW') ? 3 : 4;
    const candidate = normalized.slice(0, -suffixLength);
    if (COIN_MAP.has(candidate)) {
      return candidate;
    }
  }

  return normalized;
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
