import { COIN_MAP } from '../../config/constants';
import {
  getAssetRegistryMetadata,
  compactAssetToken,
  isKnownQuoteAssetToken,
  normalizeAssetToken,
  resolveAssetAliasCandidate,
  splitKnownQuotePair,
} from './asset.registry';
import { EXCHANGE_METADATA } from './exchange.metadata';
import { resolveIconUrl } from './icon.resolver';
import { getSupportedCandleIntervals } from './interval.mapper';
import type { CanonicalMarket, ExchangeId } from './exchange.types';

export type CanonicalAssetResolution = {
  canonicalAssetKey: string | null;
  aliasHit: boolean;
  matchedBy: 'canonicalAssetKey' | 'symbol' | 'exchangeSymbol' | 'rawSymbol' | 'exchange_alias' | 'global_alias' | 'normalized' | 'unresolved';
  input: string | null;
};

function normalizeSymbol(symbol: string) {
  return normalizeAssetToken(symbol);
}

function isFiatQuoteToken(value: string) {
  return ['KRW', 'USD', 'EUR', 'TRY', 'BRL'].includes(compactAssetToken(value));
}

function isFiatOrStableQuoteToken(value: string) {
  return ['KRW', 'USD', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USDP', 'DAI', 'EUR', 'TRY', 'BRL']
    .includes(compactAssetToken(value));
}

export function toCanonicalSymbol(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    return '';
  }

  const separatedPairMatch = normalized.match(/^([^/_-]+)[-_/]([^/_-]+)$/i);
  if (separatedPairMatch) {
    const left = compactAssetToken(separatedPairMatch[1]);
    const right = compactAssetToken(separatedPairMatch[2]);
    if (isFiatOrStableQuoteToken(left) && isFiatOrStableQuoteToken(right)) {
      const leftIsFiat = isFiatQuoteToken(left);
      const rightIsFiat = isFiatQuoteToken(right);
      if (leftIsFiat !== rightIsFiat) {
        return leftIsFiat ? right : left;
      }
      return left || right;
    }
    if (isFiatOrStableQuoteToken(left) && right) {
      return right;
    }
    if (isFiatOrStableQuoteToken(right) && left) {
      return left;
    }
    if (isKnownQuoteAssetToken(right) && left) {
      return left;
    }
    if (isKnownQuoteAssetToken(left) && right) {
      return right;
    }
  }

  const compactPair = splitKnownQuotePair(normalized);
  if (compactPair) {
    return compactPair.baseAsset;
  }

  const compact = compactAssetToken(normalized);
  if (compact !== normalized) {
    return compact;
  }

  return normalized;
}

export function isSupportedCanonicalSymbol(symbol: string) {
  return COIN_MAP.has(toCanonicalSymbol(symbol));
}

export function resolveCanonicalAssetKey(params: {
  exchange?: ExchangeId;
  canonicalAssetKey?: string | null;
  symbol?: string | null;
  exchangeSymbol?: string | null;
  rawSymbol?: string | null;
}): CanonicalAssetResolution {
  const candidates: Array<{ value?: string | null; matchedBy: CanonicalAssetResolution['matchedBy'] }> = [
    { value: params.canonicalAssetKey, matchedBy: 'canonicalAssetKey' },
    { value: params.symbol, matchedBy: 'symbol' },
    { value: params.exchangeSymbol, matchedBy: 'exchangeSymbol' },
    { value: params.rawSymbol, matchedBy: 'rawSymbol' },
  ];

  for (const candidate of candidates) {
    if (!candidate.value) {
      continue;
    }

    const normalized = toCanonicalSymbol(candidate.value);
    if (!normalized) {
      continue;
    }

    const alias = resolveAssetAliasCandidate(candidate.value, params.exchange)
      ?? resolveAssetAliasCandidate(normalized, params.exchange);
    if (alias?.canonicalAssetKey) {
      return {
        canonicalAssetKey: alias.canonicalAssetKey,
        aliasHit: true,
        matchedBy: alias.matchedBy,
        input: candidate.value,
      };
    }

    return {
      canonicalAssetKey: normalized,
      aliasHit: false,
      matchedBy: candidate.matchedBy === 'canonicalAssetKey' ? 'canonicalAssetKey' : 'normalized',
      input: candidate.value,
    };
  }

  return {
    canonicalAssetKey: null,
    aliasHit: false,
    matchedBy: 'unresolved',
    input: null,
  };
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
      return toCanonicalSymbol(normalized);
    case 'bithumb':
      return toCanonicalSymbol(normalized);
    case 'coinone':
      return toCanonicalSymbol(normalized);
    case 'korbit':
      return toCanonicalSymbol(normalized);
    case 'binance':
      return toCanonicalSymbol(normalized);
  }
}

export function toCanonicalMarket(exchange: ExchangeId, symbol: string): CanonicalMarket {
  const canonicalSymbol = toCanonicalSymbol(symbol);
  const quoteCurrency = EXCHANGE_METADATA[exchange].quoteCurrency;
  const coin = COIN_MAP.get(canonicalSymbol);
  const assetMetadata = getAssetRegistryMetadata(canonicalSymbol, canonicalSymbol);
  const rawSymbol = toExchangeSymbol(exchange, canonicalSymbol);
  const canonicalMarketId = `${canonicalSymbol}/${quoteCurrency}`;
  const quoteOnlyAsset = assetMetadata.assetType === 'fiat';
  const graphSupported = !quoteOnlyAsset && assetMetadata.assetType !== 'synthetic' && assetMetadata.assetType !== 'exchange_only';

  return {
    exchange,
    marketId: rawSymbol,
    canonicalMarketId,
    rawSymbol,
    canonicalSymbol,
    baseAsset: canonicalSymbol,
    quoteAsset: quoteCurrency,
    displaySymbol: `${canonicalSymbol}/${quoteCurrency}`,
    koreanName: coin?.nameKo ?? null,
    englishName: coin?.nameEn ?? null,
    iconUrl: resolveIconUrl(canonicalSymbol),
    isActive: true,
    capabilities: {
      supportsCandles: true,
      supportsOrderBook: true,
      supportsTrades: true,
      graphSupported,
      supportedIntervals: getSupportedCandleIntervals(exchange),
      unsupportedReason: graphSupported
        ? null
        : quoteOnlyAsset
          ? 'quote_like_symbol'
          : 'synthetic_market',
    },
    candlesSupported: true,
    graphSupported,
    supportedIntervals: getSupportedCandleIntervals(exchange),
    unsupportedReason: graphSupported
      ? null
      : quoteOnlyAsset
        ? 'quote_like_symbol'
        : 'synthetic_market',
    symbol: canonicalSymbol,
    market: `${canonicalSymbol}/${quoteCurrency}`,
    baseCurrency: canonicalSymbol,
    quoteCurrency,
    nameKo: coin?.nameKo,
    nameEn: coin?.nameEn,
  };
}
