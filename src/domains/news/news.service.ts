export type NewsItem = {
  id: string;
  title: string;
  summary: string | null;
  body: string | null;
  source: string | null;
  publishedAt: string;
  symbols: string[];
  category: string | null;
  thumbnailUrl: string | null;
  isImportant: boolean;
  tags: string[];
  url: string | null;
};

const newsItems: NewsItem[] = [
  {
    id: 'btc-market-overview-2026-04-30',
    title: 'Bitcoin market data shows steady liquidity across major venues',
    summary: 'Bitcoin price and volume data remained active across major spot venues, with investors watching macro data and ETF flows.',
    body: 'Bitcoin market data remained active across major spot venues. Price movement, volume, and volatility continue to be useful reference data for users comparing assets and reviewing portfolio exposure.',
    source: 'Cryptory Research',
    publishedAt: '2026-04-30T00:00:00.000Z',
    symbols: ['BTC'],
    category: 'market',
    thumbnailUrl: null,
    isImportant: true,
    tags: ['market', 'bitcoin'],
    url: 'https://cryptory.example/news/btc-market-overview-2026-04-30',
  },
  {
    id: 'eth-network-update-2026-04-30',
    title: 'Ethereum network metrics remain in focus for market watchers',
    summary: 'Ethereum users continued to track network activity, fees, and ecosystem updates as reference information for asset analysis.',
    body: 'Ethereum network activity, fee conditions, and ecosystem updates remain important reference signals for users who follow asset fundamentals and portfolio allocation.',
    source: 'Cryptory Research',
    publishedAt: '2026-04-30T01:00:00.000Z',
    symbols: ['ETH'],
    category: 'network',
    thumbnailUrl: null,
    isImportant: false,
    tags: ['market', 'ethereum'],
    url: 'https://cryptory.example/news/eth-network-update-2026-04-30',
  },
  {
    id: 'kimchi-premium-reference-2026-04-30',
    title: 'Domestic and global price difference narrows for selected assets',
    summary: 'Reference market data showed a narrower domestic and global price difference for selected assets during the latest observation window.',
    body: 'Domestic and global price difference data is provided as reference market data only. Users can compare exchange prices, currency assumptions, and observation times.',
    source: 'Cryptory Research',
    publishedAt: '2026-04-30T02:00:00.000Z',
    symbols: ['BTC', 'ETH'],
    category: 'kimchi-premium',
    thumbnailUrl: null,
    isImportant: false,
    tags: ['market', 'kimchi-premium'],
    url: 'https://cryptory.example/news/kimchi-premium-reference-2026-04-30',
  },
];

export const NEWS_CATEGORIES = ['market', 'network', 'kimchi-premium'] as const;

export function normalizeNewsSymbol(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

export function parseNewsLimit(value?: number) {
  if (value === undefined) {
    return 20;
  }
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), 100) : null;
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

  const filtered = newsItems.filter((item) => {
    if (coin && !item.symbols.includes(coin)) {
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
  return {
    items: items.map(({ body: _body, tags, ...item }) => ({
      ...item,
      relatedSymbols: item.symbols,
      relatedCoins: item.symbols,
      tags,
    })),
    nextCursor: next?.id ?? null,
  };
}

export function getNewsById(newsId: string) {
  const item = newsItems.find((candidate) => candidate.id === newsId);
  if (!item) {
    return null;
  }

  return {
    ...item,
    relatedSymbols: item.symbols,
    relatedCoins: item.symbols,
  };
}
