import { COINS, COIN_MAP } from '../../config/constants';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import {
  containsNonAsciiAssetText,
  getAssetRegistryMetadata,
  type AssetType,
} from '../../core/exchange/asset.registry';
import type { RestRequestOptions } from '../../core/exchange/rest.client';
import { RestClient } from '../../core/exchange/rest.client';
import { DEFAULT_COIN_PLACEHOLDER_ICON_URL, resolveIconUrl } from '../../core/exchange/icon.resolver';
import { resolveCanonicalAssetKey as resolveCanonicalAssetImageKey, toCanonicalSymbol } from '../../core/exchange/symbol.mapper';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { logger } from '../../utils/logger';

type AssetMetadataConfidence = 'high' | 'medium' | 'low';
type AssetMetadataSource = 'curated' | 'coingecko' | 'negative_cache' | 'alias_fallback' | 'placeholder' | 'stale_cache';
type AssetResolvePriority = 'priority' | 'normal';
type AssetImageFailureReason = 'missing_metadata' | 'coingecko_fetch_failed' | 'alias_not_found' | 'image_url_empty';
type AssetImageFallbackType = 'stale_cache' | 'symbol_alias' | 'default_placeholder' | 'fiat_initials';
export type AssetImageAvailability = 'available' | 'fallback' | 'pending' | 'lookup_failed' | 'unavailable';

type CoinGeckoCoinListItem = {
  id: string;
  symbol: string;
  name: string;
};

type CoinGeckoCoinMarketsItem = {
  id: string;
  symbol: string;
  name: string;
  image?: string | null;
};

type CuratedAssetOverride = {
  coingeckoId: string;
  aliases?: string[];
  fallbackImageUrl?: string;
};

type AssetMetadataCacheEntry = {
  canonicalAssetKey: string;
  coingeckoId: string | null;
  imageUrl: string | null;
  symbol: string;
  name: string | null;
  updatedAt: number;
  source: AssetMetadataSource;
  confidence: AssetMetadataConfidence;
  isNegativeCache: boolean;
  staleAt: number;
  usableUntil: number;
  failureReason?: AssetImageFailureReason | null;
  fallbackType?: AssetImageFallbackType | null;
  assetType?: AssetType;
  canonicalName?: string | null;
  fallbackColor?: string | null;
  fallbackInitials?: string | null;
};

export type AssetMetadataLookup = {
  exchange?: ExchangeId;
  symbol?: string | null;
  exchangeSymbol?: string | null;
  displayName?: string | null;
  canonicalAssetKey?: string | null;
};

export type AssetMetadataView = {
  canonicalAssetKey: string | null;
  assetImageUrl: string | null;
  symbolImageUrl: string | null;
  coingeckoId: string | null;
  source?: AssetMetadataSource;
  failureReason?: AssetImageFailureReason | null;
  fallbackType?: AssetImageFallbackType | null;
  fallbackHit?: boolean;
  imageAvailability: AssetImageAvailability;
  assetType: AssetType;
  canonicalName: string | null;
  fallbackColor: string | null;
  fallbackInitials: string | null;
};

type AssetResolveRequest = {
  canonicalAssetKey: string;
  exchange?: ExchangeId;
  symbol?: string | null;
  exchangeSymbol?: string | null;
  displayName?: string | null;
  priority?: AssetResolvePriority;
};

type CoinGeckoSymbolCandidate = {
  id: string;
  symbol: string;
  name: string;
};

type CoinListLoadResult = {
  loaded: boolean;
  usedStale: boolean;
  failed: boolean;
  error?: unknown;
};

type CoinMarketsFetchResult = {
  items: CoinGeckoCoinMarketsItem[];
  failedIds: Set<string>;
};

type MissingImageStats = {
  canonicalAssetKey: string;
  symbol: string | null;
  exchange: ExchangeId | null;
  count: number;
  reason: AssetImageFailureReason;
  fallbackType: AssetImageFallbackType | null;
  source: AssetMetadataSource | null;
  lastSeenAt: number;
};

const ASSET_METADATA_REDIS_KEY_PREFIX = 'asset:metadata:v1';
const COINGECKO_COIN_LIST_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const ASSET_METADATA_BACKGROUND_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ASSET_METADATA_REFRESH_DEBOUNCE_MS = 50;
const ASSET_METADATA_POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ASSET_METADATA_POSITIVE_USABLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ASSET_METADATA_NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;
const ASSET_METADATA_NEGATIVE_USABLE_TTL_MS = 12 * 60 * 60 * 1000;
const ASSET_METADATA_FALLBACK_STALE_TTL_MS = 15 * 60 * 1000;
const COINGECKO_MARKETS_BATCH_LIMIT = 100;
const PRIORITY_WARMUP_ASSET_KEYS = ['BTC', 'ETH', 'XRP', 'ADA', 'SOL', 'DOGE', 'USDT', 'USDC', 'BNB', 'TRX'] as const;
const TOP_SYMBOL_COVERAGE_ASSET_KEYS = Array.from(new Set([
  ...PRIORITY_WARMUP_ASSET_KEYS,
  'AVAX',
  'DOT',
  'MATIC',
  'POL',
  'LINK',
  'ATOM',
  'UNI',
  'SAND',
  'SHIB',
  'APT',
  'TON',
  'XLM',
  'HBAR',
  'RENDER',
  'RNDR',
  'FTM',
  'SONIC',
  'A',
  'G',
  'T',
  'W',
  'KAIA',
  'BTT',
  'LUNC',
  'LUNA',
  'BONK',
  'FLOKI',
  'BABYDOGE',
  'JUP',
  'TIA',
  'PYTH',
  'ENA',
  'PENGU',
  'VIRTUAL',
  'TRUMP',
  'WBTC',
  'FDUSD',
  'RLUSD',
  'USD1',
]));
const DEFAULT_WARMUP_ASSET_KEYS = Array.from(new Set([
  ...COINS.map((coin) => coin.symbol),
  'USDT',
  'USDC',
  'BNB',
  'TRX',
  'TON',
  'XLM',
  'HBAR',
  'POL',
  'RENDER',
  'RNDR',
  'FTM',
  'SONIC',
  'A',
  'G',
  'T',
  'W',
  'KAIA',
  'BTT',
  'LUNC',
  'LUNA',
  'BONK',
  'FLOKI',
  'BABYDOGE',
  'JUP',
  'TIA',
  'PYTH',
  'ENA',
  'PENGU',
  'VIRTUAL',
  'TRUMP',
  'WBTC',
  'FDUSD',
  'RLUSD',
  'USD1',
]));

function buildKnownIconUrl(symbol: string) {
  return `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${symbol}.png`;
}

function buildCoinGeckoImageUrl(path: string) {
  return `https://coin-images.coingecko.com/coins/images/${path}`;
}

