import { COINS, COIN_MAP } from '../../config/constants';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { RestClient } from '../../core/exchange/rest.client';
import { toCanonicalSymbol } from '../../core/exchange/symbol.mapper';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { logger } from '../../utils/logger';

type AssetMetadataConfidence = 'high' | 'medium' | 'low';
type AssetMetadataSource = 'curated' | 'coingecko' | 'negative_cache';
type AssetResolvePriority = 'priority' | 'normal';

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
};

type AssetMetadataLookup = {
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

const ASSET_METADATA_REDIS_KEY_PREFIX = 'asset:metadata:v1';
const COINGECKO_COIN_LIST_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const ASSET_METADATA_BACKGROUND_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ASSET_METADATA_REFRESH_DEBOUNCE_MS = 50;
const ASSET_METADATA_POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ASSET_METADATA_POSITIVE_USABLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ASSET_METADATA_NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;
const ASSET_METADATA_NEGATIVE_USABLE_TTL_MS = 12 * 60 * 60 * 1000;
const COINGECKO_MARKETS_BATCH_LIMIT = 100;
const PRIORITY_WARMUP_ASSET_KEYS = ['BTC', 'ETH', 'XRP', 'ADA', 'SOL', 'DOGE', 'USDT', 'USDC', 'BNB', 'TRX'] as const;
const DEFAULT_WARMUP_ASSET_KEYS = Array.from(new Set([
  ...COINS.map((coin) => coin.symbol),
  'USDT',
  'USDC',
  'BNB',
  'TRX',
  'TON',
  'XLM',
  'HBAR',
]));

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
  MATIC: { coingeckoId: 'matic-network', aliases: ['polygon', 'matic'] },
  USDT: { coingeckoId: 'tether', aliases: ['tether'] },
  USDC: { coingeckoId: 'usd-coin', aliases: ['usd coin'] },
  BNB: { coingeckoId: 'binancecoin', aliases: ['bnb', 'binance coin'] },
  TRX: { coingeckoId: 'tron', aliases: ['tron'] },
  TON: { coingeckoId: 'the-open-network', aliases: ['toncoin', 'the open network'] },
  XLM: { coingeckoId: 'stellar', aliases: ['stellar'] },
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
};

