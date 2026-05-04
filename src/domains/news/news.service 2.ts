import { normalizeCoinSymbol } from '../coins/coin-symbol';

export type NewsItem = {
  id: string;
  scope?: 'market' | 'coin';
  title: string;
  titleKo: string | null;
  summary: string | null;
  summaryKo: string | null;
  body: string | null;
  source: string | null;
  publishedAt: string;
  symbols: string[];
  category: string | null;
  thumbnailUrl: string | null;
  isImportant: boolean;
  tags: string[];
  url: string | null;
  language?: string;
  translated?: boolean;
  translationProvider?: string;
};

const newsItems: NewsItem[] = [
  {
    id: 'btc-market-overview-2026-04-30',
    title: 'Bitcoin market data shows steady liquidity across major venues',
    titleKo: '비트코인 시장 데이터, 주요 거래소에서 안정적인 유동성 보여',
    summary: 'Bitcoin price and volume data remained active across major spot venues, with investors watching macro data and ETF flows.',
    summaryKo: '비트코인 가격과 거래량 데이터는 주요 현물 거래소에서 활발하게 유지됐으며, 투자자들은 거시 지표와 ETF 흐름을 함께 주시했습니다.',
    body: 'Bitcoin market data remained active across major spot venues. Price movement, volume, and volatility continue to be useful reference data for users comparing assets and reviewing portfolio exposure.',
    source: 'Cryptory Research',
    publishedAt: '2026-04-30T00:00:00.000Z',
    symbols: ['BTC'],
    category: 'market',
    thumbnailUrl: null,
    isImportant: true,
    tags: ['market', 'bitcoin', 'BTC'],
    url: 'https://cryptory.example/news/btc-market-overview-2026-04-30',
    language: 'en',
    translated: true,
    translationProvider: 'server',
  },
  {
    id: 'eth-network-update-2026-04-30',
    title: 'Ethereum network metrics remain in focus for market watchers',
    titleKo: '이더리움 네트워크 지표, 시장 참여자들의 관심 지속',
    summary: 'Ethereum users continued to track network activity, fees, and ecosystem updates as reference information for asset analysis.',
    summaryKo: '이더리움 이용자들은 자산 분석 참고 정보로 네트워크 활동, 수수료, 생태계 업데이트를 계속 확인했습니다.',
    body: 'Ethereum network activity, fee conditions, and ecosystem updates remain important reference signals for users who follow asset fundamentals and portfolio allocation.',
    source: 'Cryptory Research',
    publishedAt: '2026-04-30T01:00:00.000Z',
    symbols: ['ETH'],
    category: 'network',
    thumbnailUrl: null,
    isImportant: false,
    tags: ['market', 'ethereum', 'ETH'],
    url: 'https://cryptory.example/news/eth-network-update-2026-04-30',
    language: 'en',
    translated: true,
    translationProvider: 'server',
  },
  {
    id: 'kimchi-premium-reference-2026-04-30',
    title: 'Domestic and global price difference narrows for selected assets',
    titleKo: '일부 자산의 국내외 가격 차이 축소',
    summary: 'Reference market data showed a narrower domestic and global price difference for selected assets during the latest observation window.',
    summaryKo: '최근 관측 구간에서 일부 자산의 국내외 가격 차이가 축소된 것으로 참고 시장 데이터에 나타났습니다.',
    body: 'Domestic and global price difference data is provided as reference market data only. Users can compare exchange prices, currency assumptions, and observation times.',
    source: 'Cryptory Research',
    publishedAt: '2026-04-30T02:00:00.000Z',
    symbols: ['BTC', 'ETH'],
    category: 'kimchi-premium',
    thumbnailUrl: null,
    isImportant: false,
    tags: ['market', 'kimchi-premium', 'BTC', 'ETH'],
    url: 'https://cryptory.example/news/kimchi-premium-reference-2026-04-30',
    language: 'en',
    translated: true,
    translationProvider: 'server',
  },
];

export const NEWS_CATEGORIES = ['market', 'network', 'kimchi-premium'] as const;

