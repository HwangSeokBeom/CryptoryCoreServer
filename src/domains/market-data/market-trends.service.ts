import { env } from '../../config/env';
import { prisma } from '../../config/database';
import { RestClient } from '../../core/exchange/rest.client';
import { listNews } from '../news/news.service';
import { getMarketPoll, getMarketSentiment } from '../coins/coin-community.service';
import { logger } from '../../utils/logger';

type CoinGeckoGlobalResponse = {
  data?: {
    total_market_cap?: Record<string, unknown>;
    total_volume?: Record<string, unknown>;
    market_cap_percentage?: Record<string, unknown>;
    market_cap_change_percentage_24h_usd?: unknown;
  };
};

type FearGreedResponse = {
  data?: Array<{
    value?: string | number | null;
    value_classification?: string | null;
  }>;
};

export const FEAR_GREED_THRESHOLDS = [
  { min: 0, max: 24, label: 'extreme_fear', labelKo: '극단적 공포' },
  { min: 25, max: 44, label: 'fear', labelKo: '공포' },
  { min: 45, max: 55, label: 'neutral', labelKo: '중립' },
  { min: 56, max: 75, label: 'greed', labelKo: '탐욕' },
  { min: 76, max: 100, label: 'extreme_greed', labelKo: '극단적 탐욕' },
] as const;

type MarketSnapshotPoint = {
  timestamp: string;
  totalMarketCap: number | null;
  totalVolume: number | null;
  btcDominance: number | null;
  ethDominance: number | null;
  fearGreedIndex: number | null;
};

type MarketProviderSnapshot = MarketSnapshotPoint & {
  source: 'coingecko' | 'market_snapshot';
  currency: string;
  fallbackUsed: boolean;
  globalAvailable: boolean;
  fearGreedAvailable: boolean;
};

const marketSnapshotsByCurrency = new Map<string, MarketSnapshotPoint[]>();
const marketHistoryByCurrency = new Map<string, Array<MarketSnapshotPoint & { source: string }>>();
let snapshotCollectorStarted = false;
let snapshotCollectorTimer: NodeJS.Timeout | null = null;

export type MarketTrendsResponse = {
  summary: {
    totalMarketCap: number | null;
    volume24h: number | null;
    btcDominance: number | null;
    ethDominance: number | null;
    fearGreedIndex: number | null;
    altcoinIndex: number | null;
    marketMoodLabel: string | null;
    marketMoodDescription: string | null;
  };
  movers: {
    topGainers: unknown[];
    topLosers: unknown[];
    topVolume: unknown[];
  };
  series: {
    marketCap: Array<{ timestamp: string; value: number | null }>;
    volume: Array<{ timestamp: string; value: number | null }>;
  };
  latestHeadline: {
    title: string;
    publishedAt: string;
    source: string | null;
  } | null;
  insights: Array<{
    title: string;
    body: string;
    category: string;
    symbols: string[];
    severity: 'info';
  }>;
  events: Array<{
    title: string;
    body: string;
    occurredAt: string;
    asOf: string;
    symbols: string[];
    source: string | null;
  }>;
  dataQuality: {
    summaryAvailable: boolean;
    moversAvailable: boolean;
    seriesAvailable: boolean;
    fallbackUsed: boolean;
    asOf: string;
  };
  marketPoll: {
    bullishCount: number;
    bearishCount: number;
    participantCount: number;
    myVote: 'bullish' | 'bearish' | null;
  };
  source: {
    primary: 'coingecko' | 'market_snapshot';
    fallbackUsed: boolean;
  };
  asOf: string;
};

const coingeckoClient = new RestClient('coingecko', env.COINGECKO_API_BASE_URL ?? 'https://api.coingecko.com/api/v3');
const fearGreedClient = new RestClient('coingecko', 'https://api.alternative.me');

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readUsd(record?: Record<string, unknown>) {
  return record ? toFiniteNumber(record.usd) : null;
}

function readCurrency(record: Record<string, unknown> | undefined, currency: string) {
  if (!record) {
    return null;
  }
  const normalizedCurrency = currency.trim().toLowerCase();
  const direct = toFiniteNumber(record[normalizedCurrency]);
  if (direct !== null) {
    return direct;
  }
  const usd = toFiniteNumber(record.usd);
  if (usd !== null && normalizedCurrency === 'krw') {
    return usd * env.USD_KRW_FALLBACK;
  }
  return usd;
}

export function getFearGreedMood(value: number | null) {
  if (value === null) {
    return null;
  }
  const clamped = Math.max(0, Math.min(100, value));
  return FEAR_GREED_THRESHOLDS.find((threshold) => clamped >= threshold.min && clamped <= threshold.max) ?? FEAR_GREED_THRESHOLDS[2];
}

function formatKrwAmount(value: number | null) {
  if (value === null) {
    return null;
  }
  const prefix = 'KRW ';
  if (Math.abs(value) >= 1_0000_0000_0000) {
    return `${prefix}${Math.round((value / 1_0000_0000_0000) * 100) / 100}조`;
  }
  if (Math.abs(value) >= 1_0000_0000) {
    return `${prefix}${Math.round((value / 1_0000_0000) * 100) / 100}억`;
  }
  return `${prefix}${new Intl.NumberFormat('ko-KR').format(Math.round(value))}`;
}

function snapshotRangeStart(range: string, nowMs = Date.now()) {
  const normalized = range.trim().toLowerCase();
  const days = normalized === '30d' ? 30 : 7;
  return nowMs - days * 24 * 60 * 60 * 1000;
}

