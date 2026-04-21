import { COIN_MAP } from '../../config/constants';
import { EXCHANGE_METADATA } from './exchange.metadata';
import { resolveIconUrl } from './icon.resolver';
import { fromExchangeSymbol, toCanonicalSymbol, toExchangeSymbol } from './symbol.mapper';
import type {
  CanonicalMarketCapabilities,
  CanonicalMarketMetadata,
  ExchangeId,
  ExchangeMarketDescriptor,
  MarketCapabilityChannel,
  QuoteCurrency,
} from './exchange.types';

export type MarketCapabilityFlags = Partial<Record<MarketCapabilityChannel, boolean>>;

export type MarketResolveInput = {
  marketId?: string;
  symbol?: string;
};

export type MarketResolveResult =
  | {
      ok: true;
      market: ExchangeMarketDescriptor;
      metadata: CanonicalMarketMetadata;
    }
  | {
      ok: false;
      reason: 'MARKET_ID_NOT_FOUND' | 'SYMBOL_NOT_FOUND' | 'SYMBOL_REQUIRED';
      input: string | null;
    };

export function toCanonicalMarketCapabilities(flags?: MarketCapabilityFlags): CanonicalMarketCapabilities {
  return {
    supportsCandles: flags?.candles ?? true,
    supportsOrderBook: flags?.orderbook ?? true,
    supportsTrades: flags?.trades ?? true,
  };
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
  const coin = COIN_MAP.get(canonicalSymbol);
  const capabilities = params.capabilities && 'supportsCandles' in params.capabilities
    ? params.capabilities
    : toCanonicalMarketCapabilities(params.capabilities as MarketCapabilityFlags | undefined);

  return {
    exchange: params.exchange,
    marketId,
    rawSymbol,
    canonicalSymbol,
    baseAsset,
    quoteAsset,
    displaySymbol: `${baseAsset}/${quoteAsset}`,
    koreanName: coin?.nameKo ?? null,
    englishName: coin?.nameEn ?? null,
    iconUrl: resolveIconUrl(canonicalSymbol),
    isActive: params.isActive ?? true,
    capabilities,
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

function normalizeMarketId(value: string) {
  return value.trim().toLowerCase();
}

export function resolveExchangeMarketInput(params: {
  exchange: ExchangeId;
  markets: ExchangeMarketDescriptor[];
  input: MarketResolveInput;
  capabilitiesBySymbol?: Map<string, MarketCapabilityFlags | CanonicalMarketCapabilities>;
}): MarketResolveResult {
  const marketId = params.input.marketId?.trim();
  const symbol = params.input.symbol?.trim();

  if (marketId) {
    const normalizedMarketId = normalizeMarketId(marketId);
    const market = params.markets.find((item) =>
      [
        item.marketId,
        item.exchangeSymbol,
        item.rawSymbol,
        item.market,
      ].filter((value): value is string => Boolean(value))
        .some((value) => normalizeMarketId(value) === normalizedMarketId));

    if (!market) {
      return { ok: false, reason: 'MARKET_ID_NOT_FOUND', input: marketId };
    }

    return {
      ok: true,
      market,
      metadata: buildCanonicalMarketMetadataFromDescriptor({
        exchange: params.exchange,
        market,
        capabilities: params.capabilitiesBySymbol?.get(market.symbol),
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
  };
}