function normalizeComparableText(value?: string | null) {
  return value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() ?? '';
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
  private readonly pendingResolutions = new Map<string, AssetResolveRequest>();
  private readonly coingeckoClient = new RestClient('coingecko', env.COINGECKO_API_BASE_URL ?? 'https://api.coingecko.com/api/v3');

  private started = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private resolveTimer: NodeJS.Timeout | null = null;
  private coinListBySymbol = new Map<string, CoinGeckoSymbolCandidate[]>();
  private coinListLoadedAt = 0;
  private coinListRefreshInFlight: Promise<void> | null = null;
  private resolutionInFlight: Promise<void> | null = null;

  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    if (process.env.VITEST !== 'true') {
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
        this.scheduleResolve({
          canonicalAssetKey,
          exchange: request.lookup.exchange,
          symbol: request.lookup.symbol,
          exchangeSymbol: request.lookup.exchangeSymbol,
          displayName: request.lookup.displayName,
          priority: resolveAssetPriority(canonicalAssetKey),
        });
        logger.info(
          {
            domain: 'asset-image',
            action: 'return_null_image',
            reason: 'no_mapping',
            symbol: request.lookup.symbol ?? canonicalAssetKey,
            exchange: request.lookup.exchange,
          },
          `[AssetImageDebug] action=return_null_image reason=no_mapping symbol=${request.lookup.symbol ?? canonicalAssetKey}`,
        );
        views.set(canonicalAssetKey, {
          canonicalAssetKey,
          assetImageUrl: null,
          symbolImageUrl: null,
          coingeckoId: null,
        });
      }
    }

    return views;
  }

  primeForTests(entries: AssetMetadataCacheEntry[]) {
    for (const entry of entries) {
      this.memoryCache.set(entry.canonicalAssetKey, entry);
    }
  }

  resetForTests() {
    this.stop();
    this.memoryCache.clear();
    this.pendingResolutions.clear();
    this.coinListBySymbol.clear();
    this.coinListLoadedAt = 0;
    this.coinListRefreshInFlight = null;
    this.resolutionInFlight = null;
  }

  private resolveCanonicalAssetKey(lookup: AssetMetadataLookup) {
    const candidates = [
      lookup.canonicalAssetKey,
      lookup.symbol,
      lookup.exchangeSymbol,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const normalized = toCanonicalSymbol(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return null;
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

  private toView(entry: AssetMetadataCacheEntry): AssetMetadataView {
    return {
      canonicalAssetKey: entry.canonicalAssetKey,
      assetImageUrl: entry.imageUrl,
      symbolImageUrl: entry.imageUrl,
      coingeckoId: entry.coingeckoId,
    };
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
          `[WarmupDebug] action=priority_refresh symbol=${canonicalAssetKey} priority=${priority}`,
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
        `[AssetImageDebug] action=resolve_start symbol=${request.symbol ?? request.canonicalAssetKey}${request.exchange ? ` exchange=${request.exchange}` : ''}`,
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

    if (requests.some((request) => !CURATED_ASSET_OVERRIDES[request.canonicalAssetKey])) {
      await this.ensureCoinListLoaded();
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

      await this.persistEntry({
        canonicalAssetKey: request.canonicalAssetKey,
        coingeckoId: null,
        imageUrl: null,
        symbol: request.canonicalAssetKey,
        name: request.displayName ?? null,
        updatedAt: now,
        source: 'negative_cache',
        confidence: 'low',
        isNegativeCache: true,
        staleAt: now + ASSET_METADATA_NEGATIVE_TTL_MS,
        usableUntil: now + ASSET_METADATA_NEGATIVE_USABLE_TTL_MS,
      });
      logger.info(
        {
          domain: 'asset-image',
          action: 'coingecko_negative_cache',
          canonicalAssetKey: request.canonicalAssetKey,
        },
        `[AssetImageDebug] action=coingecko_negative_cache canonicalAssetKey=${request.canonicalAssetKey}`,
      );
    }

    const marketIds = Array.from(new Set(Array.from(matchedIds.values()).map((item) => item.coingeckoId)));
    if (marketIds.length === 0) {
      return;
    }

    const marketResults = await this.fetchCoinMarketsByIds(marketIds);
    const marketById = new Map(marketResults.map((item) => [item.id, item]));

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
      if (!market || !normalizedImageUrl) {
        this.logMappingFailed({
          symbol: canonicalAssetKey,
          reason: market?.image ? 'invalid_image_url' : 'market_image_missing',
        });
        await this.persistEntry({
          canonicalAssetKey,
          coingeckoId: matched.coingeckoId,
          imageUrl: null,
          symbol: canonicalAssetKey,
          name: matched.name,
          updatedAt: now,
          source: matched.source,
          confidence: matched.confidence,
          isNegativeCache: true,
          staleAt: now + ASSET_METADATA_NEGATIVE_TTL_MS,
          usableUntil: now + ASSET_METADATA_NEGATIVE_USABLE_TTL_MS,
        });
        logger.info(
          {
            domain: 'asset-image',
            action: 'coingecko_negative_cache',
            canonicalAssetKey,
          },
          `[AssetImageDebug] action=coingecko_negative_cache canonicalAssetKey=${canonicalAssetKey}`,
        );
        continue;
      }

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

  private async ensureCoinListLoaded() {
    const now = Date.now();
    if (this.coinListLoadedAt > 0 && now - this.coinListLoadedAt < COINGECKO_COIN_LIST_REFRESH_INTERVAL_MS) {
      return;
    }
    if (this.coinListRefreshInFlight) {
      return this.coinListRefreshInFlight;
    }

    this.coinListRefreshInFlight = (async () => {
      const headers = this.buildCoinGeckoHeaders();
      const items = await this.coingeckoClient.request<CoinGeckoCoinListItem[]>('/coins/list', {
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
    })()
      .finally(() => {
        this.coinListRefreshInFlight = null;
      });

    return this.coinListRefreshInFlight;
  }

  private async fetchCoinMarketsByIds(ids: string[]) {
    const chunks = chunk(ids, COINGECKO_MARKETS_BATCH_LIMIT);
    const headers = this.buildCoinGeckoHeaders();
    const results: CoinGeckoCoinMarketsItem[] = [];

    for (const idChunk of chunks) {
      const response = await this.coingeckoClient.request<CoinGeckoCoinMarketsItem[]>('/coins/markets', {
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
    }

    return results;
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
