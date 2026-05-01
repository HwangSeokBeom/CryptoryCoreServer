import { env } from '../../config/env';
import { RestClient } from '../../core/exchange/rest.client';
import { listNews } from '../news/news.service';
import { getMarketPoll } from '../coins/coin-community.service';
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

export type MarketTrendsResponse = {
  summary: {
    totalMarketCap: number | null;
    volume24h: number | null;
    btcDominance: number | null;
    ethDominance: number | null;
    fearGreedIndex: number | null;
    altcoinIndex: number | null;
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
    return await coingeckoClient.request<CoinGeckoGlobalResponse>('/global', {
      headers: buildCoinGeckoHeaders(),
      timeoutMs: 2500,
      retryPolicy: { maxAttempts: 1 },
    });
  } catch (error) {
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
      return null;
    }
    return toFiniteNumber(latest.value);
  } catch (error) {
    logger.warn({ domain: 'market-trends', err: error }, 'Fear and greed index lookup failed');
    return null;
  }
}

function getLatestHeadline() {
  const news = listNews({ limit: 1 });
  const item = news.items[0];
  return item
    ? {
        title: item.title,
        publishedAt: item.publishedAt,
        source: item.source,
      }
    : null;
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

  const response: MarketTrendsResponse = {
    summary: {
      totalMarketCap,
      volume24h,
      btcDominance: toFiniteNumber(global?.market_cap_percentage?.btc),
      ethDominance: toFiniteNumber(global?.market_cap_percentage?.eth),
      fearGreedIndex,
      altcoinIndex: null,
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
    latestHeadline: getLatestHeadline(),
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
      moversCount: response.movers.topGainers.length + response.movers.topLosers.length + response.movers.topVolume.length,
      seriesCount: response.series.marketCap.length + response.series.volume.length,
      fallbackUsed: response.source.fallbackUsed,
    },
    `[MarketTrends] moversCount=${response.movers.topGainers.length + response.movers.topLosers.length + response.movers.topVolume.length} seriesCount=${response.series.marketCap.length + response.series.volume.length} fallbackUsed=${response.source.fallbackUsed}`,
  );
  return response;
}
