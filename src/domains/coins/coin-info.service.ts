import { env } from '../../config/env';
import { prisma } from '../../config/database';
import { COIN_MAP } from '../../config/constants';
import { getAssetRegistryMetadata, resolvePreferredAssetImage } from '../../core/exchange/asset.registry';
import { RestClient } from '../../core/exchange/rest.client';
import { getReferenceTicker } from '../market-data/market-data.service';
import { logger } from '../../utils/logger';
import { assetMetadataService } from '../assets/asset-metadata.service';
import { translateText } from '../translation/translation.service';
import { normalizeCoinSymbol } from './coin-symbol';

type CoinGeckoMarketData = {
  market_cap_rank?: number | null;
  market_cap?: Record<string, unknown> | null;
  circulating_supply?: unknown;
  max_supply?: unknown;
  total_supply?: unknown;
  current_price?: Record<string, unknown> | null;
  ath?: Record<string, unknown> | null;
  atl?: Record<string, unknown> | null;
  total_volume?: Record<string, unknown> | null;
  high_24h?: Record<string, unknown> | null;
  low_24h?: Record<string, unknown> | null;
  market_cap_change_percentage_24h?: unknown;
  price_change_percentage_24h?: unknown;
  price_change_percentage_7d?: unknown;
  price_change_percentage_14d?: unknown;
  price_change_percentage_30d?: unknown;
  price_change_percentage_60d?: unknown;
  price_change_percentage_200d?: unknown;
  price_change_percentage_1y?: unknown;
};

type CoinGeckoCoinDetail = {
  id?: string;
  symbol?: string | null;
  name?: string | null;
  image?: {
    thumb?: string | null;
    small?: string | null;
    large?: string | null;
  } | null;
  description?: { en?: string | null; ko?: string | null } | null;
  links?: {
    homepage?: Array<string | null> | null;
    blockchain_site?: Array<string | null> | null;
    subreddit_url?: string | null;
  } | null;
  market_data?: CoinGeckoMarketData | null;
  last_updated?: string | null;
};

export type CoinInfoResponse = {
  scope: 'coin';
  symbol: string;
  marketId: string;
  displaySymbol: string;
  name: string | null;
  nameKo: string | null;
  logoUrl: string | null;
  provider: 'coingecko' | 'market_snapshot' | 'database' | 'static_coin_catalog' | null;
  providerId: string | null;
  description: {
    available: boolean;
    ko: string | null;
    en: string | null;
    plainTextKo: string | null;
    plainTextEn: string | null;
    rawHtml: string | null;
    sourceLanguage: 'ko' | 'en' | null;
    renderLanguage: 'ko';
    translated: boolean;
    translationProvider: string | null;
    reason: string | null;
    updatedAt: string;
  };
  links: {
    homepage: string | null;
    whitepaper: string | null;
    explorer: string | null;
  };
  homepageUrl: string | null;
  explorerUrl: string | null;
  market: {
    price: number | null;
    priceCurrency: 'KRW';
    priceChangePercent24h: number | null;
    priceChangePercent7d: number | null;
    priceChangePercent14d: number | null;
    priceChangePercent30d: number | null;
    priceChangePercent60d: number | null;
    priceChangePercent200d: number | null;
    priceChangePercent1y: number | null;
    high24h: number | null;
    low24h: number | null;
    volume24h: number | null;
    tradeValue24h: number | null;
    marketCap: number | null;
    marketCapRank: number | null;
    circulatingSupply: number | null;
    totalSupply: number | null;
    maxSupply: number | null;
    ath: number | null;
    atl: number | null;
    asOf: string | null;
  };
  source: string | null;
  updatedAt: string;
  sourceDetail: {
    metadata: 'coingecko' | 'asset_metadata' | 'database' | 'static_coin_catalog' | null;
    market: 'market_snapshot' | 'coingecko' | 'database' | 'static_coin_catalog' | null;
    fallbackUsed: boolean;
  };
};

const coingeckoClient = new RestClient('coingecko', env.COINGECKO_API_BASE_URL ?? 'https://api.coingecko.com/api/v3');

