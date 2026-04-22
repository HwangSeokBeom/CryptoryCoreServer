import { COIN_MAP } from '../../config/constants';
import { EXCHANGE_METADATA } from './exchange.metadata';
import { resolveIconUrl } from './icon.resolver';
import { getSupportedCandleIntervals } from './interval.mapper';
import {
  buildCanonicalMarketId,
  buildMarketIdentityAliases,
  normalizeMarketIdentity,
  resolveMarketIdentitySpecialCase,
  type MarketIdentitySpecialCaseReason,
} from './market.contract';
import { fromExchangeSymbol, toCanonicalSymbol, toExchangeSymbol } from './symbol.mapper';
import type {
  CanonicalMarketCapabilities,
  CanonicalMarketMetadata,
  ExchangeId,
  ExchangeMarketDescriptor,
  MarketCapabilityChannel,
  QuoteCurrency,
} from './exchange.types';

export type MarketCapabilityFlags = Partial<Record<MarketCapabilityChannel, boolean>> & Partial<CanonicalMarketCapabilities>;

export type MarketResolveInput = {
  marketId?: string;
  symbol?: string;
};

export type MarketResolveResult =
  | {
      ok: true;
      market: ExchangeMarketDescriptor;
      metadata: CanonicalMarketMetadata;
      matchSource: 'market_id' | 'market_alias' | 'symbol';
      identitySpecialCase: MarketIdentitySpecialCaseReason | null;
    }
  | {
      ok: false;
      reason: 'MARKET_ID_NOT_FOUND' | 'SYMBOL_NOT_FOUND' | 'SYMBOL_REQUIRED';
      input: string | null;
    };

export function toCanonicalMarketCapabilities(
  flags?: MarketCapabilityFlags | CanonicalMarketCapabilities,
): CanonicalMarketCapabilities {
  const marketFlags = flags as Partial<Record<MarketCapabilityChannel, boolean>> | undefined;
  const canonicalFlags = flags as Partial<CanonicalMarketCapabilities> | undefined;
  const supportsCandles = marketFlags?.candles ?? canonicalFlags?.supportsCandles ?? true;
  const supportsOrderBook = marketFlags?.orderbook ?? canonicalFlags?.supportsOrderBook ?? true;
  const supportsTrades = marketFlags?.trades ?? canonicalFlags?.supportsTrades ?? true;

  return {
    supportsCandles,
    supportsOrderBook,
    supportsTrades,
    graphSupported: canonicalFlags?.graphSupported ?? supportsCandles,
    supportedIntervals: supportsCandles ? [...(canonicalFlags?.supportedIntervals ?? [])] : [],
    unsupportedReason: canonicalFlags?.unsupportedReason ?? null,
  };
}

export function looksLikeExplicitMarketId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return /[-_/]/.test(trimmed)
    || /^[a-z0-9]+_(krw|usd|usdt|usdc|fdusd|busd|tusd|usdp|dai|eur|try|brl)$/i.test(trimmed);
}

export function normalizeMarketResolveInput(input: MarketResolveInput | string): MarketResolveInput {
  const normalizedInput = typeof input === 'string'
    ? { symbol: input }
    : input;
  const marketId = normalizedInput.marketId?.trim();
  const symbol = normalizedInput.symbol?.trim();

  if (marketId) {
    return symbol
      ? { marketId, symbol }
      : { marketId };
  }

  if (!symbol) {
    return {};
  }

  return looksLikeExplicitMarketId(symbol)
    ? { marketId: symbol }
    : { symbol };
}

export function buildCanonicalMarketMetadata(params: {
  exchange: ExchangeId;
  symbol?: string;
  marketId?: string;
  rawSymbol?: string;
  baseAsset?: string;
  quoteAsset?: QuoteCurrency;
  isActive?: boolean;
  capabilities?: MarketCapabilityFlags | CanonicalMarketCapabilities;
}): CanonicalMarketMetadata {
  const quoteAsset = params.quoteAsset ?? EXCHANGE_METADATA[params.exchange].quoteCurrency;
  const rawSymbol = params.rawSymbol ?? params.marketId ?? toExchangeSymbol(params.exchange, params.symbol ?? '');
  const canonicalSymbol = toCanonicalSymbol(params.symbol ?? fromExchangeSymbol(params.exchange, rawSymbol));
  const baseAsset = params.baseAsset ?? canonicalSymbol;
  const marketId = params.marketId ?? rawSymbol;
  const canonicalMarketId = buildCanonicalMarketId(baseAsset, quoteAsset);
  const coin = COIN_MAP.get(canonicalSymbol);
  const capabilities = toCanonicalMarketCapabilities(
    params.capabilities as MarketCapabilityFlags | CanonicalMarketCapabilities | undefined,
  );
  const supportedIntervals = capabilities.supportsCandles && capabilities.supportedIntervals.length === 0
    ? getSupportedCandleIntervals(params.exchange)
    : capabilities.supportedIntervals;
  const graphSupported = capabilities.graphSupported ?? capabilities.supportsCandles;
  const unsupportedReason = capabilities.unsupportedReason ?? null;

  return {
    exchange: params.exchange,
    marketId,
    canonicalMarketId,
    rawSymbol,
    canonicalSymbol,
    baseAsset,
    quoteAsset,
    displaySymbol: `${baseAsset}/${quoteAsset}`,
    koreanName: coin?.nameKo ?? null,
    englishName: coin?.nameEn ?? null,
    iconUrl: resolveIconUrl(canonicalSymbol),
    isActive: params.isActive ?? true,
    capabilities: {
      ...capabilities,
      graphSupported,
      supportedIntervals: [...supportedIntervals],
      unsupportedReason,
    },
    candlesSupported: capabilities.supportsCandles,
    graphSupported,
    supportedIntervals: [...supportedIntervals],
    unsupportedReason,
  };
}