const CURATED_ASSET_OVERRIDES: Record<string, CuratedAssetOverride> = {
  BTC: { coingeckoId: 'bitcoin', aliases: ['bitcoin'] },
  ETH: { coingeckoId: 'ethereum', aliases: ['ethereum'] },
  XRP: { coingeckoId: 'ripple', aliases: ['ripple'] },
  ADA: { coingeckoId: 'cardano', aliases: ['cardano'] },
  SOL: { coingeckoId: 'solana', aliases: ['solana'] },
  DOGE: { coingeckoId: 'dogecoin', aliases: ['dogecoin'] },
  AVAX: { coingeckoId: 'avalanche-2', aliases: ['avalanche'] },
  DOT: { coingeckoId: 'polkadot', aliases: ['polkadot'] },
  LINK: { coingeckoId: 'chainlink', aliases: ['chainlink'] },
  ATOM: { coingeckoId: 'cosmos', aliases: ['cosmos'] },
  UNI: { coingeckoId: 'uniswap', aliases: ['uniswap'] },
  SAND: { coingeckoId: 'the-sandbox', aliases: ['sandbox', 'the sandbox'] },
  SHIB: { coingeckoId: 'shiba-inu', aliases: ['shiba inu'] },
  APT: { coingeckoId: 'aptos', aliases: ['aptos'] },
  POL: {
    coingeckoId: 'polygon-ecosystem-token',
    aliases: ['pol', 'polygon ecosystem', 'pol ex matic', 'polygon'],
    fallbackImageUrl: buildKnownIconUrl('matic'),
  },
  MATIC: { coingeckoId: 'matic-network', aliases: ['polygon', 'matic'] },
  RENDER: {
    coingeckoId: 'render-token',
    aliases: ['render', 'render token', 'rndr'],
    fallbackImageUrl: buildCoinGeckoImageUrl('11636/large/rndr.png?1696511529'),
  },
  RNDR: {
    coingeckoId: 'render-token',
    aliases: ['render', 'render token', 'rndr'],
    fallbackImageUrl: buildCoinGeckoImageUrl('11636/large/rndr.png?1696511529'),
  },
  USDT: { coingeckoId: 'tether', aliases: ['tether'], fallbackImageUrl: buildKnownIconUrl('usdt') },
  USDC: { coingeckoId: 'usd-coin', aliases: ['usd coin', 'usdc'], fallbackImageUrl: buildKnownIconUrl('usdc') },
  FDUSD: { coingeckoId: 'first-digital-usd', aliases: ['first digital usd', 'fdusd'] },
  RLUSD: { coingeckoId: 'ripple-usd', aliases: ['ripple usd', 'rlusd'] },
  USD1: { coingeckoId: 'world-liberty-financial-usd', aliases: ['world liberty financial usd', 'usd1'] },
  WBTC: { coingeckoId: 'wrapped-bitcoin', aliases: ['wrapped bitcoin', 'wbtc'], fallbackImageUrl: buildKnownIconUrl('btc') },
  BNB: { coingeckoId: 'binancecoin', aliases: ['bnb', 'binance coin'], fallbackImageUrl: buildKnownIconUrl('bnb') },
  TRX: { coingeckoId: 'tron', aliases: ['tron'], fallbackImageUrl: buildKnownIconUrl('trx') },
  TON: { coingeckoId: 'the-open-network', aliases: ['toncoin', 'the open network'] },
  XLM: { coingeckoId: 'stellar', aliases: ['stellar'], fallbackImageUrl: buildKnownIconUrl('xlm') },
  HBAR: { coingeckoId: 'hedera-hashgraph', aliases: ['hedera', 'hedera hashgraph'] },
  BCH: { coingeckoId: 'bitcoin-cash', aliases: ['bitcoin cash'] },
  ETC: { coingeckoId: 'ethereum-classic', aliases: ['ethereum classic'] },
  LTC: { coingeckoId: 'litecoin', aliases: ['litecoin'] },
  EOS: { coingeckoId: 'eos', aliases: ['eos'] },
  FIL: { coingeckoId: 'filecoin', aliases: ['filecoin'] },
  NEAR: { coingeckoId: 'near', aliases: ['near protocol', 'near'] },
  PEPE: { coingeckoId: 'pepe', aliases: ['pepe'] },
  ONDO: { coingeckoId: 'ondo-finance', aliases: ['ondo finance', 'ondo'] },
  WLD: { coingeckoId: 'worldcoin-wld', aliases: ['worldcoin'] },
  OP: { coingeckoId: 'optimism', aliases: ['optimism'] },
  ARB: { coingeckoId: 'arbitrum', aliases: ['arbitrum'] },
  AAVE: { coingeckoId: 'aave', aliases: ['aave'] },
  SUI: { coingeckoId: 'sui', aliases: ['sui'] },
  SEI: { coingeckoId: 'sei-network', aliases: ['sei'] },
  ALGO: { coingeckoId: 'algorand', aliases: ['algorand'] },
  ICP: { coingeckoId: 'internet-computer', aliases: ['internet computer', 'icp'] },
  VET: { coingeckoId: 'vechain', aliases: ['vechain'] },
  SONIC: {
    coingeckoId: 'sonic-3',
    aliases: ['sonic'],
    fallbackImageUrl: buildCoinGeckoImageUrl('38108/large/200x200_Sonic_Logo.png?1734679256'),
  },
  FTM: {
    coingeckoId: 'fantom',
    aliases: ['fantom', 'ftm', 'sonic'],
    fallbackImageUrl: buildCoinGeckoImageUrl('4001/large/Fantom_round.png?1696504642'),
  },
  A: {
    coingeckoId: 'vaulta',
    aliases: ['vaulta'],
    fallbackImageUrl: buildCoinGeckoImageUrl('55616/large/Vaulta_CEX_Icon_Circle_-_cmc.png?1746859132'),
  },
  G: {
    coingeckoId: 'g-token',
    aliases: ['gravity', 'gravity by galxe', 'galxe'],
    fallbackImageUrl: buildCoinGeckoImageUrl('39200/large/gravity.jpg?1721020647'),
  },
  T: {
    coingeckoId: 'threshold-network-token',
    aliases: ['threshold', 'threshold network'],
    fallbackImageUrl: buildCoinGeckoImageUrl('22228/large/nFPNiSbL_400x400.jpg?1696521570'),
  },
  W: {
    coingeckoId: 'wormhole',
    aliases: ['wormhole'],
    fallbackImageUrl: buildCoinGeckoImageUrl('35087/large/W_Token_%283%29.png?1758122686'),
  },
  KAIA: {
    coingeckoId: 'kaia',
    aliases: ['kaia'],
    fallbackImageUrl: buildCoinGeckoImageUrl('39901/large/KAIA.png?1724734368'),
  },
  BTT: {
    coingeckoId: 'bittorrent',
    aliases: ['bittorrent', 'bittorrent new', 'bttc'],
    fallbackImageUrl: buildCoinGeckoImageUrl('22457/large/btt_logo.png?1696521780'),
  },
  LUNC: {
    coingeckoId: 'terra-luna',
    aliases: ['terra luna classic', 'luna classic'],
    fallbackImageUrl: buildCoinGeckoImageUrl('8284/large/01_LunaClassic_color.png?1696508486'),
  },
  LUNA: {
    coingeckoId: 'terra-luna-2',
    aliases: ['terra', 'terra 2', 'luna 2'],
    fallbackImageUrl: buildCoinGeckoImageUrl('25767/large/01_Luna_color.png?1696524851'),
  },
  BONK: {
    coingeckoId: 'bonk',
    aliases: ['bonk'],
    fallbackImageUrl: buildCoinGeckoImageUrl('28600/large/bonk.jpg?1696527587'),
  },
  FLOKI: {
    coingeckoId: 'floki',
    aliases: ['floki'],
    fallbackImageUrl: buildCoinGeckoImageUrl('16746/large/PNG_image.png?1696516318'),
  },
  BABYDOGE: {
    coingeckoId: 'baby-doge-coin',
    aliases: ['baby doge coin', 'babydoge'],
    fallbackImageUrl: buildCoinGeckoImageUrl('16125/large/babydoge.jpg?1696515731'),
  },
  JUP: {
    coingeckoId: 'jupiter-exchange-solana',
    aliases: ['jupiter'],
    fallbackImageUrl: buildCoinGeckoImageUrl('34188/large/jup.png?1704266489'),
  },
  TIA: {
    coingeckoId: 'celestia',
    aliases: ['celestia'],
    fallbackImageUrl: buildCoinGeckoImageUrl('31967/large/tia.jpg?1696530772'),
  },
  PYTH: {
    coingeckoId: 'pyth-network',
    aliases: ['pyth network'],
    fallbackImageUrl: buildCoinGeckoImageUrl('31924/large/pyth.png?1701245725'),
  },
  ENA: {
    coingeckoId: 'ethena',
    aliases: ['ethena'],
    fallbackImageUrl: buildCoinGeckoImageUrl('36530/large/ethena.png?1711701436'),
  },
  PENGU: {
    coingeckoId: 'pudgy-penguins',
    aliases: ['pudgy penguins'],
    fallbackImageUrl: buildCoinGeckoImageUrl('52622/large/PUDGY_PENGUINS_PENGU_PFP.png?1733809110'),
  },
  VIRTUAL: {
    coingeckoId: 'virtual-protocol',
    aliases: ['virtuals protocol', 'virtual'],
    fallbackImageUrl: buildCoinGeckoImageUrl('34057/large/LOGOMARK.png?1708356054'),
  },
  TRUMP: {
    coingeckoId: 'official-trump',
    aliases: ['official trump', 'trump'],
    fallbackImageUrl: buildCoinGeckoImageUrl('53746/large/trump.png?1737171561'),
  },
};