const COMMON_COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  XRP: 'ripple',
  SOL: 'solana',
  DOGE: 'dogecoin',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  POL: 'polygon-ecosystem-token',
  LINK: 'chainlink',
  ATOM: 'cosmos',
  UNI: 'uniswap',
  SAND: 'the-sandbox',
  SHIB: 'shiba-inu',
  APT: 'aptos',
  USDT: 'tether',
  USDC: 'usd-coin',
  BNB: 'binancecoin',
  TRX: 'tron',
  TON: 'the-open-network',
  XLM: 'stellar',
  HBAR: 'hedera-hashgraph',
  DRIFT: 'drift-protocol',
  ORCA: 'orca',
};

const KOREAN_NAME_FALLBACKS: Record<string, string> = {
  ORCA: '오르카',
  DRIFT: '드리프트',
  USDT: '테더',
  USDC: 'USD 코인',
};

function toFiniteNumber(value: unknown) {
  const numeric = typeof value === 'number' ? value : null;
  return numeric !== null && Number.isFinite(numeric) ? numeric : null;
}

function readUsd(record?: Record<string, unknown> | null) {
  return record ? toFiniteNumber(record.usd) : null;
}

function readKrw(record?: Record<string, unknown> | null) {
  return record ? toFiniteNumber(record.krw) : null;
}