export function normalizeNewsSymbol(value: string) {
  return normalizeCoinSymbol(value);
}

export function parseNewsLimit(value?: number) {
  if (value === undefined) {
    return 20;
  }
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), 100) : null;
}

function normalizeSymbolSet(values: string[]) {
  return values
    .map((value) => normalizeNewsSymbol(value))
    .filter(Boolean);
}

function textMentionsSymbol(item: NewsItem, symbol: string) {
  const keyword = symbol.toUpperCase();
  return [item.title, item.summary ?? '', item.body ?? '']
    .some((value) => new RegExp(`(^|[^A-Z0-9])${keyword}([^A-Z0-9]|$)`, 'i').test(value));
}

function matchesNewsSymbol(item: NewsItem, symbol: string) {
  if (!symbol) {
    return true;
  }
  if (normalizeSymbolSet(item.symbols).includes(symbol)) {
    return true;
  }
  if (normalizeSymbolSet(item.tags).includes(symbol)) {
    return true;
  }
  return textMentionsSymbol(item, symbol);
}

function projectNewsItem(item: NewsItem, scope: 'market' | 'coin') {
  const source = item.source?.trim() || 'Cryptory Research';
  return {
    id: String(item.id),
    scope,
    symbols: normalizeSymbolSet(item.symbols),
    title: item.title,
    titleKo: item.titleKo ?? null,
    summary: item.summary ?? null,
    summaryKo: item.summaryKo ?? null,
    source,
    publishedAt: new Date(item.publishedAt).toISOString(),
    url: item.url ?? null,
    tags: item.tags,
    language: item.language ?? 'en',
    translated: Boolean(item.translated && (item.titleKo || item.summaryKo)),
    translationProvider: item.translated ? item.translationProvider ?? 'server' : 'unavailable',
    category: item.category,
    thumbnailUrl: item.thumbnailUrl,
    isImportant: item.isImportant,
    relatedSymbols: normalizeSymbolSet(item.symbols),
    relatedCoins: normalizeSymbolSet(item.symbols),
  };
}

export function listNews(params: {
  coin?: string;
  symbol?: string;
  category?: string;
  date?: string;
  cursor?: string;
  limit?: number;
}) {
  const limit = parseNewsLimit(params.limit) ?? 20;
  const cursorIndex = params.cursor
    ? newsItems.findIndex((item) => item.id === params.cursor) + 1
    : 0;
  const offset = Math.max(cursorIndex, 0);
  const coin = (params.symbol ?? params.coin) ? normalizeNewsSymbol((params.symbol ?? params.coin) as string) : '';
  const category = params.category?.trim().toLowerCase();
  const date = params.date?.trim();
  const scope = coin ? 'coin' as const : 'market' as const;

  const filtered = newsItems.filter((item) => {
    if (coin && !matchesNewsSymbol(item, coin)) {
      return false;
    }
    if (category && item.category !== category && !item.tags.includes(category)) {
      return false;
    }
    if (date && !item.publishedAt.startsWith(date)) {
      return false;
    }
    return true;
  });

  const items = filtered.slice(offset, offset + limit);
  const next = filtered[offset + limit];
  const projectedItems = items.map((item) => projectNewsItem(item, scope));
  const emptyReason = projectedItems.length === 0
    ? coin
      ? 'NO_RELATED_NEWS'
      : 'NO_MARKET_NEWS'
    : null;
  return {
    scope,
    ...(coin ? { symbol: coin } : {}),
    items: projectedItems,
    pagination: {
      nextCursor: next?.id ?? null,
      hasMore: Boolean(next),
    },
    emptyState: {
      isEmpty: projectedItems.length === 0,
      reason: emptyReason,
    },
    updatedAt: new Date().toISOString(),
    nextCursor: next?.id ?? null,
  };
}

export function getNewsById(newsId: string) {
  const item = newsItems.find((candidate) => candidate.id === newsId);
  if (!item) {
    return null;
  }

  return {
    ...projectNewsItem(item, 'market'),
  };
}