export function buildCanonicalMarketMetadataFromDescriptor(params: {
  exchange: ExchangeId;
  market: ExchangeMarketDescriptor;
  capabilities?: MarketCapabilityFlags | CanonicalMarketCapabilities;
}): CanonicalMarketMetadata {
  return buildCanonicalMarketMetadata({
    exchange: params.exchange,
    symbol: params.market.symbol,
    marketId: params.market.marketId ?? params.market.exchangeSymbol ?? params.market.rawSymbol,
    rawSymbol: params.market.rawSymbol ?? params.market.exchangeSymbol,
    baseAsset: params.market.baseCurrency ?? params.market.symbol,
    quoteAsset: params.market.quoteCurrency,
    isActive: params.market.tradable,
    capabilities: params.capabilities,
  });
}

export function resolveExchangeMarketInput(params: {
  exchange: ExchangeId;
  markets: ExchangeMarketDescriptor[];
  input: MarketResolveInput;
  capabilitiesBySymbol?: Map<string, MarketCapabilityFlags | CanonicalMarketCapabilities>;
}): MarketResolveResult {
  const normalizedInput = normalizeMarketResolveInput(params.input);
  const marketId = normalizedInput.marketId?.trim();
  const symbol = normalizedInput.symbol?.trim();

  if (marketId) {
    const normalizedMarketId = normalizeMarketIdentity(marketId);
    const market = params.markets.find((item) => {
      const directMatches = [
        item.marketId,
        item.exchangeSymbol,
        item.rawSymbol,
        item.market,
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => normalizeMarketIdentity(value) === normalizedMarketId);

      return directMatches || buildMarketIdentityAliases({
        exchange: params.exchange,
        marketId: item.marketId ?? item.exchangeSymbol ?? item.rawSymbol,
        exchangeSymbol: item.exchangeSymbol,
        rawSymbol: item.rawSymbol,
        market: item.market,
        symbol: item.symbol,
        baseAsset: item.baseCurrency ?? item.symbol,
        quoteAsset: item.quoteCurrency,
      }).includes(normalizedMarketId);
    });

    if (!market) {
      return { ok: false, reason: 'MARKET_ID_NOT_FOUND', input: marketId };
    }

    const metadata = buildCanonicalMarketMetadataFromDescriptor({
      exchange: params.exchange,
      market,
      capabilities: params.capabilitiesBySymbol?.get(market.symbol),
    });
    const directMatches = [
      market.marketId,
      market.exchangeSymbol,
      market.rawSymbol,
      market.market,
      metadata.canonicalMarketId,
    ]
      .filter((value): value is string => Boolean(value))
      .some((value) => normalizeMarketIdentity(value) === normalizedMarketId);

    return {
      ok: true,
      market,
      metadata,
      matchSource: directMatches ? 'market_id' : 'market_alias',
      identitySpecialCase: resolveMarketIdentitySpecialCase({
        canonicalSymbol: metadata.canonicalSymbol,
        marketId: metadata.marketId,
        inputMarketId: marketId,
      }),
    };
  }

  if (!symbol) {
    return { ok: false, reason: 'SYMBOL_REQUIRED', input: null };
  }

  const canonicalSymbol = toCanonicalSymbol(symbol);
  const market = params.markets.find((item) => item.symbol === canonicalSymbol);
  if (!market) {
    return { ok: false, reason: 'SYMBOL_NOT_FOUND', input: symbol };
  }

  return {
    ok: true,
    market,
    metadata: buildCanonicalMarketMetadataFromDescriptor({
      exchange: params.exchange,
      market,
      capabilities: params.capabilitiesBySymbol?.get(market.symbol),
    }),
    matchSource: 'symbol',
    identitySpecialCase: resolveMarketIdentitySpecialCase({
      canonicalSymbol,
      marketId: market.marketId ?? market.exchangeSymbol ?? market.rawSymbol,
    }),
  };
}