function rememberSnapshot(snapshot: MarketProviderSnapshot) {
  const currency = snapshot.currency.toUpperCase();
  if (
    snapshot.totalMarketCap === null
    && snapshot.totalVolume === null
    && snapshot.btcDominance === null
    && snapshot.ethDominance === null
    && snapshot.fearGreedIndex === null
  ) {
    return;
  }

  const existing = marketSnapshotsByCurrency.get(currency) ?? [];
  const deduped = existing.filter((point) => point.timestamp !== snapshot.timestamp);
  deduped.push({
    timestamp: snapshot.timestamp,
    totalMarketCap: snapshot.totalMarketCap,
    totalVolume: snapshot.totalVolume,
    btcDominance: snapshot.btcDominance,
    ethDominance: snapshot.ethDominance,
    fearGreedIndex: snapshot.fearGreedIndex,
  });
  deduped.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  marketSnapshotsByCurrency.set(currency, deduped.slice(-500));
  logger.info(
    { domain: 'market-trend-snapshot', currency, source: snapshot.source, timestamp: snapshot.timestamp, status: 'saved', count: deduped.length, latestTimestamp: snapshot.timestamp },
    `[MarketTrendSnapshot] saved=true count=${deduped.length} latestTimestamp=${snapshot.timestamp}`,
  );
  void upsertGlobalMarketHistory({
    date: dateOnly(snapshot.timestamp),
    currency,
    marketCap: snapshot.totalMarketCap,
    volume24h: snapshot.totalVolume,
    btcDominance: snapshot.btcDominance,
    ethDominance: snapshot.ethDominance,
    source: snapshot.source,
    timestamp: snapshot.timestamp,
  });
}

function shouldSkipPersistentMarketHistory() {
  return process.env.NODE_ENV === 'test';
}