function normalizeComparableText(value?: string | null) {
  return value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() ?? '';
}

function truncateSnippet(value?: string | null) {
  if (!value) {
    return null;
  }
  return value.length > 240 ? `${value.slice(0, 240)}...` : value;
}

function summarizeCounts(values: string[]) {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function toCoverageRate(count: number, total: number) {
  if (total === 0) {
    return 0;
  }
  return Number(((count / total) * 100).toFixed(2));
}

function readExchangeErrorDetails(error: unknown) {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as {
    statusCode?: unknown;
    requestUrl?: unknown;
    responseBody?: unknown;
    exchange?: unknown;
  };

  return {
    exchange: typeof candidate.exchange === 'string' ? candidate.exchange : null,
    statusCode: typeof candidate.statusCode === 'number' ? candidate.statusCode : null,
    requestUrl: typeof candidate.requestUrl === 'string' ? candidate.requestUrl : null,
    responseBody: typeof candidate.responseBody === 'string' ? candidate.responseBody : null,
  };
}

function toRedisKey(canonicalAssetKey: string) {
  return `${ASSET_METADATA_REDIS_KEY_PREFIX}:${canonicalAssetKey}`;
}

function inferApiKeyHeaderName(baseUrl: string) {
  return baseUrl.includes('pro-api.coingecko.com')
    ? 'x-cg-pro-api-key'
    : 'x-cg-demo-api-key';
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function normalizeAssetImageUrl(imageUrl?: string | null) {
  if (!imageUrl) {
    return null;
  }

  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function resolveAssetPriority(canonicalAssetKey: string) {
  return PRIORITY_WARMUP_ASSET_KEYS.includes(canonicalAssetKey as (typeof PRIORITY_WARMUP_ASSET_KEYS)[number])
    ? 'priority' as const
    : 'normal' as const;
}

class AssetMetadataService {
  private readonly memoryCache = new Map<string, AssetMetadataCacheEntry>();
  private readonly missingImageStats = new Map<string, MissingImageStats>();
  private readonly pendingResolutions = new Map<string, AssetResolveRequest>();
  private readonly coingeckoClient = new RestClient('coingecko', env.COINGECKO_API_BASE_URL ?? 'https://api.coingecko.com/api/v3');

  private started = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private resolveTimer: NodeJS.Timeout | null = null;
  private coinListBySymbol = new Map<string, CoinGeckoSymbolCandidate[]>();
  private coinListLoadedAt = 0;
  private coinListRefreshInFlight: Promise<CoinListLoadResult> | null = null;
  private resolutionInFlight: Promise<void> | null = null;

  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    if (process.env.VITEST !== 'true') {
      logger.info(
        {
          domain: 'asset-image',
          action: 'preload_start',
          prioritySymbols: PRIORITY_WARMUP_ASSET_KEYS,
          defaultSymbols: DEFAULT_WARMUP_ASSET_KEYS,
        },
        `[AssetImageDebug] action=preload_start priorityCount=${PRIORITY_WARMUP_ASSET_KEYS.length} defaultCount=${DEFAULT_WARMUP_ASSET_KEYS.length}`,
      );
      this.queueWarmup(PRIORITY_WARMUP_ASSET_KEYS, 'priority');
      this.queueWarmup(DEFAULT_WARMUP_ASSET_KEYS, 'normal');
      this.refreshTimer = setInterval(() => {
        this.queueWarmup(PRIORITY_WARMUP_ASSET_KEYS, 'priority');
        this.queueWarmup(DEFAULT_WARMUP_ASSET_KEYS, 'normal');
      }, ASSET_METADATA_BACKGROUND_REFRESH_INTERVAL_MS);
    }
  }

  stop() {
    this.started = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.resolveTimer) {
      clearTimeout(this.resolveTimer);
      this.resolveTimer = null;
    }
    this.pendingResolutions.clear();
  }

  async getAssetViews(lookups: AssetMetadataLookup[]): Promise<Map<string, AssetMetadataView>> {
    const normalizedRequests = lookups
      .map((lookup) => ({
        requestKey: lookup.canonicalAssetKey ?? lookup.symbol ?? lookup.exchangeSymbol ?? '',
        canonicalAssetKey: this.resolveCanonicalAssetKey(lookup),
        lookup,
      }))
      .filter((item) => item.canonicalAssetKey);

    const views = new Map<string, AssetMetadataView>();
    if (normalizedRequests.length === 0) {
      return views;
    }

    const canonicalKeys = Array.from(new Set(normalizedRequests.map((item) => item.canonicalAssetKey!)));
    const now = Date.now();
    const unresolvedKeys: string[] = [];

    for (const canonicalAssetKey of canonicalKeys) {
      const memoryHit = this.readMemory(canonicalAssetKey, now);
      if (memoryHit) {
        this.logCacheHit(canonicalAssetKey, 'memory');
        views.set(canonicalAssetKey, this.toView(memoryHit));
        if (memoryHit.staleAt <= now) {
          this.scheduleResolve({
            canonicalAssetKey,
            priority: resolveAssetPriority(canonicalAssetKey),
          });
        }
        continue;
      }

      unresolvedKeys.push(canonicalAssetKey);
    }

    if (unresolvedKeys.length > 0 && (this.started || process.env.VITEST !== 'true')) {
      const persisted = await this.readPersistentMany(unresolvedKeys);
      for (const [canonicalAssetKey, entry] of persisted.entries()) {
        if (!entry) {
          continue;
        }

        this.logCacheHit(canonicalAssetKey, 'persistent');
        this.memoryCache.set(canonicalAssetKey, entry);
        views.set(canonicalAssetKey, this.toView(entry));
        if (entry.staleAt <= now) {
          this.scheduleResolve({
            canonicalAssetKey,
            priority: resolveAssetPriority(canonicalAssetKey),
          });
        }
      }
    }

    for (const request of normalizedRequests) {
      const canonicalAssetKey = request.canonicalAssetKey!;
      const view = views.get(canonicalAssetKey);
      if (!view) {
        const resolveRequest = {
          canonicalAssetKey,
          exchange: request.lookup.exchange,
          symbol: request.lookup.symbol,
          exchangeSymbol: request.lookup.exchangeSymbol,
          displayName: request.lookup.displayName,
          priority: resolveAssetPriority(canonicalAssetKey),
        };
        this.scheduleResolve(resolveRequest);
        const fallbackView = this.buildImmediateFallbackView(resolveRequest);
        logger.info(
          {
            domain: 'asset-image',
            action: 'return_fallback_image',
            reason: fallbackView.failureReason,
            symbol: request.lookup.symbol ?? canonicalAssetKey,
            exchange: request.lookup.exchange,
            fallbackType: fallbackView.fallbackType ?? null,
            source: fallbackView.source ?? null,
          },
          `[AssetImageDebug] action=return_fallback_image symbol=${request.lookup.symbol ?? canonicalAssetKey} fallbackType=${fallbackView.fallbackType ?? 'null'} source=${fallbackView.source ?? 'null'}`,
        );
        this.logFallbackHit({
          canonicalAssetKey,
          symbol: request.lookup.symbol ?? request.lookup.exchangeSymbol ?? canonicalAssetKey,
          exchange: request.lookup.exchange ?? null,
          fallbackType: fallbackView.fallbackType ?? 'default_placeholder',
          source: fallbackView.source ?? 'placeholder',
          reason: fallbackView.failureReason ?? 'missing_metadata',
          coingeckoId: fallbackView.coingeckoId,
        });
        views.set(canonicalAssetKey, fallbackView);
      }
    }

    this.logLookupSummary(normalizedRequests.map((request) => ({
      canonicalAssetKey: request.canonicalAssetKey!,
      view: views.get(request.canonicalAssetKey!),
      lookup: request.lookup,
    })));
    return views;
  }

  async getAssetViewsSafely(lookups: AssetMetadataLookup[], context: string) {
    try {
      return await this.getAssetViews(lookups);
    } catch (error) {
      logger.warn(
        {
          domain: 'asset-image',
          action: 'asset_view_lookup_failed',
          context,
          err: error,
        },
        `[AssetImageDebug] action=asset_view_lookup_failed context=${context}`,
      );
      return new Map<string, AssetMetadataView>();
    }
  }

  preloadAssetLookups(lookups: AssetMetadataLookup[], priority: AssetResolvePriority = 'priority') {
    const canonicalKeys = Array.from(
      new Set(
        lookups
          .map((lookup) => this.resolveCanonicalAssetKey(lookup, { logResolution: false }))
          .filter((value): value is string => Boolean(value)),
      ),
    );

    if (canonicalKeys.length === 0) {
      return;
    }

    logger.info(
      {
        domain: 'asset-image',
        action: 'preload_visible',
        priority,
        totalCount: canonicalKeys.length,
        canonicalAssetKeys: canonicalKeys,
      },
      `[AssetImageDebug] action=preload_visible priority=${priority} total=${canonicalKeys.length}`,
    );
    this.queueWarmup(canonicalKeys, priority);
  }

  primeForTests(entries: AssetMetadataCacheEntry[]) {
    for (const entry of entries) {
      this.memoryCache.set(entry.canonicalAssetKey, entry);
    }
  }

  resetForTests() {
    this.stop();
    this.memoryCache.clear();
    this.missingImageStats.clear();
    this.pendingResolutions.clear();
    this.coinListBySymbol.clear();
    this.coinListLoadedAt = 0;
    this.coinListRefreshInFlight = null;
    this.resolutionInFlight = null;
  }

  private resolveCanonicalAssetKey(
    lookup: AssetMetadataLookup,
    options?: { logResolution?: boolean },
  ) {
    const resolved = resolveCanonicalAssetImageKey({
      exchange: lookup.exchange,
      canonicalAssetKey: lookup.canonicalAssetKey,
      symbol: lookup.symbol,
      exchangeSymbol: lookup.exchangeSymbol,
      rawSymbol: lookup.exchangeSymbol,
    });
    const logResolution = options?.logResolution ?? true;
    const symbolForLog = lookup.symbol ?? lookup.exchangeSymbol ?? lookup.canonicalAssetKey ?? null;

    if (logResolution && containsNonAsciiAssetText(symbolForLog)) {
      logger.warn(
        {
          domain: 'asset-image',
          action: 'unusual_symbol',
          reason: 'non_ascii_symbol',
          exchange: lookup.exchange ?? null,
          symbol: symbolForLog,
          canonicalAssetKey: resolved.canonicalAssetKey,
        },
        `[AssetImageDebug] action=unusual_symbol reason=non_ascii_symbol exchange=${lookup.exchange ?? 'null'} symbol=${symbolForLog}`,
      );
    }

    if (logResolution && resolved.aliasHit && resolved.canonicalAssetKey) {
      logger.info(
        {
          domain: 'asset-image',
          action: 'alias_hit',
          exchange: lookup.exchange ?? null,
          symbol: symbolForLog,
          canonicalAssetKey: resolved.canonicalAssetKey,
          matchedBy: resolved.matchedBy,
          input: resolved.input,
        },
        `[AssetImageDebug] action=alias_hit exchange=${lookup.exchange ?? 'null'} symbol=${symbolForLog ?? 'null'} canonicalAssetKey=${resolved.canonicalAssetKey}`,
      );
    }

    if (logResolution && !resolved.canonicalAssetKey) {
      logger.info(
        {
          domain: 'asset-image',
          action: 'alias_miss',
          exchange: lookup.exchange ?? null,
          symbol: symbolForLog,
          matchedBy: resolved.matchedBy,
        },
        `[AssetImageDebug] action=alias_miss exchange=${lookup.exchange ?? 'null'} symbol=${symbolForLog ?? 'null'}`,
      );
    }

    return resolved.canonicalAssetKey;
  }

  private readMemory(canonicalAssetKey: string, now: number) {
    const entry = this.memoryCache.get(canonicalAssetKey);
    if (!entry) {
      return null;
    }

    if (entry.usableUntil <= now) {
      this.memoryCache.delete(canonicalAssetKey);
      return null;
    }

    return entry;
  }

  private async readPersistentMany(canonicalAssetKeys: string[]) {
    const result = new Map<string, AssetMetadataCacheEntry | null>();
    try {
      const values = await redis.mget(canonicalAssetKeys.map((key) => toRedisKey(key)));
      canonicalAssetKeys.forEach((canonicalAssetKey, index) => {
        const payload = values[index];
        if (!payload) {
          result.set(canonicalAssetKey, null);
          return;
        }

        try {
          const parsed = JSON.parse(payload) as AssetMetadataCacheEntry;
          result.set(canonicalAssetKey, parsed.usableUntil > Date.now() ? parsed : null);
        } catch {
          result.set(canonicalAssetKey, null);
        }
      });
    } catch (error) {
      logger.debug({ domain: 'asset-image', err: error }, 'Asset metadata redis lookup failed');
      canonicalAssetKeys.forEach((canonicalAssetKey) => result.set(canonicalAssetKey, null));
    }
    return result;
  }

  private async readExistingEntry(canonicalAssetKey: string) {
    const memoryEntry = this.memoryCache.get(canonicalAssetKey);
    if (memoryEntry) {
      return memoryEntry;
    }

    const persisted = await this.readPersistentMany([canonicalAssetKey]);
    return persisted.get(canonicalAssetKey) ?? null;
  }

  private toView(entry: AssetMetadataCacheEntry, originalSymbol?: string | null): AssetMetadataView {
    const fallbackMetadata = getAssetRegistryMetadata(entry.canonicalAssetKey, originalSymbol);
    return {
      canonicalAssetKey: entry.canonicalAssetKey,
      assetImageUrl: entry.imageUrl,
      symbolImageUrl: entry.imageUrl,
      coingeckoId: entry.coingeckoId,
      source: entry.source,
      failureReason: entry.failureReason ?? null,
      fallbackType: entry.fallbackType ?? null,
      fallbackHit: Boolean(entry.fallbackType),
      imageAvailability: this.toImageAvailability(entry),
      assetType: entry.assetType ?? fallbackMetadata.assetType,
      canonicalName: entry.canonicalName ?? fallbackMetadata.canonicalName,
      fallbackColor: entry.fallbackColor ?? fallbackMetadata.fallbackColor,
      fallbackInitials: entry.fallbackInitials ?? fallbackMetadata.fallbackInitials,
    };
  }

  private buildImmediateFallbackView(request: AssetResolveRequest): AssetMetadataView {
    const fallback = this.resolveLocalFallback(request.canonicalAssetKey, undefined, request.symbol);
    return {
      canonicalAssetKey: request.canonicalAssetKey,
      assetImageUrl: fallback.imageUrl,
      symbolImageUrl: fallback.imageUrl,
      coingeckoId: fallback.coingeckoId,
      source: fallback.source,
      failureReason: 'missing_metadata',
      fallbackType: fallback.fallbackType,
      fallbackHit: true,
      imageAvailability: fallback.fallbackType === 'default_placeholder' || fallback.fallbackType === 'fiat_initials'
        ? 'pending'
        : 'fallback',
      assetType: fallback.assetType,
      canonicalName: fallback.canonicalName,
      fallbackColor: fallback.fallbackColor,
      fallbackInitials: fallback.fallbackInitials,
    };
  }

  private resolveLocalFallback(canonicalAssetKey: string, coingeckoId?: string | null, originalSymbol?: string | null) {
    const override = CURATED_ASSET_OVERRIDES[canonicalAssetKey];
    const fallbackMetadata = getAssetRegistryMetadata(canonicalAssetKey, originalSymbol);
    const curatedIconUrl = resolveIconUrl(canonicalAssetKey);
    const normalizedImageUrl = normalizeAssetImageUrl(
      override?.fallbackImageUrl ?? curatedIconUrl ?? DEFAULT_COIN_PLACEHOLDER_ICON_URL,
    ) ?? DEFAULT_COIN_PLACEHOLDER_ICON_URL;
    const aliasHit = Boolean(override || curatedIconUrl);
    const fallbackType = aliasHit
      ? 'symbol_alias' as const
      : fallbackMetadata.imagePolicy === 'fiat_initials'
        ? 'fiat_initials' as const
        : 'default_placeholder' as const;

    return {
      imageUrl: normalizedImageUrl,
      coingeckoId: coingeckoId ?? override?.coingeckoId ?? null,
      source: aliasHit ? 'alias_fallback' as const : 'placeholder' as const,
      fallbackType,
      confidence: override ? 'high' as const : 'low' as const,
      assetType: fallbackMetadata.assetType,
      canonicalName: fallbackMetadata.canonicalName,
      fallbackColor: fallbackMetadata.fallbackColor,
      fallbackInitials: fallbackMetadata.fallbackInitials,
    };
  }

  private toImageAvailability(entry: Pick<AssetMetadataCacheEntry, 'imageUrl' | 'failureReason' | 'fallbackType' | 'source'>): AssetImageAvailability {
    if (entry.imageUrl && entry.fallbackType && entry.fallbackType !== 'default_placeholder' && entry.fallbackType !== 'fiat_initials') {
      return 'fallback';
    }
    if (entry.imageUrl && !entry.fallbackType) {
      return 'available';
    }
    if (entry.failureReason === 'coingecko_fetch_failed') {
      return 'lookup_failed';
    }
    if (entry.failureReason === 'missing_metadata') {
      return 'pending';
    }
    return 'unavailable';
  }

  private logCacheHit(canonicalAssetKey: string, source: 'memory' | 'persistent') {
    logger.info(
      {
        domain: 'asset-image',
        action: 'cache_hit',
        canonicalAssetKey,
        source,
      },
      `[AssetImageDebug] action=cache_hit canonicalAssetKey=${canonicalAssetKey} source=${source}`,
    );
  }

  private logMappingResolved(params: { symbol: string; canonicalAssetKey: string; coingeckoId: string }) {
    logger.info(
      {
        domain: 'asset-image',
        action: 'mapping_resolved',
        symbol: params.symbol,
        canonicalAssetKey: params.canonicalAssetKey,
        coingeckoId: params.coingeckoId,
      },
      `[AssetImageDebug] action=mapping_resolved symbol=${params.symbol} canonicalAssetKey=${params.canonicalAssetKey} coingeckoId=${params.coingeckoId}`,
    );
  }

  private logMappingFailed(params: { symbol: string; reason: string }) {
    logger.info(
      {
        domain: 'asset-image',
        action: 'mapping_failed',
        symbol: params.symbol,
        reason: params.reason,
      },
      `[AssetImageDebug] action=mapping_failed symbol=${params.symbol} reason=${params.reason}`,
    );
  }

  private logFallbackHit(params: {
    canonicalAssetKey: string;
    symbol?: string | null;
    exchange?: ExchangeId | null;
    fallbackType: AssetImageFallbackType;
    source: AssetMetadataSource;
    reason: AssetImageFailureReason;
    coingeckoId?: string | null;
  }) {
    this.recordMissingAsset(params);
    logger.info(
      {
        domain: 'asset-image',
        action: 'fallback_hit',
        canonicalAssetKey: params.canonicalAssetKey,
        symbol: params.symbol ?? null,
        exchange: params.exchange ?? null,
        fallbackType: params.fallbackType,
        source: params.source,
        reason: params.reason,
        coingeckoId: params.coingeckoId ?? null,
      },
      `[AssetImageDebug] action=fallback_hit canonicalAssetKey=${params.canonicalAssetKey} fallbackType=${params.fallbackType} source=${params.source} reason=${params.reason}`,
    );
  }

  private logLookupSummary(lookups: Array<{
    canonicalAssetKey: string;
    view?: AssetMetadataView;
    lookup: AssetMetadataLookup;
  }>) {
    const availabilityCounts = lookups.reduce<Record<AssetImageAvailability, number>>(
      (summary, item) => {
        const availability = item.view?.imageAvailability ?? 'pending';
        summary[availability] += 1;
        return summary;
      },
      { available: 0, fallback: 0, pending: 0, lookup_failed: 0, unavailable: 0 },
    );
    const failureReasons = lookups
      .map((item) => item.view?.failureReason)
      .filter((reason): reason is AssetImageFailureReason => Boolean(reason));
    const nonAsciiCount = lookups.filter((item) =>
      containsNonAsciiAssetText(item.lookup.symbol)
      || containsNonAsciiAssetText(item.lookup.exchangeSymbol)
      || containsNonAsciiAssetText(item.lookup.displayName)).length;

    logger.info(
      {
        domain: 'asset-image',
        action: 'lookup_summary',
        totalCount: lookups.length,
        hitCount: availabilityCounts.available + availabilityCounts.fallback,
        missCount: availabilityCounts.pending + availabilityCounts.lookup_failed + availabilityCounts.unavailable,
        availabilityCounts,
        missReasonStats: summarizeCounts(failureReasons),
        nonAsciiSymbolCount: nonAsciiCount,
      },
      `[AssetImageDebug] action=lookup_summary total=${lookups.length} hit=${availabilityCounts.available + availabilityCounts.fallback} miss=${availabilityCounts.pending + availabilityCounts.lookup_failed + availabilityCounts.unavailable}`,
    );

    this.logTopMissingImageAssets();
  }

  private recordMissingAsset(params: {
    canonicalAssetKey: string;
    symbol?: string | null;
    exchange?: ExchangeId | null;
    fallbackType: AssetImageFallbackType;
    source: AssetMetadataSource;
    reason: AssetImageFailureReason;
  }) {
    if (params.fallbackType !== 'default_placeholder' && params.fallbackType !== 'fiat_initials') {
      return;
    }

    const now = Date.now();
    const existing = this.missingImageStats.get(params.canonicalAssetKey);
    this.missingImageStats.set(params.canonicalAssetKey, {
      canonicalAssetKey: params.canonicalAssetKey,
      symbol: params.symbol ?? existing?.symbol ?? null,
      exchange: params.exchange ?? existing?.exchange ?? null,
      count: (existing?.count ?? 0) + 1,
      reason: params.reason,
      fallbackType: params.fallbackType,
      source: params.source,
      lastSeenAt: now,
    });
  }

  private logTopMissingImageAssets(limit = 10) {
    if (env.NODE_ENV === 'production' && process.env.ASSET_IMAGE_DEBUG !== 'true') {
      return;
    }

    const topMissingAssets = Array.from(this.missingImageStats.values())
      .sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt)
      .slice(0, limit);

    if (topMissingAssets.length === 0) {
      return;
    }

    logger.info(
      {
        domain: 'asset-image',
        action: 'top_missing_assets',
        totalTrackedMissingCount: this.missingImageStats.size,
        topMissingAssets,
        reasonStats: summarizeCounts(topMissingAssets.map((item) => item.reason)),
      },
      `[AssetImageDebug] action=top_missing_assets tracked=${this.missingImageStats.size} top=${topMissingAssets.length}`,
    );
  }

  private logCoinGeckoRequest(params: {
    path: string;
    requestUrl: string | null;
    statusCode: number | null;
    responseSnippet: string | null;
    failed: boolean;
    err?: unknown;
  }) {
    const level = params.failed ? logger.warn.bind(logger) : logger.info.bind(logger);
    level(
      {
        domain: 'asset-image',
        action: 'coingecko_request',
        owner: 'coingecko',
        path: params.path,
        finalRequestUrl: params.requestUrl,
        statusCode: params.statusCode,
        responseSnippet: params.responseSnippet,
        failed: params.failed,
        err: params.failed ? params.err : undefined,
      },
      `[AssetImageDebug] action=coingecko_request owner=coingecko path=${params.path} statusCode=${params.statusCode ?? 'null'} failed=${params.failed} finalRequestUrl=${params.requestUrl ?? 'null'}`,
    );
  }

  private queueWarmup(canonicalAssetKeys: readonly string[], priority: AssetResolvePriority) {
    for (const canonicalAssetKey of canonicalAssetKeys) {
      const normalizedCanonicalAssetKey = toCanonicalSymbol(canonicalAssetKey);
      if (priority === 'priority') {
        logger.info(
          {
            domain: 'asset-image',
            action: 'priority_refresh',
            symbol: canonicalAssetKey,
            priority,
          },
          `[AssetImageDebug] action=priority_refresh symbol=${canonicalAssetKey} priority=${priority}`,
        );
      }
      this.scheduleResolve({
        canonicalAssetKey: normalizedCanonicalAssetKey,
        symbol: canonicalAssetKey,
        priority,
      });
    }
  }

  private scheduleResolve(request: AssetResolveRequest) {
    if (!this.started || !request.canonicalAssetKey) {
      return;
    }

    const priority = request.priority ?? resolveAssetPriority(request.canonicalAssetKey);
    const existing = this.pendingResolutions.get(request.canonicalAssetKey);
    if (!existing) {
      logger.info(
        {
          domain: 'asset-image',
          action: 'resolve_start',
          symbol: request.symbol ?? request.canonicalAssetKey,
          exchange: request.exchange,
        },
        `[AssetImageDebug] action=resolve_start exchange=${request.exchange ?? 'null'} symbol=${request.symbol ?? request.canonicalAssetKey}`,
      );
    }

    this.pendingResolutions.set(request.canonicalAssetKey, {
      ...existing,
      ...request,
      priority: existing?.priority === 'priority' || priority === 'priority' ? 'priority' : 'normal',
    });

    if (priority === 'priority') {
      if (this.resolveTimer) {
        clearTimeout(this.resolveTimer);
      }
      this.resolveTimer = setTimeout(() => {
        this.resolveTimer = null;
        void this.flushPendingResolutions();
      }, 0);
      return;
    }

    if (!this.resolveTimer) {
      this.resolveTimer = setTimeout(() => {
        this.resolveTimer = null;
        void this.flushPendingResolutions();
      }, ASSET_METADATA_REFRESH_DEBOUNCE_MS);
    }
  }

  private async flushPendingResolutions() {
    if (this.resolutionInFlight || this.pendingResolutions.size === 0) {
      return;
    }

    const batch = Array.from(this.pendingResolutions.values()).sort((left, right) => {
      const leftRank = left.priority === 'priority' ? 0 : 1;
      const rightRank = right.priority === 'priority' ? 0 : 1;
      return leftRank - rightRank;
    });
    this.pendingResolutions.clear();
    this.resolutionInFlight = this.resolveBatch(batch)
      .catch((error) => {
        logger.warn({ domain: 'asset-image', err: error }, 'Asset metadata background resolve failed');
      })
      .finally(() => {
        this.resolutionInFlight = null;
        if (batch.some((item) => TOP_SYMBOL_COVERAGE_ASSET_KEYS.includes(item.canonicalAssetKey))) {
          void this.logTopSymbolCoverage();
        }
        if (this.pendingResolutions.size > 0) {
          void this.flushPendingResolutions();
        }
      });

    return this.resolutionInFlight;
  }

  private async resolveBatch(batch: AssetResolveRequest[]) {
    const requests = batch.filter((item) => item.canonicalAssetKey);
    if (requests.length === 0) {
      return;
    }

    let coinListStatus: CoinListLoadResult = {
      loaded: this.coinListBySymbol.size > 0,
      usedStale: false,
      failed: false,
    };
    if (requests.some((request) => !CURATED_ASSET_OVERRIDES[request.canonicalAssetKey])) {
      coinListStatus = await this.ensureCoinListLoaded();
    }
    const now = Date.now();
    const matchedIds = new Map<string, { coingeckoId: string; confidence: AssetMetadataConfidence; name: string | null; source: AssetMetadataSource }>();

    for (const request of requests) {
      const cached = this.readMemory(request.canonicalAssetKey, now);
      if (cached && cached.staleAt > now) {
        continue;
      }

      const curated = this.resolveFromCuratedOverride(request);
      if (curated) {
        matchedIds.set(request.canonicalAssetKey, curated);
        this.logMappingResolved({
          symbol: request.symbol ?? request.canonicalAssetKey,
          canonicalAssetKey: request.canonicalAssetKey,
          coingeckoId: curated.coingeckoId,
        });
        logger.info(
          {
            domain: 'asset-image',
            action: 'coingecko_match',
            canonicalAssetKey: request.canonicalAssetKey,
            coingeckoId: curated.coingeckoId,
            confidence: curated.confidence,
          },
          `[AssetImageDebug] action=coingecko_match canonicalAssetKey=${request.canonicalAssetKey} coingeckoId=${curated.coingeckoId} confidence=${curated.confidence}`,
        );
        continue;
      }

      if (!coinListStatus.loaded) {
        this.logMappingFailed({
          symbol: request.symbol ?? request.canonicalAssetKey,
          reason: 'coingecko_fetch_failed',
        });
        await this.persistFallbackEntry({
          request,
          now,
          failureReason: 'coingecko_fetch_failed',
        });
        continue;
      }

      const inferred = this.resolveFromCoinList(request);
      if (inferred.matched) {
        matchedIds.set(request.canonicalAssetKey, inferred);
        this.logMappingResolved({
          symbol: request.symbol ?? request.canonicalAssetKey,
          canonicalAssetKey: request.canonicalAssetKey,
          coingeckoId: inferred.coingeckoId,
        });
        logger.info(
          {
            domain: 'asset-image',
            action: 'coingecko_match',
            canonicalAssetKey: request.canonicalAssetKey,
            coingeckoId: inferred.coingeckoId,
            confidence: inferred.confidence,
          },
          `[AssetImageDebug] action=coingecko_match canonicalAssetKey=${request.canonicalAssetKey} coingeckoId=${inferred.coingeckoId} confidence=${inferred.confidence}`,
        );
        continue;
      }

      this.logMappingFailed({
        symbol: request.symbol ?? request.canonicalAssetKey,
        reason: inferred.reason,
      });

      await this.persistFallbackEntry({
        request,
        now,
        failureReason: 'alias_not_found',
      });
      logger.info(
        {
          domain: 'asset-image',
          action: 'coingecko_fallback_persisted',
          canonicalAssetKey: request.canonicalAssetKey,
        },
        `[AssetImageDebug] action=coingecko_fallback_persisted canonicalAssetKey=${request.canonicalAssetKey}`,
      );
    }

    const marketIds = Array.from(new Set(Array.from(matchedIds.values()).map((item) => item.coingeckoId)));
    if (marketIds.length === 0) {
      return;
    }

    const marketResults = await this.fetchCoinMarketsByIds(marketIds);
    const marketById = new Map(marketResults.items.map((item) => [item.id, item]));

    for (const [canonicalAssetKey, matched] of matchedIds.entries()) {
      const market = marketById.get(matched.coingeckoId);
      logger.info(
        {
          domain: 'asset-image',
          action: 'coingecko_lookup',
          canonicalAssetKey,
        },
        `[AssetImageDebug] action=coingecko_lookup canonicalAssetKey=${canonicalAssetKey}`,
      );

      const normalizedImageUrl = normalizeAssetImageUrl(market?.image ?? null);
      if (marketResults.failedIds.has(matched.coingeckoId)) {
        await this.persistFallbackEntry({
          request: {
            canonicalAssetKey,
            displayName: matched.name,
          },
          now,
          coingeckoId: matched.coingeckoId,
          name: matched.name,
          failureReason: 'coingecko_fetch_failed',
        });
        continue;
      }

      if (!market || !normalizedImageUrl) {
        this.logMappingFailed({
          symbol: canonicalAssetKey,
          reason: market?.image ? 'invalid_image_url' : 'market_image_missing',
        });
        await this.persistFallbackEntry({
          request: {
            canonicalAssetKey,
            displayName: matched.name,
          },
          now,
          coingeckoId: matched.coingeckoId,
          name: matched.name,
          failureReason: 'image_url_empty',
        });
        logger.info(
          {
            domain: 'asset-image',
            action: 'coingecko_fallback_persisted',
            canonicalAssetKey,
          },
          `[AssetImageDebug] action=coingecko_fallback_persisted canonicalAssetKey=${canonicalAssetKey}`,
        );
        continue;
      }

      const fallbackMetadata = getAssetRegistryMetadata(canonicalAssetKey);
      await this.persistEntry({
        canonicalAssetKey,
        coingeckoId: matched.coingeckoId,
        imageUrl: normalizedImageUrl,
        symbol: (market.symbol ?? canonicalAssetKey).toUpperCase(),
        name: market.name ?? matched.name,
        updatedAt: now,
        source: matched.source,
        confidence: matched.confidence,
        isNegativeCache: false,
        staleAt: now + ASSET_METADATA_POSITIVE_TTL_MS,
        usableUntil: now + ASSET_METADATA_POSITIVE_USABLE_TTL_MS,
        failureReason: null,
        fallbackType: null,
        assetType: fallbackMetadata.assetType,
        canonicalName: fallbackMetadata.canonicalName,
        fallbackColor: fallbackMetadata.fallbackColor,
        fallbackInitials: fallbackMetadata.fallbackInitials,
      });
    }
  }

  private resolveFromCuratedOverride(request: AssetResolveRequest) {
    const override = CURATED_ASSET_OVERRIDES[request.canonicalAssetKey];
    if (!override) {
      return null;
    }

    return {
      coingeckoId: override.coingeckoId,
      confidence: 'high' as const,
      name: request.displayName ?? COIN_MAP.get(request.canonicalAssetKey)?.nameEn ?? null,
      source: 'curated' as const,
    };
  }

  private resolveFromCoinList(request: AssetResolveRequest):
    | { matched: true; coingeckoId: string; confidence: AssetMetadataConfidence; name: string; source: AssetMetadataSource }
    | { matched: false; reason: string } {
    const candidates = this.coinListBySymbol.get(request.canonicalAssetKey.toLowerCase()) ?? [];
    if (candidates.length === 0) {
      return {
        matched: false,
        reason: 'coin_list_no_candidate',
      };
    }

    const preferredNames = new Set<string>();
    const coinInfo = COIN_MAP.get(request.canonicalAssetKey);
    const normalizedDisplayName = normalizeComparableText(request.displayName);
    if (normalizedDisplayName) {
      preferredNames.add(normalizedDisplayName);
    }
    if (coinInfo?.nameEn) {
      preferredNames.add(normalizeComparableText(coinInfo.nameEn));
    }
    const overrideAliases = CURATED_ASSET_OVERRIDES[request.canonicalAssetKey]?.aliases ?? [];
    for (const alias of overrideAliases) {
      preferredNames.add(normalizeComparableText(alias));
    }

    if (candidates.length === 1) {
      return {
        matched: true,
        coingeckoId: candidates[0].id,
        confidence: preferredNames.size > 0 ? 'medium' : 'low',
        name: candidates[0].name,
        source: 'coingecko',
      };
    }

    const exactNameMatches = candidates.filter((candidate) => preferredNames.has(normalizeComparableText(candidate.name)));
    const selected = exactNameMatches.length === 1 ? exactNameMatches[0] : null;
    if (!selected) {
      return {
        matched: false,
        reason: exactNameMatches.length > 1 ? 'coin_list_name_collision' : 'coin_list_symbol_collision',
      };
    }

    return {
      matched: true,
      coingeckoId: selected.id,
      confidence: 'medium' as const,
      name: selected.name,
      source: 'coingecko' as const,
    };
  }

  private async ensureCoinListLoaded(): Promise<CoinListLoadResult> {
    const now = Date.now();
    if (this.coinListLoadedAt > 0 && now - this.coinListLoadedAt < COINGECKO_COIN_LIST_REFRESH_INTERVAL_MS) {
      return {
        loaded: true,
        usedStale: false,
        failed: false,
      };
    }
    if (this.coinListRefreshInFlight) {
      return this.coinListRefreshInFlight;
    }

    this.coinListRefreshInFlight = (async () => {
      try {
        const headers = this.buildCoinGeckoHeaders();
        const items = await this.requestCoinGecko<CoinGeckoCoinListItem[]>('/coins/list', {
          headers,
          query: {
            include_platform: false,
            status: 'active',
          },
          timeoutMs: 12_000,
          retryPolicy: {
            maxAttempts: 2,
          },
        });

        const bySymbol = new Map<string, CoinGeckoSymbolCandidate[]>();
        for (const item of items) {
          const normalizedSymbol = item.symbol.trim().toLowerCase();
          const bucket = bySymbol.get(normalizedSymbol) ?? [];
          bucket.push({
            id: item.id,
            symbol: item.symbol,
            name: item.name,
          });
          bySymbol.set(normalizedSymbol, bucket);
        }

        this.coinListBySymbol = bySymbol;
        this.coinListLoadedAt = Date.now();
        return {
          loaded: true,
          usedStale: false,
          failed: false,
        };
      } catch (error) {
        logger.warn(
          {
            domain: 'asset-image',
            action: 'coin_list_refresh_failed',
            hasStaleCoinList: this.coinListBySymbol.size > 0,
            err: error,
          },
          '[AssetImageDebug] action=coin_list_refresh_failed',
        );
        return {
          loaded: this.coinListBySymbol.size > 0,
          usedStale: this.coinListBySymbol.size > 0,
          failed: true,
          error,
        };
      }
    })()
      .finally(() => {
        this.coinListRefreshInFlight = null;
      });

    return this.coinListRefreshInFlight;
  }

  private async fetchCoinMarketsByIds(ids: string[]): Promise<CoinMarketsFetchResult> {
    const chunks = chunk(ids, COINGECKO_MARKETS_BATCH_LIMIT);
    const headers = this.buildCoinGeckoHeaders();
    const results: CoinGeckoCoinMarketsItem[] = [];
    const failedIds = new Set<string>();

    for (const idChunk of chunks) {
      try {
        const response = await this.requestCoinGecko<CoinGeckoCoinMarketsItem[]>('/coins/markets', {
          headers,
          query: {
            vs_currency: 'usd',
            ids: idChunk.join(','),
            sparkline: false,
            locale: 'en',
            per_page: idChunk.length,
            page: 1,
          },
          timeoutMs: 12_000,
          retryPolicy: {
            maxAttempts: 2,
          },
        });
        results.push(...response);
      } catch (error) {
        idChunk.forEach((id) => failedIds.add(id));
        logger.warn(
          {
            domain: 'asset-image',
            action: 'coin_markets_chunk_failed',
            ids: idChunk,
            err: error,
          },
          `[AssetImageDebug] action=coin_markets_chunk_failed chunkSize=${idChunk.length}`,
        );
      }
    }

    return {
      items: results,
      failedIds,
    };
  }

  private async requestCoinGecko<T>(path: string, options: RestRequestOptions) {
    try {
      const response = await this.coingeckoClient.requestDetailed<T>(path, options);
      this.logCoinGeckoRequest({
        path: response.meta.path,
        requestUrl: response.meta.requestUrl,
        statusCode: response.meta.statusCode,
        responseSnippet: response.meta.responseSnippet,
        failed: false,
      });
      return response.data;
    } catch (error) {
      const details = readExchangeErrorDetails(error);
      this.logCoinGeckoRequest({
        path,
        requestUrl: details?.requestUrl ?? null,
        statusCode: details?.statusCode ?? null,
        responseSnippet: truncateSnippet(details?.responseBody ?? null),
        failed: true,
        err: error,
      });
      throw error;
    }
  }

  private async persistFallbackEntry(params: {
    request: AssetResolveRequest;
    now: number;
    failureReason: AssetImageFailureReason;
    coingeckoId?: string | null;
    name?: string | null;
  }) {
    const existing = await this.readExistingEntry(params.request.canonicalAssetKey);
    if (
      existing?.imageUrl
      && !existing.isNegativeCache
      && existing.source !== 'placeholder'
      && existing.source !== 'alias_fallback'
    ) {
      const staleEntry: AssetMetadataCacheEntry = {
        ...existing,
        updatedAt: params.now,
        source: 'stale_cache',
        staleAt: params.now + ASSET_METADATA_FALLBACK_STALE_TTL_MS,
        usableUntil: params.now + ASSET_METADATA_POSITIVE_USABLE_TTL_MS,
        failureReason: params.failureReason,
        fallbackType: 'stale_cache',
      };
      this.logFallbackHit({
        canonicalAssetKey: params.request.canonicalAssetKey,
        symbol: params.request.symbol ?? params.request.exchangeSymbol ?? params.request.canonicalAssetKey,
        exchange: params.request.exchange ?? null,
        fallbackType: 'stale_cache',
        source: 'stale_cache',
        reason: params.failureReason,
        coingeckoId: staleEntry.coingeckoId,
      });
      await this.persistEntry(staleEntry);
      return staleEntry;
    }

    const fallback = this.resolveLocalFallback(
      params.request.canonicalAssetKey,
      params.coingeckoId,
      params.request.symbol,
    );
    const entry: AssetMetadataCacheEntry = {
      canonicalAssetKey: params.request.canonicalAssetKey,
      coingeckoId: fallback.coingeckoId,
      imageUrl: fallback.imageUrl,
      symbol: params.request.canonicalAssetKey,
      name: params.name ?? params.request.displayName ?? COIN_MAP.get(params.request.canonicalAssetKey)?.nameEn ?? null,
      updatedAt: params.now,
      source: fallback.source,
      confidence: fallback.confidence,
      isNegativeCache: false,
      staleAt: params.now + ASSET_METADATA_FALLBACK_STALE_TTL_MS,
      usableUntil: params.now + ASSET_METADATA_POSITIVE_USABLE_TTL_MS,
      failureReason: params.failureReason,
      fallbackType: fallback.fallbackType,
      assetType: fallback.assetType,
      canonicalName: fallback.canonicalName,
      fallbackColor: fallback.fallbackColor,
      fallbackInitials: fallback.fallbackInitials,
    };
    this.logFallbackHit({
      canonicalAssetKey: params.request.canonicalAssetKey,
      symbol: params.request.symbol ?? params.request.exchangeSymbol ?? params.request.canonicalAssetKey,
      exchange: params.request.exchange ?? null,
      fallbackType: fallback.fallbackType,
      source: fallback.source,
      reason: params.failureReason,
      coingeckoId: entry.coingeckoId,
    });
    await this.persistEntry(entry);
    return entry;
  }

  private async logTopSymbolCoverage() {
    const now = Date.now();
    const keys = TOP_SYMBOL_COVERAGE_ASSET_KEYS.map((key) => toCanonicalSymbol(key)).filter(Boolean);
    const persistent = await this.readPersistentMany(keys);
    const entries = keys.map((key) => this.readMemory(key, now) ?? persistent.get(key) ?? null);
    const withImageCount = entries.filter((entry) => Boolean(entry?.imageUrl)).length;
    const fallbackHitCount = entries.filter((entry) => Boolean(entry?.fallbackType)).length;
    const falseReasons = entries
      .filter((entry): entry is AssetMetadataCacheEntry => Boolean(entry?.failureReason))
      .map((entry) => entry.failureReason as string);

    logger.info(
      {
        domain: 'asset-image',
        action: 'top_symbol_coverage',
        totalCount: keys.length,
        withImageCount,
        withoutImageCount: keys.length - withImageCount,
        coverageRate: toCoverageRate(withImageCount, keys.length),
        fallbackHitCount,
        falseReasonStats: summarizeCounts(falseReasons),
        topMissingAssets: Array.from(this.missingImageStats.values())
          .sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt)
          .slice(0, 10),
      },
      `[AssetImageDebug] action=top_symbol_coverage total=${keys.length} withImage=${withImageCount} coverageRate=${toCoverageRate(withImageCount, keys.length)}`,
    );
  }

  private buildCoinGeckoHeaders() {
    if (!env.COINGECKO_API_KEY) {
      return undefined;
    }

    return {
      [inferApiKeyHeaderName(env.COINGECKO_API_BASE_URL ?? 'https://api.coingecko.com/api/v3')]: env.COINGECKO_API_KEY,
    };
  }

  private async persistEntry(entry: AssetMetadataCacheEntry) {
    let persistedEntry = entry;
    if (!entry.imageUrl) {
      const existing = await this.readExistingEntry(entry.canonicalAssetKey);
      if (existing?.imageUrl) {
        logger.info(
          {
            domain: 'asset-image',
            action: 'preserve_existing_image',
            symbol: entry.symbol,
            previous: existing.imageUrl,
            incoming: entry.imageUrl,
          },
          `[AssetImageDebug] action=preserve_existing_image symbol=${entry.symbol} previous=${existing.imageUrl} incoming=${entry.imageUrl ?? 'null'}`,
        );
        const now = Date.now();
        persistedEntry = {
          ...existing,
          updatedAt: now,
          staleAt: now + ASSET_METADATA_POSITIVE_TTL_MS,
          usableUntil: now + ASSET_METADATA_POSITIVE_USABLE_TTL_MS,
        };
      }
    }

    this.memoryCache.set(persistedEntry.canonicalAssetKey, persistedEntry);
    try {
      const ttlSeconds = Math.max(Math.floor((persistedEntry.usableUntil - Date.now()) / 1000), 60);
      await redis.set(toRedisKey(persistedEntry.canonicalAssetKey), JSON.stringify(persistedEntry), 'EX', ttlSeconds);
    } catch (error) {
      logger.debug(
        { domain: 'asset-image', canonicalAssetKey: persistedEntry.canonicalAssetKey, err: error },
        'Asset metadata redis persist failed',
      );
    }
  }
}

export const assetMetadataService = new AssetMetadataService();