function toIsoString(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstUsableUrl(values?: Array<string | null> | null) {
  const value = values?.find((url): url is string => Boolean(url?.trim()))?.trim() ?? null;
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function sanitizeInformationalText(value: string | null | undefined) {
  if (!value?.trim()) {
    return null;
  }
  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(strong\s+buy|strong\s+sell|buy|sell|recommend(?:ation|ed|s)?|investment advice)\b/gi, '')
    .replace(/매수|매도|추천|투자\s*조언/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

async function buildDescription(params: {
  symbol?: string;
  rawKo?: string | null;
  rawEn?: string | null;
  updatedAt: string;
}) {
  const plainTextKo = sanitizeInformationalText(params.rawKo);
  const plainTextEn = sanitizeInformationalText(params.rawEn);
  const rawHtml = params.rawKo?.trim() || params.rawEn?.trim() || null;
  const available = Boolean(plainTextKo || plainTextEn);
  const hasProviderKorean = Boolean(plainTextKo);
  let translationAttempted = false;
  let translatedByServer = false;
  let reason: string | null = available ? null : 'DESCRIPTION_NOT_AVAILABLE';
  if (!hasProviderKorean && plainTextEn) {
    translationAttempted = true;
    try {
      const translated = await translateText({
        text: plainTextEn,
        sourceLanguage: 'en',
        targetLanguage: 'ko',
        context: 'coin_description',
        symbol: params.symbol,
      });
      translatedByServer = true;
      reason = null;
      logger.info(
        {
          domain: 'coin-info',
          symbol: params.symbol ?? null,
          hasKo: hasProviderKorean,
          hasEn: Boolean(plainTextEn),
          translationAttempted,
          translated: translatedByServer,
          reason,
        },
        `[CoinInfoTranslation] symbol=${params.symbol ?? ''} hasKo=${hasProviderKorean} hasEn=${Boolean(plainTextEn)} translationAttempted=${translationAttempted} translated=${translatedByServer} reason=${reason ?? ''}`,
      );
      return {
        available,
        ko: translated.translatedText,
        en: plainTextEn,
        plainTextKo: translated.translatedText,
        plainTextEn,
        rawHtml,
        sourceLanguage: 'en' as const,
        renderLanguage: 'ko' as const,
        translated: true,
        translationProvider: translated.provider,
        reason: null,
        updatedAt: translated.updatedAt,
      };
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error
        ? String((error as { code?: unknown }).code)
        : 'TRANSLATION_PROVIDER_FAILED';
      reason = code === 'TRANSLATION_PROVIDER_NOT_CONFIGURED'
        ? 'TRANSLATION_PROVIDER_NOT_CONFIGURED'
        : 'TRANSLATION_FAILED';
      logger.warn(
        {
          domain: 'coin-info',
          symbol: params.symbol ?? null,
          hasKo: hasProviderKorean,
          hasEn: Boolean(plainTextEn),
          translationAttempted,
          translated: false,
          reason,
          code,
        },
        `[CoinInfoTranslation] symbol=${params.symbol ?? ''} hasKo=${hasProviderKorean} hasEn=${Boolean(plainTextEn)} translationAttempted=${translationAttempted} translated=false reason=${reason}`,
      );
      return {
        available,
        ko: null,
        en: plainTextEn,
        plainTextKo: null,
        plainTextEn,
        rawHtml,
        sourceLanguage: 'en' as const,
        renderLanguage: 'ko' as const,
        translated: false,
        translationProvider: 'unavailable' as const,
        reason,
        updatedAt: params.updatedAt,
      };
    }
  }
  const result = {
    available,
    ko: plainTextKo,
    en: plainTextEn,
    plainTextKo,
    plainTextEn,
    rawHtml,
    sourceLanguage: hasProviderKorean ? 'ko' as const : plainTextEn ? 'en' as const : null,
    renderLanguage: 'ko' as const,
    translated: hasProviderKorean,
    translationProvider: hasProviderKorean ? 'coingecko' as const : plainTextEn ? 'unavailable' as const : null,
    reason,
    updatedAt: params.updatedAt,
  };
  logger.info(
    {
      domain: 'coin-info',
      symbol: params.symbol ?? null,
      hasKo: hasProviderKorean,
      hasEn: Boolean(plainTextEn),
      translationAttempted,
      translated: result.translated,
      reason: result.reason,
    },
    `[CoinInfoTranslation] symbol=${params.symbol ?? ''} hasKo=${hasProviderKorean} hasEn=${Boolean(plainTextEn)} translationAttempted=${translationAttempted} translated=${result.translated} reason=${result.reason ?? ''}`,
  );
  return result;
}

function buildCoinGeckoHeaders() {
  if (!env.COINGECKO_API_KEY) {
    return undefined;
  }

  const headerName = (env.COINGECKO_API_BASE_URL ?? '').includes('pro-api.coingecko.com')
    ? 'x-cg-pro-api-key'
    : 'x-cg-demo-api-key';
  return { [headerName]: env.COINGECKO_API_KEY };
}

function resolveCoinGeckoId(symbol: string) {
  const preferred = resolvePreferredAssetImage({ canonicalAssetKey: symbol, symbol });
  return preferred.preferredImageCoingeckoId
    ?? COMMON_COINGECKO_IDS[symbol]
    ?? null;
}

async function resolveAssetMetadata(symbol: string) {
  const views = await assetMetadataService.getAssetViewsSafely([
    { canonicalAssetKey: symbol, symbol },
  ], 'coin-info');
  return views.get(symbol) ?? null;
}

async function readCoinFromDatabase(symbol: string) {
  try {
    return await prisma.coin.findUnique({
      where: { symbol },
      select: { symbol: true, nameKo: true, nameEn: true, basePrice: true },
    });
  } catch (error) {
    logger.warn({ domain: 'coin-info', symbol, err: error }, 'Coin database lookup failed');
    return null;
  }
}

async function fetchCoinGeckoDetail(coingeckoId: string) {
  try {
    return await coingeckoClient.request<CoinGeckoCoinDetail>(`/coins/${encodeURIComponent(coingeckoId)}`, {
      headers: buildCoinGeckoHeaders(),
      query: {
        localization: true,
        tickers: false,
        market_data: true,
        community_data: false,
        developer_data: false,
        sparkline: false,
      },
      timeoutMs: 2500,
      retryPolicy: { maxAttempts: 1 },
    });
  } catch (error) {
    logger.warn({ domain: 'coin-info', coingeckoId, err: error }, 'CoinGecko coin detail lookup failed');
    return null;
  }
}

async function fetchReferenceTickerPrice(symbol: string) {
  try {
    const ticker = await getReferenceTicker(symbol);
    return {
      price: toFiniteNumber(ticker?.price),
      volume24h: toFiniteNumber(ticker?.volume24h),
      priceChangePercentage24h: toFiniteNumber(ticker?.change24h),
      high24h: toFiniteNumber(ticker?.high24h),
      low24h: toFiniteNumber(ticker?.low24h),
      updatedAt: ticker?.timestamp ? new Date(ticker.timestamp).toISOString() : null,
    };
  } catch (error) {
    logger.warn({ domain: 'coin-info', symbol, err: error }, 'Reference ticker fallback failed');
    return {
      price: null,
      volume24h: null,
      priceChangePercentage24h: null,
      high24h: null,
      low24h: null,
      updatedAt: null,
    };
  }
}

async function emptyCoinInfo(symbol: string, name: string | null): Promise<CoinInfoResponse> {
  const updatedAt = new Date().toISOString();
  return {
    scope: 'coin',
    symbol,
    marketId: `KRW-${symbol}`,
    displaySymbol: `${symbol}/KRW`,
    name,
    nameKo: KOREAN_NAME_FALLBACKS[symbol] ?? null,
    logoUrl: null,
    provider: null,
    providerId: null,
    description: await buildDescription({ symbol, updatedAt }),
    links: {
      homepage: null,
      whitepaper: null,
      explorer: null,
    },
    homepageUrl: null,
    explorerUrl: null,
    market: {
      price: null,
      priceCurrency: 'KRW',
      priceChangePercent24h: null,
      priceChangePercent7d: null,
      priceChangePercent14d: null,
      priceChangePercent30d: null,
      priceChangePercent60d: null,
      priceChangePercent200d: null,
      priceChangePercent1y: null,
      high24h: null,
      low24h: null,
      volume24h: null,
      tradeValue24h: null,
      marketCap: null,
      marketCapRank: null,
      circulatingSupply: null,
      totalSupply: null,
      maxSupply: null,
      ath: null,
      atl: null,
      asOf: null,
    },
    source: null,
    updatedAt,
    sourceDetail: {
      metadata: null,
      market: null,
      fallbackUsed: true,
    },
  };
}

export async function getCoinInfo(symbolInput: string): Promise<CoinInfoResponse> {
  const symbol = normalizeCoinSymbol(symbolInput);
  const registry = getAssetRegistryMetadata(symbol, symbol);
  const staticCoin = COIN_MAP.get(symbol);
  const [databaseCoin, assetMetadata] = await Promise.all([
    readCoinFromDatabase(symbol),
    resolveAssetMetadata(symbol),
  ]);
  const fallbackName = databaseCoin?.nameEn ?? staticCoin?.nameEn ?? registry.canonicalName ?? null;
  const coingeckoId = assetMetadata?.coingeckoId ?? resolveCoinGeckoId(symbol);
  const [detail, referenceTicker] = await Promise.all([
    coingeckoId ? fetchCoinGeckoDetail(coingeckoId) : Promise.resolve(null),
    fetchReferenceTickerPrice(symbol),
  ]);

  const base = await emptyCoinInfo(symbol, detail?.name ?? fallbackName);
  const marketData = detail?.market_data ?? null;
  const homepageUrl = firstUsableUrl(detail?.links?.homepage);
  const explorerUrl = firstUsableUrl(detail?.links?.blockchain_site);
  const updatedAt = toIsoString(detail?.last_updated) ?? referenceTicker.updatedAt ?? new Date().toISOString();
  const coingeckoLogoUrl = firstUsableUrl([detail?.image?.large ?? null, detail?.image?.small ?? null, detail?.image?.thumb ?? null]);
  const marketPrice = referenceTicker.price ?? readKrw(marketData?.current_price) ?? toFiniteNumber(databaseCoin?.basePrice) ?? staticCoin?.basePrice ?? null;
  const provider = detail ? 'coingecko' : referenceTicker.price !== null ? 'market_snapshot' : databaseCoin ? 'database' : staticCoin ? 'static_coin_catalog' : null;
  const response: CoinInfoResponse = {
    ...base,
    nameKo: databaseCoin?.nameKo ?? staticCoin?.nameKo ?? KOREAN_NAME_FALLBACKS[symbol] ?? null,
    logoUrl: assetMetadata?.assetImageUrl ?? coingeckoLogoUrl,
    provider,
    providerId: detail?.id ?? coingeckoId ?? null,
    description: await buildDescription({
      symbol,
      rawKo: detail?.description?.ko,
      rawEn: detail?.description?.en,
      updatedAt,
    }),
    links: {
      homepage: homepageUrl,
      whitepaper: null,
      explorer: explorerUrl,
    },
    homepageUrl,
    explorerUrl,
    market: {
      price: marketPrice,
      priceCurrency: 'KRW',
      priceChangePercent24h: referenceTicker.priceChangePercentage24h ?? toFiniteNumber(marketData?.price_change_percentage_24h),
      priceChangePercent7d: toFiniteNumber(marketData?.price_change_percentage_7d),
      priceChangePercent14d: toFiniteNumber(marketData?.price_change_percentage_14d),
      priceChangePercent30d: toFiniteNumber(marketData?.price_change_percentage_30d),
      priceChangePercent60d: toFiniteNumber(marketData?.price_change_percentage_60d),
      priceChangePercent200d: toFiniteNumber(marketData?.price_change_percentage_200d),
      priceChangePercent1y: toFiniteNumber(marketData?.price_change_percentage_1y),
      high24h: referenceTicker.high24h ?? readKrw(marketData?.high_24h) ?? readUsd(marketData?.high_24h),
      low24h: referenceTicker.low24h ?? readKrw(marketData?.low_24h) ?? readUsd(marketData?.low_24h),
      volume24h: referenceTicker.volume24h ?? readKrw(marketData?.total_volume),
      tradeValue24h: referenceTicker.volume24h ?? readKrw(marketData?.total_volume),
      marketCap: readKrw(marketData?.market_cap) ?? readUsd(marketData?.market_cap),
      marketCapRank: toFiniteNumber(marketData?.market_cap_rank),
      circulatingSupply: toFiniteNumber(marketData?.circulating_supply),
      totalSupply: toFiniteNumber(marketData?.total_supply),
      maxSupply: toFiniteNumber(marketData?.max_supply),
      ath: readKrw(marketData?.ath) ?? readUsd(marketData?.ath),
      atl: readKrw(marketData?.atl) ?? readUsd(marketData?.atl),
      asOf: updatedAt,
    },
    source: provider,
    updatedAt,
    sourceDetail: {
      metadata: detail ? 'coingecko' : assetMetadata ? 'asset_metadata' : databaseCoin ? 'database' : staticCoin ? 'static_coin_catalog' : null,
      market: referenceTicker.price !== null ? 'market_snapshot' : detail ? 'coingecko' : databaseCoin ? 'database' : staticCoin ? 'static_coin_catalog' : null,
      fallbackUsed: !detail || (referenceTicker.price === null && !marketData),
    },
  };

  logger.info(
    {
      domain: 'coin-info',
      symbol: response.symbol,
      source: response.source,
      hasDescriptionKo: Boolean(response.description.ko),
      hasDescriptionEn: Boolean(response.description.en),
      translated: response.description.translated,
      providerId: response.providerId,
      fallbackUsed: response.sourceDetail.fallbackUsed,
      periodFieldsAvailable: {
        priceChangePercent24h: response.market.priceChangePercent24h !== null,
        priceChangePercent7d: response.market.priceChangePercent7d !== null,
        priceChangePercent14d: response.market.priceChangePercent14d !== null,
        priceChangePercent30d: response.market.priceChangePercent30d !== null,
        priceChangePercent60d: response.market.priceChangePercent60d !== null,
        priceChangePercent200d: response.market.priceChangePercent200d !== null,
        priceChangePercent1y: response.market.priceChangePercent1y !== null,
      },
      marketFields: {
        price: response.market.price !== null,
        high24h: response.market.high24h !== null,
        low24h: response.market.low24h !== null,
        volume24h: response.market.volume24h !== null,
        marketCap: response.market.marketCap !== null,
      },
    },
    `[CoinInfo] symbol=${response.symbol} source=${response.source ?? ''} hasDescriptionKo=${Boolean(response.description.ko)} hasDescriptionEn=${Boolean(response.description.en)} translated=${response.description.translated} providerId=${response.providerId ?? ''} fallbackUsed=${response.sourceDetail.fallbackUsed} periodFieldsAvailable=${JSON.stringify({
      priceChangePercent24h: response.market.priceChangePercent24h !== null,
      priceChangePercent7d: response.market.priceChangePercent7d !== null,
      priceChangePercent14d: response.market.priceChangePercent14d !== null,
      priceChangePercent30d: response.market.priceChangePercent30d !== null,
      priceChangePercent60d: response.market.priceChangePercent60d !== null,
      priceChangePercent200d: response.market.priceChangePercent200d !== null,
      priceChangePercent1y: response.market.priceChangePercent1y !== null,
    })}`,
  );

  logger.info(
    {
      domain: 'coin-info',
      symbol: response.symbol,
      descriptionKoLength: response.description.plainTextKo?.length ?? 0,
      descriptionEnLength: response.description.plainTextEn?.length ?? 0,
      translated: response.description.translated,
      reason: response.description.reason,
    },
    `[CoinInfoResponse] symbol=${response.symbol} descriptionKoLength=${response.description.plainTextKo?.length ?? 0} descriptionEnLength=${response.description.plainTextEn?.length ?? 0} translated=${response.description.translated} reason=${response.description.reason ?? ''}`,
  );

  return response;
}
