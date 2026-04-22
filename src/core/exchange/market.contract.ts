import { getAssetRegistryMetadata } from './asset.registry';
import { getSupportedCandleIntervals } from './interval.mapper';
import { toCanonicalSymbol } from './symbol.mapper';
import type {
  CanonicalMarketCapabilities,
  ExchangeId,
  ExchangeMarketDescriptor,
  MarketCapabilityChannel,
  MarketCapabilitySnapshot,
  QuoteCurrency,
} from './exchange.types';

export type MarketContractUnsupportedReason =
  | 'quote_like_symbol'
  | 'synthetic_market'
  | 'provider_not_supported'
  | 'identity_special_case';

export type MarketIdentitySpecialCaseReason =
  | 'single_char_symbol'
  | 'alias_normalized'
  | 'quote_like_symbol'
  | 'synthetic_market';

export type ResolvedMarketCapabilityFlags =
  Record<MarketCapabilityChannel, boolean>
  & CanonicalMarketCapabilities;

export function normalizeMarketIdentity(value: string) {
  return value.trim().toLowerCase();
}

export function buildCanonicalMarketId(baseAsset: string, quoteAsset: QuoteCurrency | string) {
  return `${toCanonicalSymbol(baseAsset)}/${String(quoteAsset).toUpperCase()}`;
}

function buildExchangeNativeMarketId(exchange: ExchangeId, baseAsset: string, quoteAsset: QuoteCurrency | string) {
  const base = toCanonicalSymbol(baseAsset);
  const quote = String(quoteAsset).toUpperCase();

  switch (exchange) {
    case 'upbit':
      return `${quote}-${base}`;
    case 'bithumb':
      return `${base}_${quote}`;
    case 'coinone':
      return base;
    case 'korbit':
      return `${base.toLowerCase()}_${quote.toLowerCase()}`;
    case 'binance':
      return `${base}${quote}`;
  }
}

export function buildMarketIdentityAliases(params: {
  exchange: ExchangeId;
  marketId?: string | null;
  exchangeSymbol?: string | null;
  rawSymbol?: string | null;
  market?: string | null;
  symbol: string;
  baseAsset?: string | null;
  quoteAsset: QuoteCurrency | string;
}) {
  const baseAsset = toCanonicalSymbol(params.baseAsset ?? params.symbol);
  const quoteAsset = String(params.quoteAsset).toUpperCase();
  const canonicalMarketId = buildCanonicalMarketId(baseAsset, quoteAsset);

  return Array.from(new Set([
    params.marketId ?? null,
    params.exchangeSymbol ?? null,
    params.rawSymbol ?? null,
    params.market ?? null,
    canonicalMarketId,
    buildExchangeNativeMarketId(params.exchange, baseAsset, quoteAsset),
    `${baseAsset}_${quoteAsset}`,
    `${quoteAsset}-${baseAsset}`,
    `${baseAsset}-${quoteAsset}`,
    `${baseAsset}/${quoteAsset}`,
    `${baseAsset.toLowerCase()}_${quoteAsset.toLowerCase()}`,
    `${quoteAsset.toLowerCase()}-${baseAsset.toLowerCase()}`,
    baseAsset,
  ].filter((value): value is string => Boolean(value?.trim())))).map(normalizeMarketIdentity);
}

export function resolveMarketIdentitySpecialCase(params: {
  canonicalSymbol: string;
  marketId?: string | null;
  inputMarketId?: string | null;
}): MarketIdentitySpecialCaseReason | null {
  const assetMetadata = getAssetRegistryMetadata(params.canonicalSymbol, params.canonicalSymbol);

  if (assetMetadata.assetType === 'fiat' || assetMetadata.assetType === 'stablecoin') {
    return 'quote_like_symbol';
  }

  if (assetMetadata.assetType === 'synthetic' || assetMetadata.assetType === 'exchange_only') {
    return 'synthetic_market';
  }

  if (params.canonicalSymbol.length <= 1) {
    return 'single_char_symbol';
  }

  if (params.inputMarketId && params.marketId) {
    const normalizedInput = normalizeMarketIdentity(params.inputMarketId);
    const normalizedMarketId = normalizeMarketIdentity(params.marketId);
    if (normalizedInput !== normalizedMarketId) {
      return 'alias_normalized';
    }
  }

  return null;
}

function normalizeUnsupportedReason(reason?: string | null): MarketContractUnsupportedReason | null {
  if (!reason) {
    return null;
  }

  const normalized = reason.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized.includes('quote_like')) {
    return 'quote_like_symbol';
  }
  if (normalized.includes('synthetic')) {
    return 'synthetic_market';
  }
  if (normalized.includes('identity')) {
    return 'identity_special_case';
  }
  if (
    normalized.includes('provider_not_supported')
    || normalized.includes('market_not_supported')
    || normalized.includes('unsupported')
  ) {
    return 'provider_not_supported';
  }

  return null;
}

function resolveGraphUnsupportedReason(params: {
  canonicalSymbol: string;
}): MarketContractUnsupportedReason | null {
  const assetMetadata = getAssetRegistryMetadata(params.canonicalSymbol, params.canonicalSymbol);
  if (
    assetMetadata.assetType === 'fiat'
    || assetMetadata.assetType === 'stablecoin'
  ) {
    return 'quote_like_symbol';
  }

  if (assetMetadata.assetType === 'synthetic' || assetMetadata.assetType === 'exchange_only') {
    return 'synthetic_market';
  }

  return null;
}

export function buildResolvedMarketCapabilityFlags(params: {
  exchange: ExchangeId;
  market: Pick<ExchangeMarketDescriptor, 'symbol'>;
  capabilitySnapshot: MarketCapabilitySnapshot;
}): ResolvedMarketCapabilityFlags {
  const candlesSupported = (params.capabilitySnapshot.capabilitySymbols.candles ?? []).includes(params.market.symbol);
  const orderbookSupported = (params.capabilitySnapshot.capabilitySymbols.orderbook ?? []).includes(params.market.symbol);
  const tradesSupported = (params.capabilitySnapshot.capabilitySymbols.trades ?? []).includes(params.market.symbol);
  const tickersSupported = (params.capabilitySnapshot.capabilitySymbols.tickers ?? []).includes(params.market.symbol);
  const capabilityReason = normalizeUnsupportedReason(
    params.capabilitySnapshot.capabilityExcludedSymbols?.candles
      ?.find((entry) => entry.symbol === params.market.symbol)?.reason ?? null,
  );
  const graphUnsupportedReason = candlesSupported
    ? resolveGraphUnsupportedReason({ canonicalSymbol: params.market.symbol })
    : null;

  return {
    tickers: tickersSupported,
    orderbook: orderbookSupported,
    trades: tradesSupported,
    candles: candlesSupported,
    supportsCandles: candlesSupported,
    supportsOrderBook: orderbookSupported,
    supportsTrades: tradesSupported,
    graphSupported: candlesSupported && graphUnsupportedReason === null,
    supportedIntervals: candlesSupported ? getSupportedCandleIntervals(params.exchange) : [],
    unsupportedReason: !candlesSupported ? capabilityReason ?? 'provider_not_supported' : graphUnsupportedReason,
  };
}