async function hasGlobalMarketHistoryTable() {
  if (shouldSkipPersistentMarketHistory()) {
    return true;
  }
  try {
    const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass('public.global_market_history') IS NOT NULL AS exists
    `;
    return rows[0]?.exists === true;
  } catch (error) {
    logger.warn(
      { domain: 'market-trend-snapshot', table: 'global_market_history', err: error },
      '[MarketTrendSnapshot] skipped reason=missing_table table=global_market_history',
    );
    return false;
  }
}

function shouldSuppressMarketHistoryError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /does not exist|denied access|authentication failed|connect ECONNREFUSED/i.test(message);
}

function rememberHistoryPoint(point: MarketSnapshotPoint & { source: string }, currency: string) {
  const normalizedCurrency = currency.toUpperCase();
  const existing = marketHistoryByCurrency.get(normalizedCurrency) ?? [];
  const date = dateOnly(point.timestamp);
  const deduped = existing.filter((candidate) => dateOnly(candidate.timestamp) !== date || candidate.source !== point.source);
  deduped.push(point);
  deduped.sort((left, right) => dateOnly(left.timestamp).localeCompare(dateOnly(right.timestamp)));
  marketHistoryByCurrency.set(normalizedCurrency, deduped.slice(-500));
}

async function upsertGlobalMarketHistory(params: {
  date: string;
  currency: string;
  marketCap: number | null;
  volume24h: number | null;
  btcDominance: number | null;
  ethDominance: number | null;
  source: string;
  timestamp?: string;
}) {
  if (
    params.marketCap === null
    && params.volume24h === null
    && params.btcDominance === null
    && params.ethDominance === null
  ) {
    return;
  }
  const timestamp = params.timestamp ?? `${params.date}T00:00:00.000Z`;
  rememberHistoryPoint({
    timestamp,
    totalMarketCap: params.marketCap,
    totalVolume: params.volume24h,
    btcDominance: params.btcDominance,
    ethDominance: params.ethDominance,
    fearGreedIndex: null,
    source: params.source,
  }, params.currency);

  if (shouldSkipPersistentMarketHistory()) {
    return;
  }

  try {
    await prisma.$executeRaw`
      INSERT INTO global_market_history (
        id,
        date,
        currency,
        market_cap,
        volume_24h,
        btc_dominance,
        eth_dominance,
        source,
        created_at,
        updated_at
      )
      VALUES (
        md5(${`${params.date}:${params.currency.toUpperCase()}:${params.source}`}),
        ${params.date}::date,
        ${params.currency.toUpperCase()},
        ${params.marketCap},
        ${params.volume24h},
        ${params.btcDominance},
        ${params.ethDominance},
        ${params.source},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (date, currency, source)
      DO UPDATE SET
        market_cap = EXCLUDED.market_cap,
        volume_24h = EXCLUDED.volume_24h,
        btc_dominance = EXCLUDED.btc_dominance,
        eth_dominance = EXCLUDED.eth_dominance,
        updated_at = CURRENT_TIMESTAMP
    `;
  } catch (error) {
    if (!shouldSuppressMarketHistoryError(error)) {
      logger.warn({ domain: 'market-data-history', action: 'upsert_failed', err: error }, '[MarketHistory] upsert failed');
    }
  }
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

async function fetchGlobalMarketData() {
  try {
    const response = await coingeckoClient.request<CoinGeckoGlobalResponse>('/global', {
      headers: buildCoinGeckoHeaders(),
      timeoutMs: 2500,
      retryPolicy: { maxAttempts: 1 },
    });
    const global = response.data;
    logger.info(
      {
        domain: 'market-data',
        provider: 'coingecko',
        status: 'success',
        hasMarketCap: Boolean(global?.total_market_cap),
        hasVolume: Boolean(global?.total_volume),
        hasBtcDominance: toFiniteNumber(global?.market_cap_percentage?.btc) !== null,
        hasEthDominance: toFiniteNumber(global?.market_cap_percentage?.eth) !== null,
      },
      `[MarketDataProvider] coingecko status=success hasMarketCap=${Boolean(global?.total_market_cap)} hasVolume=${Boolean(global?.total_volume)} hasBtcDominance=${toFiniteNumber(global?.market_cap_percentage?.btc) !== null} hasEthDominance=${toFiniteNumber(global?.market_cap_percentage?.eth) !== null}`,
    );
    return response;
  } catch (error) {
    logger.warn(
      {
        domain: 'market-data',
        provider: 'coingecko',
        status: 'failed',
        hasMarketCap: false,
        hasVolume: false,
        hasBtcDominance: false,
        hasEthDominance: false,
        err: error,
      },
      '[MarketDataProvider] coingecko status=failed hasMarketCap=false hasVolume=false hasBtcDominance=false hasEthDominance=false',
    );
    logger.warn({ domain: 'market-trends', err: error }, 'Global market data lookup failed');
    return null;
  }
}

async function fetchFearGreedIndex() {
  try {
    const response = await fearGreedClient.request<FearGreedResponse>('/fng/', {
      query: { limit: 1, format: 'json' },
      timeoutMs: 2000,
      retryPolicy: { maxAttempts: 1 },
    });
    const latest = response.data?.[0];
    if (!latest) {
      logger.warn(
        { domain: 'market-data', provider: 'alternative.me', status: 'empty', score: null, label: null },
        '[FearGreedProvider] status=empty score= label=',
      );
      return null;
    }
    const score = toFiniteNumber(latest.value);
    const mood = getFearGreedMood(score);
    logger.info(
      { domain: 'market-data', provider: 'alternative.me', status: score !== null ? 'success' : 'empty', score, label: mood?.label ?? null },
      `[FearGreedProvider] status=${score !== null ? 'success' : 'empty'} score=${score ?? ''} label=${mood?.label ?? ''}`,
    );
    return score;
  } catch (error) {
    logger.warn(
      { domain: 'market-data', provider: 'alternative.me', status: 'failed', score: null, label: null, err: error },
      '[FearGreedProvider] status=failed score= label=',
    );
    logger.warn({ domain: 'market-trends', err: error }, 'Fear and greed index lookup failed');
    return null;
  }
}

async function getCurrentProviderSnapshot(currency = 'KRW'): Promise<MarketProviderSnapshot> {
  const updatedAt = new Date().toISOString();
  const [globalData, fearGreedIndex] = await Promise.all([
    fetchGlobalMarketData(),
    fetchFearGreedIndex(),
  ]);
  const global = globalData?.data;
  const snapshot: MarketProviderSnapshot = {
    timestamp: updatedAt,
    currency: currency.toUpperCase(),
    source: globalData ? 'coingecko' : 'market_snapshot',
    fallbackUsed: !globalData,
    globalAvailable: Boolean(globalData),
    fearGreedAvailable: fearGreedIndex !== null,
    totalMarketCap: readCurrency(global?.total_market_cap, currency),
    totalVolume: readCurrency(global?.total_volume, currency),
    btcDominance: toFiniteNumber(global?.market_cap_percentage?.btc),
    ethDominance: toFiniteNumber(global?.market_cap_percentage?.eth),
    fearGreedIndex,
  };
  rememberSnapshot(snapshot);
  return snapshot;
}

export function startMarketSnapshotCollector() {
  if (snapshotCollectorStarted) {
    return;
  }
  if (!env.MARKET_TREND_SNAPSHOT_ENABLED) {
    logger.info(
      { domain: 'startup-jobs', job: 'marketTrendSnapshot', reason: 'disabled_by_env' },
      '[StartupJobs] skipped job=marketTrendSnapshot reason=disabled_by_env',
    );
    return;
  }
  snapshotCollectorStarted = true;

  void hasGlobalMarketHistoryTable().then((tableExists) => {
    if (!snapshotCollectorStarted) {
      return;
    }
    if (!tableExists) {
      snapshotCollectorStarted = false;
      logger.warn(
        { domain: 'market-trend-snapshot', table: 'global_market_history' },
        '[MarketTrendSnapshot] skipped reason=missing_table table=global_market_history',
      );
      return;
    }

    void getCurrentProviderSnapshot('KRW');
    snapshotCollectorTimer = setInterval(() => {
      void getCurrentProviderSnapshot('KRW');
    }, 60 * 60 * 1000);
    snapshotCollectorTimer.unref?.();
  });
}

export function stopMarketSnapshotCollectorForTest() {
  snapshotCollectorStarted = false;
  if (snapshotCollectorTimer) {
    clearInterval(snapshotCollectorTimer);
    snapshotCollectorTimer = null;
  }
}

async function getLatestHeadline() {
  const news = await listNews({ limit: 1 });
  const item = news.items[0];
  return item
    ? {
        title: item.title,
        publishedAt: item.publishedAt,
        source: item.source,
      }
    : null;
}

function describeMarketMood(fearGreedIndex: number | null) {
  if (fearGreedIndex === null) {
    return {
      marketMoodLabel: null,
      marketMoodDescription: null,
    };
  }

  if (fearGreedIndex <= 24) {
    return {
      marketMoodLabel: 'Extreme fear',
      marketMoodDescription: 'Sentiment data shows elevated caution across the broader crypto market.',
    };
  }
  if (fearGreedIndex <= 44) {
    return {
      marketMoodLabel: 'Fear',
      marketMoodDescription: 'Sentiment data leans cautious for the latest observation window.',
    };
  }
  if (fearGreedIndex <= 55) {
    return {
      marketMoodLabel: 'Neutral',
      marketMoodDescription: 'Sentiment data is near the neutral range for the latest observation window.',
    };
  }
  if (fearGreedIndex <= 75) {
    return {
      marketMoodLabel: 'Greed',
      marketMoodDescription: 'Sentiment data shows stronger risk appetite in the broader crypto market.',
    };
  }
  return {
    marketMoodLabel: 'Extreme greed',
    marketMoodDescription: 'Sentiment data shows high risk appetite in the broader crypto market.',
  };
}

function metricValue(params: {
  value: number | null;
  currency?: string;
  source?: string | null;
  updatedAt?: string;
  unit?: string;
  reason?: string;
}) {
  const available = params.value !== null;
  return {
    value: params.value,
    ...(params.currency ? { formatted: formatKrwAmount(params.value), currency: params.currency } : {}),
    ...(params.unit ? { unit: params.unit } : {}),
    source: params.source ?? null,
    ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
    available,
    reason: available ? null : params.reason ?? 'METRIC_UNAVAILABLE',
  };
}

function latestStoredSnapshot(currency: string) {
  const points = marketSnapshotsByCurrency.get(currency.toUpperCase()) ?? [];
  return points.at(-1) ?? null;
}

function hasAnySnapshotMetric(snapshot: MarketSnapshotPoint) {
  return snapshot.totalMarketCap !== null
    || snapshot.totalVolume !== null
    || snapshot.btcDominance !== null
    || snapshot.ethDominance !== null
    || snapshot.fearGreedIndex !== null;
}

export async function getMarketDashboard(params: { currency?: string } = {}) {
  const currency = (params.currency ?? 'KRW').trim().toUpperCase() || 'KRW';
  const providerSnapshot = await getCurrentProviderSnapshot(currency);
  const staleSnapshot = latestStoredSnapshot(currency);
  const useStaleSnapshot = providerSnapshot.fallbackUsed
    && !providerSnapshot.globalAvailable
    && staleSnapshot
    && hasAnySnapshotMetric(staleSnapshot);
  const snapshot: MarketProviderSnapshot = useStaleSnapshot
    ? {
        ...staleSnapshot,
        currency,
        source: 'market_snapshot',
        fallbackUsed: true,
        globalAvailable: false,
        fearGreedAvailable: providerSnapshot.fearGreedAvailable,
        fearGreedIndex: providerSnapshot.fearGreedIndex ?? staleSnapshot.fearGreedIndex,
      }
    : providerSnapshot;
  const mood = getFearGreedMood(snapshot.fearGreedIndex);
  const updatedAt = snapshot.timestamp;
  const response = {
    scope: 'market',
    currency,
    source: snapshot.source,
    updatedAt,
    isStale: snapshot.fallbackUsed,
    btcDominance: snapshot.btcDominance,
    ethDominance: snapshot.ethDominance,
    fearGreedIndex: {
      value: snapshot.fearGreedIndex,
      label: mood?.label ?? null,
      labelKo: mood?.labelKo ?? null,
    },
    altcoinIndex: null,
    reason: snapshot.globalAvailable || snapshot.fearGreedAvailable ? null : 'provider_unavailable',
    metrics: {
      totalMarketCap: metricValue({
        value: snapshot.totalMarketCap,
        currency,
        source: snapshot.source,
        updatedAt,
        reason: 'GLOBAL_MARKET_CAP_UNAVAILABLE',
      }),
      totalVolume24h: metricValue({
        value: snapshot.totalVolume,
        currency,
        source: snapshot.source,
        updatedAt,
        reason: 'GLOBAL_VOLUME_UNAVAILABLE',
      }),
      btcDominance: metricValue({
        value: snapshot.btcDominance,
        unit: 'percent',
        source: snapshot.source,
        updatedAt,
        reason: 'BTC_DOMINANCE_UNAVAILABLE',
      }),
      ethDominance: metricValue({
        value: snapshot.ethDominance,
        unit: 'percent',
        source: snapshot.source,
        updatedAt,
        reason: 'ETH_DOMINANCE_UNAVAILABLE',
      }),
      fearGreedIndex: {
        value: snapshot.fearGreedIndex,
        unit: 'index',
        label: mood?.label ?? null,
        labelKo: mood?.labelKo ?? null,
        scale: { min: 0, max: 100 },
        thresholds: FEAR_GREED_THRESHOLDS,
        available: snapshot.fearGreedIndex !== null,
        reason: snapshot.fearGreedIndex === null ? 'FEAR_GREED_INDEX_UNAVAILABLE' : null,
        source: 'alternative.me',
        updatedAt,
      },
      altcoinIndex: {
        value: null,
        unit: 'index',
        label: null,
        labelKo: null,
        available: false,
        source: null,
        reason: 'ALTCOIN_INDEX_SOURCE_NOT_CONFIGURED',
      },
    },
    availability: {
      totalMarketCap: snapshot.totalMarketCap !== null,
      totalVolume24h: snapshot.totalVolume !== null,
      btcDominance: snapshot.btcDominance !== null,
      ethDominance: snapshot.ethDominance !== null,
      fearGreedIndex: snapshot.fearGreedIndex !== null,
      altcoinIndex: false,
    },
    unavailableReasons: {
      ...(snapshot.totalMarketCap === null ? { totalMarketCap: snapshot.globalAvailable ? 'GLOBAL_MARKET_CAP_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE' } : {}),
      ...(snapshot.totalVolume === null ? { totalVolume24h: snapshot.globalAvailable ? 'GLOBAL_VOLUME_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE' } : {}),
      ...(snapshot.btcDominance === null ? { btcDominance: snapshot.globalAvailable ? 'BTC_DOMINANCE_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE' } : {}),
      ...(snapshot.ethDominance === null ? { ethDominance: snapshot.globalAvailable ? 'ETH_DOMINANCE_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE' } : {}),
      ...(snapshot.fearGreedIndex === null ? { fearGreedIndex: 'FEAR_GREED_INDEX_UNAVAILABLE' } : {}),
      altcoinIndex: 'ALTCOIN_INDEX_SOURCE_NOT_CONFIGURED',
    },
    sourceStatus: {
      marketDataAvailable: snapshot.globalAvailable,
      fearGreedAvailable: snapshot.fearGreedAvailable,
      fallbackUsed: snapshot.fallbackUsed,
      staleCacheUsed: Boolean(useStaleSnapshot),
      reasons: [
        ...(!snapshot.globalAvailable ? ['COINGECKO_GLOBAL_UNAVAILABLE'] : []),
        ...(!snapshot.fearGreedAvailable ? ['FEAR_GREED_INDEX_UNAVAILABLE'] : []),
      ],
    },
  };

  const availableMetrics = Object.entries(response.availability)
    .filter(([, available]) => available)
    .map(([key]) => key);
  logger.info(
    {
      domain: 'market-data',
      endpoint: '/market/data',
      source: response.source,
      currency,
      updatedAt,
      isStale: response.isStale,
      availableMetrics,
      unavailableReasons: response.unavailableReasons,
    },
    `[MarketDataMap] availableMetrics=${availableMetrics.join(',')} unavailableReasons=${Object.keys(response.unavailableReasons).join(',')}`,
  );
  logger.info(
    { domain: 'market-data', currency, source: response.source, updatedAt, isStale: response.isStale },
    `[MarketDataResponse] currency=${currency} source=${response.source} updatedAt=${updatedAt} isStale=${response.isStale}`,
  );
  return response;
}

export async function getMarketTrendSeries(params: { range?: string; currency?: string } = {}) {
  const range = params.range === '30d' ? '30d' : '7d';
  const currency = (params.currency ?? 'KRW').trim().toUpperCase() || 'KRW';
  const current = await getCurrentProviderSnapshot(currency);
  const since = snapshotRangeStart(range);
  const allPoints = marketSnapshotsByCurrency.get(currency) ?? [];
  const providerPoints = allPoints
    .filter((point) => Date.parse(point.timestamp) >= since)
    .map((point) => ({
      timestamp: point.timestamp,
      totalMarketCap: point.totalMarketCap,
      totalVolume: point.totalVolume,
      btcDominance: point.btcDominance,
      ethDominance: point.ethDominance,
      fearGreedIndex: null,
    }));
  const points = providerPoints;
  const pointCount = points.length;
  const chartReady = pointCount >= 7;
  const renderHint = pointCount < 3
    ? 'limited_points'
    : pointCount < 7
      ? 'limited'
      : 'chart';
  const qualityLevel = pointCount >= 7 ? 'high' : pointCount >= 3 ? 'medium' : 'low';
  const qualityReason = pointCount >= 7 ? null : 'INSUFFICIENT_POINTS';
  const availability = {
    totalMarketCap: points.some((point) => point.totalMarketCap !== null),
    totalVolume: points.some((point) => point.totalVolume !== null),
    btcDominance: points.some((point) => point.btcDominance !== null),
    ethDominance: points.some((point) => point.ethDominance !== null),
    fearGreedIndex: points.some((point) => point.fearGreedIndex !== null),
  };
  const unavailableReasons: Record<string, string> = {};
  if (!availability.totalMarketCap) unavailableReasons.totalMarketCap = 'GLOBAL_MARKET_CAP_SERIES_UNAVAILABLE';
  if (!availability.totalVolume) unavailableReasons.totalVolume = 'GLOBAL_VOLUME_SERIES_UNAVAILABLE';
  if (!availability.btcDominance) unavailableReasons.btcDominance = 'BTC_DOMINANCE_SERIES_UNAVAILABLE';
  if (!availability.ethDominance) unavailableReasons.ethDominance = 'ETH_DOMINANCE_SERIES_UNAVAILABLE';
  unavailableReasons.fearGreedIndex = availability.fearGreedIndex
    ? 'HISTORICAL_FEAR_GREED_NOT_AVAILABLE'
    : 'HISTORICAL_FEAR_GREED_NOT_AVAILABLE';
  const emptyReason = points.length === 0
    ? 'MARKET_TREND_SNAPSHOT_NOT_READY'
    : pointCount < 7
      ? 'INSUFFICIENT_POINTS'
      : null;

  const response = {
    scope: 'market',
    range,
    currency,
    source: current.source,
    updatedAt: current.timestamp,
    pointCount,
    chartReady,
    renderHint,
    dataQuality: {
      level: qualityLevel,
      messageKo: pointCount >= 7
        ? '추이 차트를 표시할 수 있는 데이터가 준비되었습니다.'
        : '추이 차트를 표시하기에는 데이터가 아직 적습니다.',
      reason: qualityReason,
    },
    availability: {
      ...availability,
      fearGreedIndex: false,
    },
    unavailableReasons,
    points,
    emptyState: {
      isEmpty: points.length === 0,
      reason: emptyReason,
    },
  };
  logger.info(
    {
      domain: 'market-trend',
      range,
      currency,
      pointCount,
      chartReady,
      renderHint,
      emptyReason,
      unavailableReasons,
    },
    `[MarketTrendQuery] range=${range} currency=${currency} pointCount=${pointCount} chartReady=${chartReady} renderHint=${renderHint}`,
  );
  logger.info(
    { domain: 'market-trend', qualityLevel, reason: qualityReason },
    `[MarketTrendQuality] level=${qualityLevel} reason=${qualityReason ?? ''}`,
  );
  logger.info(
    { domain: 'market-trend', pointCount, availability: response.availability, emptyReason },
    `[MarketTrendResponse] pointCount=${pointCount} availability=${JSON.stringify(response.availability)} emptyReason=${emptyReason ?? ''}`,
  );
  return response;
}

function historyDays(range: string) {
  if (range === '7d') return 7;
  if (range === '90d') return 90;
  if (range === '1y') return 365;
  return 30;
}

function dateOnly(timestamp: string | number | Date) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function buildHistoryPoint(point: MarketSnapshotPoint) {
  return {
    date: dateOnly(point.timestamp),
    marketCap: point.totalMarketCap,
    volume24h: point.totalVolume,
    btcDominance: point.btcDominance,
    ethDominance: point.ethDominance,
  };
}

function requiredHistoryPoints(range: '7d' | '30d' | '90d' | '1y') {
  if (range === '7d') return 7;
  if (range === '30d') return 30;
  if (range === '90d') return 30;
  return 52;
}

function rangeStartDate(range: '7d' | '30d' | '90d' | '1y') {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - historyDays(range) + 1);
  return dateOnly(date);
}

function metricAvailability(points: ReturnType<typeof buildHistoryPoint>[]) {
  return {
    marketCap: points.some((point) => point.marketCap !== null),
    volume24h: points.some((point) => point.volume24h !== null),
    btcDominance: points.some((point) => point.btcDominance !== null),
    ethDominance: points.some((point) => point.ethDominance !== null),
  };
}

function flatMetricWarnings(points: ReturnType<typeof buildHistoryPoint>[]) {
  const warnings: string[] = [];
  for (const metric of ['marketCap', 'volume24h', 'btcDominance', 'ethDominance'] as const) {
    const uniqueValueCount = new Set(points.map((point) => point[metric]).filter((value) => value !== null)).size;
    if (points.length > 1 && uniqueValueCount === 1) {
      logger.warn(
        { domain: 'market-data-history', metric, uniqueValueCount },
        `[MarketHistory] flatData metric=${metric} uniqueValueCount=${uniqueValueCount}`,
      );
      warnings.push(`flat_${metric}`);
    }
  }
  return warnings;
}

async function readGlobalMarketHistory(params: {
  range: '7d' | '30d' | '90d' | '1y';
  currency: string;
}) {
  const startDate = rangeStartDate(params.range);
  const memory = (marketHistoryByCurrency.get(params.currency) ?? [])
    .filter((point) => dateOnly(point.timestamp) >= startDate)
    .sort((left, right) => dateOnly(left.timestamp).localeCompare(dateOnly(right.timestamp)));
  if (shouldSkipPersistentMarketHistory()) {
    return memory;
  }

  try {
    const rows = await prisma.$queryRaw<Array<{
      date: Date;
      market_cap: number | null;
      volume_24h: number | null;
      btc_dominance: number | null;
      eth_dominance: number | null;
      source: string;
      updated_at: Date;
    }>>`
      SELECT date, market_cap, volume_24h, btc_dominance, eth_dominance, source, updated_at
      FROM global_market_history
      WHERE currency = ${params.currency}
        AND date >= ${startDate}::date
      ORDER BY date ASC
    `;
    if (rows.length > 0) {
      return rows.map((row) => ({
        timestamp: row.date instanceof Date ? row.date.toISOString() : new Date(row.date).toISOString(),
        totalMarketCap: row.market_cap,
        totalVolume: row.volume_24h,
        btcDominance: row.btc_dominance,
        ethDominance: row.eth_dominance,
        fearGreedIndex: null,
        source: row.source,
      }));
    }
  } catch (error) {
    if (!shouldSuppressMarketHistoryError(error)) {
      logger.warn({ domain: 'market-data-history', action: 'read_failed', err: error }, '[MarketHistory] read failed');
    }
  }
  return memory;
}

export async function getGlobalMarketHistory(params: {
  range?: string;
  interval?: string;
  currency?: string;
} = {}) {
  const range = ['7d', '30d', '90d', '1y'].includes(params.range ?? '') ? params.range as '7d' | '30d' | '90d' | '1y' : '30d';
  const interval = params.interval === 'daily' ? 'daily' : 'daily';
  const currency = (params.currency ?? env.DEFAULT_MARKET_CURRENCY ?? 'KRW').trim().toUpperCase() || 'KRW';
  const required = requiredHistoryPoints(range);
  const beforeProvider = await readGlobalMarketHistory({ range, currency });
  let providerSnapshot: MarketProviderSnapshot | null = null;
  if (beforeProvider.length < required) {
    providerSnapshot = await getCurrentProviderSnapshot(currency);
  }
  const stored = providerSnapshot ? await readGlobalMarketHistory({ range, currency }) : beforeProvider;
  const points = stored.map(buildHistoryPoint);
  const normalizedPoints = [...new Map(points.map((point) => [point.date, point])).values()]
    .sort((left, right) => left.date.localeCompare(right.date));
  const warnings = flatMetricWarnings(normalizedPoints);
  const enoughPoints = normalizedPoints.length >= required;
  const returnedPoints = enoughPoints && warnings.length === 0 ? normalizedPoints : [];
  const availability = metricAvailability(returnedPoints);
  const reason = enoughPoints
    ? warnings.length > 0 ? 'insufficient_history' : null
    : 'insufficient_history';
  const source = returnedPoints.length > 0
    ? beforeProvider.length >= required ? 'cache' : providerSnapshot?.source ?? 'cache'
    : 'none';
  const cacheHit = beforeProvider.length >= required;
  const updatedAt = providerSnapshot?.timestamp ?? new Date().toISOString();

  logger.info(
    {
      domain: 'market-data-history',
      range,
      interval,
      currency,
      dbPoints: beforeProvider.length,
      providerPoints: providerSnapshot ? 1 : 0,
      pointsCount: returnedPoints.length,
      cacheHit,
      reason,
    },
    `[MarketHistory] range=${range} interval=${interval} currency=${currency} dbPoints=${beforeProvider.length} providerPoints=${providerSnapshot ? 1 : 0} returned=${returnedPoints.length}`,
  );
  if (!enoughPoints) {
    logger.warn(
      { domain: 'market-data-history', range, required, actual: normalizedPoints.length },
      `[MarketHistory] insufficient range=${range} required=${required} actual=${normalizedPoints.length}`,
    );
  }

  return {
    range,
    interval,
    currency,
    points: returnedPoints,
    source,
    cacheHit,
    updatedAt,
    reason,
    insufficientPointCount: returnedPoints.length === 0 ? normalizedPoints.length : undefined,
    requiredPointCount: required,
    metricAvailability: availability,
    providerStatus: { coingecko: providerSnapshot ? providerSnapshot.globalAvailable ? 'ok' : 'error' : 'not_called' },
  };
}

export async function getNewsOverview(params: { userId?: string | null } = {}) {
  const market = await getMarketDashboard({ currency: 'KRW' });
  const fearGreed = market.metrics.fearGreedIndex;
  const moodLabel = fearGreed.label ?? 'neutral';
  const moodLabelKo = fearGreed.labelKo ?? '중립';
  const updatedAt = market.updatedAt;
  const news = await listNews({ limit: 3, digest: true });
  const topNews = news.items.slice(0, 3).map((item) => ({
    id: item.id,
    title: item.title,
    titleKo: item.titleKo,
    summary: item.summary,
    summaryKo: item.summaryKo,
    source: item.source,
    provider: item.provider,
    publishedAt: item.publishedAt,
    url: item.url,
    imageUrl: item.imageUrl,
    tags: item.tags,
    symbols: item.symbols,
  }));
  const newsSourceStatus = 'sourceStatus' in news ? news.sourceStatus : null;
  const volume = market.metrics.totalVolume24h;
  const btcDominance = market.metrics.btcDominance;
  const sourceReasons = [
    ...(!market.sourceStatus.marketDataAvailable ? ['MARKET_DATA_UNAVAILABLE'] : []),
    ...(!market.sourceStatus.fearGreedAvailable ? ['FEAR_GREED_UNAVAILABLE'] : []),
    ...(!newsSourceStatus?.externalAvailable && news.items.length === 0 ? ['NEWS_UNAVAILABLE'] : []),
  ];
  const response = {
    scope: 'market',
    updatedAt,
    source: `${market.source}+alternative.me+${newsSourceStatus?.providers?.[0] ?? 'news_provider'}`,
    sourceStatus: {
      marketDataAvailable: market.sourceStatus.marketDataAvailable,
      fearGreedAvailable: market.sourceStatus.fearGreedAvailable,
      newsAvailable: news.items.length > 0,
      fallbackUsed: market.sourceStatus.fallbackUsed || Boolean(newsSourceStatus?.fallbackUsed),
      reasons: sourceReasons,
      news: newsSourceStatus,
    },
    summary: {
      title: '오늘 시장 요약',
      headline: fearGreed.value === null
        ? '현재 시장 심리 데이터는 부분 제공 중입니다.'
        : `현재 시장 심리는 ${moodLabelKo} 구간입니다.`,
      headlineKo: fearGreed.value === null
        ? '현재 시장 심리 데이터는 부분 제공 중입니다.'
        : `현재 시장 심리는 ${moodLabelKo} 구간입니다.`,
      description: `BTC dominance is ${btcDominance.value ?? 'unavailable'}% and 24h volume is ${volume.formatted ?? 'unavailable'}.`,
      descriptionKo: `BTC 도미넌스는 ${btcDominance.value ?? '데이터 없음'}%, 24시간 거래량은 ${volume.formatted ?? '데이터 없음'}입니다.`,
      tone: moodLabel,
      available: fearGreed.value !== null || btcDominance.value !== null || volume.value !== null,
      reason: fearGreed.value !== null || btcDominance.value !== null || volume.value !== null ? null : 'MARKET_SUMMARY_NOT_AVAILABLE',
    },
    mood: {
      score: fearGreed.value,
      label: moodLabel,
      labelKo: moodLabelKo,
      scale: { min: 0, max: 100 },
      thresholds: FEAR_GREED_THRESHOLDS,
      source: 'alternative.me',
      available: fearGreed.value !== null,
      reason: fearGreed.value === null ? 'FEAR_GREED_INDEX_UNAVAILABLE' : null,
      updatedAt,
    },
    marketSentiment: getMarketSentiment({ userId: params.userId ?? null }),
    topNews,
  };
  logger.info(
    {
      domain: 'news-overview',
      marketDataAvailable: response.sourceStatus.marketDataAvailable,
      fearGreedAvailable: response.sourceStatus.fearGreedAvailable,
      newsAvailable: response.sourceStatus.newsAvailable,
      summaryAvailable: response.summary.available,
      topNewsCount: topNews.length,
      moodScore: response.mood.score,
      moodLabel: response.mood.label,
      source: response.source,
      fallbackUsed: response.sourceStatus.fallbackUsed,
      reasons: response.sourceStatus.reasons,
      updatedAt,
    },
    `[NewsOverviewBuild] marketDataAvailable=${response.sourceStatus.marketDataAvailable} fearGreedAvailable=${response.sourceStatus.fearGreedAvailable} newsAvailable=${response.sourceStatus.newsAvailable} topNewsCount=${topNews.length}`,
  );
  logger.info(
    { domain: 'news-overview', available: response.summary.available, tone: response.summary.tone, reason: response.summary.reason },
    `[NewsOverviewSummary] available=${response.summary.available} tone=${response.summary.tone} reason=${response.summary.reason ?? ''}`,
  );
  logger.info(
    { domain: 'news-overview', source: response.source, fallbackUsed: response.sourceStatus.fallbackUsed, reasons: response.sourceStatus.reasons },
    `[NewsOverviewResponse] source=${response.source} fallbackUsed=${response.sourceStatus.fallbackUsed} reasons=${response.sourceStatus.reasons.join(',')}`,
  );
  return response;
}

function buildInsights(params: {
  totalMarketCap: number | null;
  volume24h: number | null;
  btcDominance: number | null;
  ethDominance: number | null;
  fearGreedIndex: number | null;
}) {
  const insights: MarketTrendsResponse['insights'] = [];
  if (params.totalMarketCap !== null || params.volume24h !== null) {
    insights.push({
      title: 'Global market snapshot',
      body: 'Total market value and 24h volume are available for dashboard context.',
      category: 'market',
      symbols: [],
      severity: 'info',
    });
  }
  if (params.btcDominance !== null || params.ethDominance !== null) {
    insights.push({
      title: 'Dominance metrics updated',
      body: 'BTC and ETH dominance fields are available when the provider publishes them.',
      category: 'dominance',
      symbols: ['BTC', 'ETH'],
      severity: 'info',
    });
  }
  if (params.fearGreedIndex !== null) {
    insights.push({
      title: 'Sentiment index updated',
      body: 'The latest sentiment index is included as reference market context.',
      category: 'sentiment',
      symbols: [],
      severity: 'info',
    });
  }
  return insights;
}

async function buildEvents(asOf: string) {
  const news = await listNews({ limit: 3 });
  return news.items.map((item) => ({
    title: item.title,
    body: item.summary ?? 'Market reference item is available.',
    occurredAt: item.publishedAt,
    asOf,
    symbols: item.symbols ?? item.relatedSymbols ?? [],
    source: item.source,
  }));
}

export async function getMarketTrends(params: { userId?: string | null } = {}): Promise<MarketTrendsResponse> {
  const asOf = new Date().toISOString();
  const [globalData, fearGreedIndex] = await Promise.all([
    fetchGlobalMarketData(),
    fetchFearGreedIndex(),
  ]);
  const global = globalData?.data;
  const totalMarketCap = readUsd(global?.total_market_cap);
  const volume24h = readUsd(global?.total_volume);
  const btcDominance = toFiniteNumber(global?.market_cap_percentage?.btc);
  const ethDominance = toFiniteNumber(global?.market_cap_percentage?.eth);
  const marketMood = describeMarketMood(fearGreedIndex);
  const insights = buildInsights({
    totalMarketCap,
    volume24h,
    btcDominance,
    ethDominance,
    fearGreedIndex,
  });
  const events = await buildEvents(asOf);

  const response: MarketTrendsResponse = {
    summary: {
      totalMarketCap,
      volume24h,
      btcDominance,
      ethDominance,
      fearGreedIndex,
      altcoinIndex: null,
      ...marketMood,
    },
    movers: {
      topGainers: [],
      topLosers: [],
      topVolume: [],
    },
    series: {
      marketCap: [],
      volume: [],
    },
    latestHeadline: await getLatestHeadline(),
    insights,
    events,
    dataQuality: {
      summaryAvailable: totalMarketCap !== null || volume24h !== null || btcDominance !== null || ethDominance !== null || fearGreedIndex !== null,
      moversAvailable: false,
      seriesAvailable: false,
      fallbackUsed: !globalData,
      asOf,
    },
    marketPoll: getMarketPoll(params.userId ?? null),
    source: {
      primary: globalData ? 'coingecko' : 'market_snapshot',
      fallbackUsed: !globalData,
    },
    asOf,
  };
  logger.info(
    {
      domain: 'market-trends',
      summaryAvailable: response.dataQuality.summaryAvailable,
      moversCount: response.movers.topGainers.length + response.movers.topLosers.length + response.movers.topVolume.length,
      seriesCount: response.series.marketCap.length + response.series.volume.length,
      insightCount: response.insights.length,
      eventCount: response.events.length,
      fallbackUsed: response.source.fallbackUsed,
    },
    `[MarketTrends] summaryAvailable=${response.dataQuality.summaryAvailable} moversCount=${response.movers.topGainers.length + response.movers.topLosers.length + response.movers.topVolume.length} seriesCount=${response.series.marketCap.length + response.series.volume.length} insightCount=${response.insights.length} eventCount=${response.events.length} fallbackUsed=${response.source.fallbackUsed}`,
  );
  return response;
}
