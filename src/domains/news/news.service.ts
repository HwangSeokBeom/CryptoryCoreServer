export type NewsItem = {
  id: string;
  title: string;
  summary: string;
  body: string;
  source: string;
  publishedAt: string;
  relatedCoins: string[];
  tags: string[];
  originalUrl: string;
};

const newsItems: NewsItem[] = [
  {
    id: 'btc-market-overview-2026-04-30',
    title: 'Bitcoin market data shows steady liquidity across major venues',
    summary: 'Bitcoin price and volume data remained active across major spot venues, with investors watching macro data and ETF flows.',
    body: 'Bitcoin market data remained active across major spot venues. Price movement, volume, and volatility continue to be useful reference data for users comparing assets and reviewing portfolio exposure.',
    source: 'Cryptory Research',
    publishedAt: '2026-04-30T00:00:00.000Z',
    relatedCoins: ['BTC'],
    tags: ['market', 'bitcoin'],
    originalUrl: 'https://cryptory.example/news/btc-market-overview-2026-04-30',
  },
  {
    id: 'eth-network-update-2026-04-30',
    title: 'Ethereum network metrics remain in focus for market watchers',
    summary: 'Ethereum users continued to track network activity, fees, and ecosystem updates as reference information for asset analysis.',
    body: 'Ethereum network activity, fee conditions, and ecosystem updates remain important reference signals for users who follow asset fundamentals and portfolio allocation.',
    source: 'Cryptory Research',
    publishedAt: '2026-04-30T01:00:00.000Z',
    relatedCoins: ['ETH'],
    tags: ['market', 'ethereum'],
    originalUrl: 'https://cryptory.example/news/eth-network-update-2026-04-30',
  },
  {
    id: 'kimchi-premium-reference-2026-04-30',
    title: 'Domestic and global price difference narrows for selected assets',
    summary: 'Reference market data showed a narrower domestic and global price difference for selected assets during the latest observation window.',
    body: 'Domestic and global price difference data is provided as reference market data only and is not investment advice. Users can compare exchange prices, currency assumptions, and observation times.',
    source: 'Cryptory Research',
    publishedAt: '2026-04-30T02:00:00.000Z',
    relatedCoins: ['BTC', 'ETH'],
    tags: ['market', 'kimchi-premium'],
    originalUrl: 'https://cryptory.example/news/kimchi-premium-reference-2026-04-30',
  },
];

export function listNews(params: {
  coin?: string;
  category?: string;
  date?: string;
  cursor?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const cursorIndex = params.cursor
    ? newsItems.findIndex((item) => item.id === params.cursor) + 1
    : 0;
  const offset = Math.max(cursorIndex, 0);
  const coin = params.coin?.trim().toUpperCase();
  const category = params.category?.trim().toLowerCase();
  const date = params.date?.trim();

  const filtered = newsItems.filter((item) => {
    if (coin && !item.relatedCoins.includes(coin)) {
      return false;
    }
    if (category && !item.tags.includes(category)) {
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
    items: items.map(({ body, ...item }) => item),
    nextCursor: next?.id ?? null,
  };
}

export function getNewsById(newsId: string) {
  return newsItems.find((item) => item.id === newsId) ?? null;
}
