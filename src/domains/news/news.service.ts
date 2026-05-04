import { createHash } from 'crypto';
import { env } from '../../config/env';
import { prisma } from '../../config/database';
import { COIN_MAP } from '../../config/constants';
import { RestClient } from '../../core/exchange/rest.client';
import { logger } from '../../utils/logger';
import { isDatabaseSchemaMismatchError } from '../../utils/errors';
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
  provider?: string | null;
  publishedAt: string;
  symbols: string[];
  category: string | null;
  thumbnailUrl: string | null;
  imageUrl?: string | null;
  isImportant: boolean;
  tags: string[];
  url: string | null;
  language?: string;
  translated?: boolean;
  translationProvider?: string;
  tone?: 'positive' | 'neutral' | 'negative';
};

type CryptoPanicResponse = {
  results?: Array<{
    id?: number | string;
    title?: string | null;
    url?: string | null;
    published_at?: string | null;
    domain?: string | null;
    source?: { title?: string | null; domain?: string | null } | null;
    currencies?: Array<{ code?: string | null; title?: string | null }> | null;
    metadata?: { image?: string | null; description?: string | null } | null;
    kind?: string | null;
  }>;
};

type NewsProvider = 'cryptopanic' | 'cryptocurrency_cv' | 'newsapi';
type NewsProviderStatusCode = 'ok' | 'disabled' | 'error' | 'rate_limited' | 'empty';
type NewsSort = {
  orderBy: 'publishedAt' | 'createdAt' | 'relevanceScore';
  direction: 'asc' | 'desc';
};

type CryptocurrencyCvArticle = {
  id?: number | string;
  slug?: string | null;
  title?: string | null;
  headline?: string | null;
  summary?: string | null;
  description?: string | null;
  content?: string | null;
  url?: string | null;
  link?: string | null;
  source?: string | { name?: string | null; title?: string | null; domain?: string | null } | null;
  sourceName?: string | null;
  publisher?: string | null;
  publishedAt?: string | null;
  published_at?: string | null;
  published?: string | null;
  pubDate?: string | null;
  date?: string | null;
  createdAt?: string | null;
  imageUrl?: string | null;
  image?: string | null;
  thumbnail?: string | null;
  category?: string | null;
  tags?: string[] | string | null;
  symbols?: Array<string | { symbol?: string | null; code?: string | null; ticker?: string | null }> | string | null;
  tickers?: Array<string | { symbol?: string | null; code?: string | null; ticker?: string | null }> | string | null;
  coins?: Array<string | { symbol?: string | null; code?: string | null; ticker?: string | null }> | string | null;
  currencies?: Array<string | { symbol?: string | null; code?: string | null; ticker?: string | null }> | string | null;
};

type CryptocurrencyCvResponse =
  | CryptocurrencyCvArticle[]
  | {
      articles?: CryptocurrencyCvArticle[];
      results?: CryptocurrencyCvArticle[];
      items?: CryptocurrencyCvArticle[];
      news?: CryptocurrencyCvArticle[];
      data?: CryptocurrencyCvArticle[] | {
        articles?: CryptocurrencyCvArticle[];
        results?: CryptocurrencyCvArticle[];
        items?: CryptocurrencyCvArticle[];
        news?: CryptocurrencyCvArticle[];
      };
    };

type NewsApiResponse = {
  articles?: Array<{
    source?: { name?: string | null } | null;
    title?: string | null;
    description?: string | null;
    content?: string | null;
    url?: string | null;
    urlToImage?: string | null;
    publishedAt?: string | null;
  }>;
};

type NewsSourceStatus = {
  externalConfigured: boolean;
  externalAvailable: boolean;
  providers: string[];
  fallbackUsed: boolean;
  reason: string | null;
  externalCount: number;
  fallbackCount: number;
};

type NewsFetchResult = {
  items: NewsItem[];
  provider: string;
  configured: boolean;
  available: boolean;
  status: NewsProviderStatusCode;
};

type DateRange = {
  requestedDate: string | null;
  timezone: string;
  startUTC: string | null;
  endUTC: string | null;
};

type CoinNewsMetadata = {
  symbol: string;
  coinName: string | null;
  providerId: string | null;
  keywords: string[];
};

type NewsCacheEntry = {
  cacheKey: string;
  provider: string;
  items: NewsItem[];
  expiresAt: number;
  updatedAt: string;
};

const newsCacheByKey = new Map<string, NewsCacheEntry>();

const MARKET_NEWS_QUERY = 'cryptocurrency OR bitcoin OR ethereum OR blockchain OR "digital asset" OR "crypto market"';
const MARKET_RELEVANCE_KEYWORDS = [
  'crypto',
  'cryptocurrency',
  'bitcoin',
  'ethereum',
  'blockchain',
  'digital asset',
  'stablecoin',
  'defi',
  'web3',
  'token',
  'crypto market',
  'exchange',
  'etf',
];
const GENERAL_NEWS_BLOCKLIST = [
  'sports',
  'football',
  'baseball',
  'basketball',
  'election',
  'parliament',
  'congress',
  'car',
  'automotive',
  'real estate',
  'property',
  'rent',
  'porsche',
  'apple music',
  'iphone',
];
const SERVICE_TIMEZONE = env.SERVICE_TIMEZONE || 'Asia/Seoul';

function shouldSkipPersistentNewsCache() {
  return process.env.NODE_ENV === 'test';
}

function shouldSuppressNewsCacheError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return isDatabaseSchemaMismatchError(error) || /denied access|authentication failed|connect ECONNREFUSED/i.test(message);
}

function safeDateOnly(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function kstDateToUtcRange(date: string | null): DateRange {
  if (!date) {
    return {
      requestedDate: null,
      timezone: SERVICE_TIMEZONE,
      startUTC: null,
      endUTC: null,
    };
  }

  const offsetHours = SERVICE_TIMEZONE === 'Asia/Seoul' ? 9 : 0;
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, day, -offsetHours, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const range = {
    requestedDate: date,
    timezone: SERVICE_TIMEZONE,
    startUTC: start.toISOString(),
    endUTC: end.toISOString(),
  };
  logger.debug(
    { domain: 'news-date', requestedDate: date, timezone: SERVICE_TIMEZONE, startUTC: range.startUTC, endUTC: range.endUTC },
    `[NewsDate] requestedDate=${date} timezone=${SERVICE_TIMEZONE} startUTC=${range.startUTC} endUTC=${range.endUTC}`,
  );
  return range;
}

function isWithinDateRange(item: NewsItem, range: DateRange) {
  if (!range.startUTC || !range.endUTC) {
    return true;
  }
  const publishedAt = Date.parse(item.publishedAt);
  return Number.isFinite(publishedAt)
    && publishedAt >= Date.parse(range.startUTC)
    && publishedAt < Date.parse(range.endUTC);
}

function uniqueStrings(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function providerIdToPhrase(value: string | null) {
  return value?.replace(/[-_]+/g, ' ').trim() || null;
}

function builtInCoinAliases(symbol: string, coinName: string | null, providerId: string | null) {
  if (symbol === 'BIO') {
    return ['BIO token', 'BIO Protocol token', 'DeSci', 'bio.xyz', 'biotechnology', 'tokenized biotech'];
  }
  return [
    coinName ? `${coinName} token` : null,
    providerIdToPhrase(providerId),
  ];
}

async function resolveCoinNewsMetadata(params: {
  symbol: string;
  coinName?: string | null;
  providerId?: string | null;
}): Promise<CoinNewsMetadata> {
  let dbCoinName: string | null = null;
  if (!shouldSkipPersistentNewsCache()) {
    try {
      const row = await prisma.coin.findUnique({
        where: { symbol: params.symbol },
        select: { nameEn: true },
      });
      dbCoinName = row?.nameEn ?? null;
    } catch (error) {
      if (!shouldSuppressNewsCacheError(error)) {
        logger.debug({ domain: 'news', symbol: params.symbol, err: error }, '[News] coin metadata lookup failed');
      }
    }
  }

  const coinName = dbCoinName
    ?? params.coinName?.trim()
    ?? COIN_MAP.get(params.symbol)?.nameEn
    ?? (params.symbol === 'ORCA' ? 'Orca' : params.symbol === 'BIO' ? 'BIO Protocol' : null);
  const providerId = params.providerId?.trim() || (params.symbol === 'BIO' ? 'bio-protocol' : null);
  const keywords = uniqueStrings([
    coinName,
    providerIdToPhrase(providerId),
    ...builtInCoinAliases(params.symbol, coinName, providerId),
    params.symbol.length > 3 ? params.symbol : null,
  ]);

  return {
    symbol: params.symbol,
    coinName,
    providerId,
    keywords,
  };
}

function itemLooksLikeCryptoMarketNews(item: NewsItem) {
  const text = itemSearchText(item);
  if (GENERAL_NEWS_BLOCKLIST.some((keyword) => text.includes(keyword))) {
    return false;
  }
  return MARKET_RELEVANCE_KEYWORDS.some((keyword) => text.includes(keyword));
}

function coinRelevanceScoreForItem(item: NewsItem, metadata: CoinNewsMetadata) {
  const symbol = metadata.symbol;
  if (!symbol) {
    return 0.8;
  }
  if (normalizeSymbolSet(item.symbols).includes(symbol)) {
    return 1;
  }
  const exactKeywordMatches = metadata.keywords.filter((keyword) => textMentionsKeyword(item, keyword));
  if (exactKeywordMatches.length >= 2) {
    return 0.94;
  }
  if (metadata.coinName && textMentionsKeyword(item, metadata.coinName)) {
    return 0.88;
  }
  if (exactKeywordMatches.length === 1) {
    return 0.76;
  }
  if (symbol.length > 3 && textMentionsSymbol(item, symbol)) {
    return 0.72;
  }
  if (isRelatedCoinMatch(item, symbol)) {
    return 0.65;
  }
  return 0;
}

function relevanceScoreForItem(item: NewsItem, symbol?: string | null, coinName?: string | null) {
  if (!symbol) {
    return itemLooksLikeCryptoMarketNews(item) ? 0.8 : 0;
  }
  return coinRelevanceScoreForItem(item, {
    symbol,
    coinName: coinName ?? null,
    providerId: null,
    keywords: uniqueStrings([coinName, ...builtInCoinAliases(symbol, coinName ?? null, null)]),
  });
}

const fallbackNewsItems: NewsItem[] = [
  {
    id: 'btc-market-context-2026-04-30',
    title: 'Bitcoin market context remains available for read-only news views',
    titleKo: '비트코인 시장 맥락, 읽기 전용 뉴스 화면에서 계속 제공',
    summary: 'Bitcoin liquidity and digital asset market conditions remained active reference context for news readers.',
    summaryKo: '비트코인 유동성과 디지털 자산 시장 상황은 뉴스 독자를 위한 참고 맥락으로 유지됐습니다.',
    body: 'Bitcoin liquidity and digital asset market conditions remained active reference context for read-only informational views.',
    source: 'Cryptory Research',
    provider: 'cryptory_research',
    publishedAt: '2026-04-30T01:00:00.000Z',
    symbols: ['BTC'],
    category: 'market',
    thumbnailUrl: null,
    imageUrl: null,
    isImportant: true,
    tags: ['market', 'bitcoin', 'BTC'],
    url: 'https://cryptory.example/news/btc-market-context-2026-04-30',
    language: 'en',
    translated: true,
    translationProvider: 'fallback',
    tone: 'neutral',
  },
  {
    id: 'btc-market-overview-2026-05-02',
    title: 'Bitcoin market data shows steady liquidity across major venues',
    titleKo: '비트코인 시장 데이터, 주요 거래소에서 안정적인 유동성 보여',
    summary: 'Bitcoin price and volume data remained active across major spot venues, with investors watching macro data and ETF flows.',
    summaryKo: '비트코인 가격과 거래량 데이터는 주요 현물 거래소에서 활발하게 유지됐으며, 투자자들은 거시 지표와 ETF 흐름을 함께 주시했습니다.',
    body: 'Bitcoin market data remained active across major spot venues. Price movement, volume, and volatility continue to be useful reference data for users comparing assets and reviewing portfolio exposure.',
    source: 'Cryptory Research',
    provider: 'cryptory_research',
    publishedAt: '2026-05-02T00:00:00.000Z',
    symbols: ['BTC'],
    category: 'market',
    thumbnailUrl: null,
    imageUrl: null,
    isImportant: true,
    tags: ['market', 'bitcoin', 'BTC'],
    url: 'https://cryptory.example/news/btc-market-overview-2026-05-02',
    language: 'en',
    translated: true,
    translationProvider: 'fallback',
    tone: 'neutral',
  },
  {
    id: 'eth-network-update-2026-05-02',
    title: 'Ethereum network metrics remain in focus for market watchers',
    titleKo: '이더리움 네트워크 지표, 시장 참여자들의 관심 지속',
    summary: 'Ethereum users continued to track network activity, fees, and ecosystem updates as reference information for asset analysis.',
    summaryKo: '이더리움 이용자들은 자산 분석 참고 정보로 네트워크 활동, 수수료, 생태계 업데이트를 계속 확인했습니다.',
    body: 'Ethereum network activity, fee conditions, and ecosystem updates remain important reference signals for users who follow asset fundamentals and portfolio allocation.',
    source: 'Cryptory Research',
    provider: 'cryptory_research',
    publishedAt: '2026-05-02T01:00:00.000Z',
    symbols: ['ETH'],
    category: 'network',
    thumbnailUrl: null,
    imageUrl: null,
    isImportant: false,
    tags: ['market', 'ethereum', 'ETH'],
    url: 'https://cryptory.example/news/eth-network-update-2026-05-02',
    language: 'en',
    translated: true,
    translationProvider: 'fallback',
    tone: 'neutral',
  },
  {
    id: 'solana-defi-context-2026-05-02',
    title: 'Solana DeFi venues remain active as liquidity rotates through DEX markets',
    titleKo: '솔라나 DeFi 거래소, DEX 유동성 순환 속 활동 지속',
    summary: 'Solana ecosystem liquidity, DEX activity, and DeFi participation remain useful context when direct token news is limited.',
    summaryKo: '직접 토큰 뉴스가 제한적일 때 솔라나 생태계 유동성, DEX 활동, DeFi 참여도는 관련 맥락으로 활용할 수 있습니다.',
    body: 'Solana ecosystem liquidity and DEX activity remain useful market context for assets connected to decentralized exchange infrastructure.',
    source: 'Cryptory Research',
    provider: 'cryptory_research',
    publishedAt: '2026-05-02T02:00:00.000Z',
    symbols: ['SOL'],
    category: 'market',
    thumbnailUrl: null,
    imageUrl: null,
    isImportant: false,
    tags: ['market', 'solana', 'defi', 'dex'],
    url: 'https://cryptory.example/news/solana-defi-context-2026-05-02',
    language: 'en',
    translated: true,
    translationProvider: 'fallback',
    tone: 'neutral',
  },
];

export const NEWS_CATEGORIES = ['market', 'network', 'kimchi-premium'] as const;

const DEFAULT_RSS_FEEDS = [
  { provider: 'coindesk_rss', source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { provider: 'cointelegraph_rss', source: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { provider: 'decrypt_rss', source: 'Decrypt', url: 'https://decrypt.co/feed' },
];

const ECOSYSTEM_KEYWORDS: Record<string, string[]> = {
  ORCA: ['orca', 'solana', 'dex', 'defi', 'liquidity', 'amm'],
  DRIFT: ['drift', 'solana', 'perpetual', 'defi', 'dex'],
  SOL: ['solana', 'sol'],
  ETH: ['ethereum', 'ether', 'eth'],
  BTC: ['bitcoin', 'btc'],
  BIO: ['bio protocol', 'bio token', 'bio crypto', 'desci', 'bio.xyz', 'bioprotocol'],
};

const cryptopanicClient = new RestClient('news', env.CRYPTOPANIC_API_BASE_URL);
const cryptocurrencyCvClient = new RestClient('news', env.CRYPTOCURRENCY_CV_API_BASE_URL);
const newsApiClient = new RestClient('news', env.NEWSAPI_API_BASE_URL);
const rssClient = new RestClient('news', 'https://rss.local');

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
  return [...new Set(values.map((value) => normalizeNewsSymbol(value)).filter(Boolean))];
}

function sanitizeText(value?: string | null) {
  return decodeHtmlEntities(value ?? '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || null;
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

function normalizeKeyword(value: string) {
  return value.trim().toLowerCase();
}

function itemSearchText(item: NewsItem) {
  return [item.title, item.summary ?? '', item.body ?? '', ...item.tags, ...item.symbols].join(' ').toLowerCase();
}

function textMentionsKeyword(item: NewsItem, keyword: string) {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) {
    return false;
  }
  return itemSearchText(item).includes(normalized);
}

function textMentionsSymbol(item: NewsItem, symbol: string) {
  const keyword = symbol.toUpperCase();
  return [item.title, item.summary ?? '', item.body ?? '']
    .some((value) => new RegExp(`(^|[^A-Z0-9])${keyword}([^A-Z0-9]|$)`, 'i').test(value));
}

function isDirectCoinMatch(item: NewsItem, symbol: string, coinName?: string | null) {
  if (!symbol) {
    return true;
  }
  if (normalizeSymbolSet(item.symbols).includes(symbol)) {
    return true;
  }
  if (normalizeSymbolSet(item.tags).includes(symbol)) {
    return true;
  }
  if (textMentionsSymbol(item, symbol)) {
    return true;
  }
  return Boolean(coinName && textMentionsKeyword(item, coinName));
}

function isRelatedCoinMatch(item: NewsItem, symbol: string) {
  const keywords = ECOSYSTEM_KEYWORDS[symbol] ?? [];
  return keywords.some((keyword) => textMentionsKeyword(item, keyword));
}

function detectSymbolsFromText(title: string, summary: string | null) {
  const text = `${title} ${summary ?? ''}`.toLowerCase();
  const detected: string[] = [];
  for (const [symbol, coin] of COIN_MAP.entries()) {
    if (text.includes(symbol.toLowerCase()) || text.includes(coin.nameEn.toLowerCase()) || text.includes(coin.nameKo.toLowerCase())) {
      detected.push(symbol);
    }
  }
  if (text.includes('bitcoin')) detected.push('BTC');
  if (text.includes('ethereum')) detected.push('ETH');
  if (text.includes('solana')) detected.push('SOL');
  if (text.includes('orca')) detected.push('ORCA');
  if (text.includes('bio protocol') || text.includes('bio.xyz') || text.includes('desci')) detected.push('BIO');
  return normalizeSymbolSet(detected);
}

function toneFromText(title: string, summary: string | null): 'positive' | 'neutral' | 'negative' {
  const text = `${title} ${summary ?? ''}`.toLowerCase();
  if (/(hack|exploit|lawsuit|drop|falls|fear|bear|liquidation|outflow)/i.test(text)) {
    return 'negative';
  }
  if (/(surge|rally|gain|record|approval|growth|bull|inflow)/i.test(text)) {
    return 'positive';
  }
  return 'neutral';
}

function projectNewsItem(item: NewsItem, scope: 'market' | 'coin', relevanceScore?: number) {
  const source = item.source?.trim() || item.provider || 'unknown';
  const symbols = normalizeSymbolSet(item.symbols);
  const titleKo = null;
  const summaryKo = null;
  return {
    id: String(item.id),
    scope,
    symbols,
    title: item.title,
    titleKo,
    translatedTitle: titleKo,
    summary: item.summary ?? null,
    description: item.body ?? item.summary ?? null,
    summaryKo,
    translatedSummary: summaryKo,
    source,
    sourceName: source,
    provider: item.provider ?? 'unknown',
    publishedAt: new Date(item.publishedAt).toISOString(),
    url: item.url ?? null,
    originalUrl: item.url ?? null,
    imageUrl: item.imageUrl ?? item.thumbnailUrl ?? null,
    tags: [...new Set(item.tags)],
    language: item.language ?? 'en',
    translated: false,
    translationProvider: 'client',
    category: item.category,
    thumbnailUrl: item.thumbnailUrl,
    isImportant: item.isImportant,
    tone: item.tone ?? 'neutral',
    relatedSymbols: symbols,
    relatedCoins: symbols,
    relevanceScore: relevanceScore ?? relevanceScoreForItem(item),
  };
}

function newsIdFromUrl(url: string | null, title: string) {
  return createHash('sha1').update(url || title).digest('hex').slice(0, 20);
}

function toExternalNewsItems(response: CryptoPanicResponse): NewsItem[] {
  return (response.results ?? []).map((item) => {
    const symbols = normalizeSymbolSet((item.currencies ?? []).map((currency) => currency.code ?? ''));
    const title = sanitizeText(item.title) ?? 'Untitled crypto market update';
    const source = sanitizeText(item.source?.title) ?? sanitizeText(item.domain) ?? sanitizeText(item.source?.domain) ?? 'CryptoPanic';
    const url = item.url?.trim() || null;
    const summary = sanitizeText(item.metadata?.description);
    return {
      id: `cryptopanic-${String(item.id ?? newsIdFromUrl(url, title))}`,
      scope: symbols.length > 0 ? 'coin' : 'market',
      title,
      titleKo: null,
      summary,
      summaryKo: null,
      body: summary,
      source,
      provider: 'cryptopanic',
      publishedAt: item.published_at ? new Date(item.published_at).toISOString() : new Date().toISOString(),
      symbols,
      category: item.kind ?? 'market',
      thumbnailUrl: item.metadata?.image ?? null,
      imageUrl: item.metadata?.image ?? null,
      isImportant: false,
      tags: [...new Set(['market', ...symbols])],
      url,
      language: 'en',
      translated: false,
      translationProvider: 'unavailable',
      tone: toneFromText(title, summary),
    };
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function firstSanitizedString(...values: unknown[]) {
  for (const value of values) {
    const sanitized = sanitizeText(stringValue(value));
    if (sanitized) {
      return sanitized;
    }
  }
  return null;
}

function firstValidIsoDate(...values: unknown[]) {
  for (const value of values) {
    const raw = stringValue(value);
    if (!raw) {
      continue;
    }
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

function normalizeProviderTags(value: CryptocurrencyCvArticle['tags']) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeText(item)).filter((item): item is string => Boolean(item));
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => sanitizeText(item)).filter((item): item is string => Boolean(item));
  }
  return [];
}

function normalizeProviderSymbols(value: CryptocurrencyCvArticle['symbols']) {
  const rawItems = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return normalizeSymbolSet(rawItems.map((item) => {
    if (typeof item === 'string') {
      return item;
    }
    return item.symbol ?? item.code ?? item.ticker ?? '';
  }));
}

function extractCryptocurrencyCvArticles(response: CryptocurrencyCvResponse): CryptocurrencyCvArticle[] {
  if (Array.isArray(response)) {
    return response;
  }
  const data = response.data;
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === 'object') {
    return data.articles ?? data.results ?? data.items ?? data.news ?? [];
  }
  return response.articles ?? response.results ?? response.items ?? response.news ?? [];
}

function toCryptocurrencyCvNewsItems(response: CryptocurrencyCvResponse): NewsItem[] {
  return extractCryptocurrencyCvArticles(response).map((item) => {
    const title = firstSanitizedString(item.title, item.headline) ?? 'Untitled crypto market update';
    const summary = firstSanitizedString(item.summary, item.description, item.content);
    const url = stringValue(item.url ?? item.link)?.trim() || null;
    const sourceObject = asObject(item.source);
    const source = firstSanitizedString(
      sourceObject?.name,
      sourceObject?.title,
      item.sourceName,
      item.publisher,
      sourceObject?.domain,
      typeof item.source === 'string' ? item.source : null,
    ) ?? 'Cryptocurrency.cv';
    const symbols = normalizeSymbolSet([
      ...normalizeProviderSymbols(item.symbols),
      ...normalizeProviderSymbols(item.tickers),
      ...normalizeProviderSymbols(item.coins),
      ...normalizeProviderSymbols(item.currencies),
      ...detectSymbolsFromText(title, summary),
    ]);
    const tags = normalizeProviderTags(item.tags);
    const imageUrl = stringValue(item.imageUrl ?? item.image ?? item.thumbnail)?.trim() || null;
    return {
      id: `cryptocurrency-cv-${String(item.id ?? item.slug ?? newsIdFromUrl(url, title))}`,
      scope: symbols.length > 0 ? 'coin' : 'market',
      title,
      titleKo: null,
      summary,
      summaryKo: null,
      body: summary,
      source,
      provider: 'cryptocurrency_cv',
      publishedAt: firstValidIsoDate(item.publishedAt, item.published_at, item.published, item.pubDate, item.date, item.createdAt),
      symbols,
      category: firstSanitizedString(item.category) ?? 'market',
      thumbnailUrl: imageUrl,
      imageUrl,
      isImportant: false,
      tags: [...new Set(['market', ...tags, ...symbols])],
      url,
      language: 'en',
      translated: false,
      translationProvider: 'unavailable',
      tone: toneFromText(title, summary),
    };
  });
}

function isRemovedNewsApiArticle(title: string, summary: string | null, url: string | null) {
  const text = `${title} ${summary ?? ''}`.toLowerCase();
  return !url
    || title === '[Removed]'
    || url === 'https://removed.com'
    || text.includes('[removed]')
    || text.includes('this article has been removed')
    || text.includes('removed from publication');
}

export function toNewsApiNewsItems(response: NewsApiResponse): NewsItem[] {
  const seenUrl = new Set<string>();
  const items: NewsItem[] = [];
  for (const item of response.articles ?? []) {
    const title = sanitizeText(item.title);
    const summary = sanitizeText(item.description) ?? sanitizeText(item.content);
    const url = item.url?.trim() || null;
    if (!title || !url || isRemovedNewsApiArticle(title, summary, url)) {
      continue;
    }
    const urlKey = url.trim().toLowerCase();
    if (seenUrl.has(urlKey)) {
      continue;
    }
    seenUrl.add(urlKey);
    const source = sanitizeText(item.source?.name) ?? 'NewsAPI';
    const symbols = detectSymbolsFromText(title, summary);
    const imageUrl = item.urlToImage?.trim() || null;
    items.push({
      id: `newsapi-${newsIdFromUrl(url, title)}`,
      scope: symbols.length > 0 ? 'coin' : 'market',
      title,
      titleKo: null,
      summary,
      summaryKo: null,
      body: summary,
      source,
      provider: 'newsapi',
      publishedAt: firstValidIsoDate(item.publishedAt),
      symbols,
      category: 'market',
      thumbnailUrl: imageUrl,
      imageUrl,
      isImportant: false,
      tags: [...new Set(['market', ...symbols])],
      url,
      language: 'en',
      translated: false,
      translationProvider: 'unavailable',
      tone: toneFromText(title, summary),
    });
  }
  return items;
}

function rssTag(item: string, tag: string) {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return sanitizeText(match?.[1] ?? null);
}

function parseRssItems(xml: string, provider: string, source: string): NewsItem[] {
  const chunks = Array.from(xml.matchAll(/<item[\s\S]*?<\/item>/gi)).map((match) => match[0]).slice(0, 30);
  const items: NewsItem[] = [];
  for (const chunk of chunks) {
    const title = rssTag(chunk, 'title');
    if (!title) {
      continue;
    }
    const summary = rssTag(chunk, 'description') ?? rssTag(chunk, 'content:encoded');
    const link = rssTag(chunk, 'link') ?? rssTag(chunk, 'guid');
    const pubDate = rssTag(chunk, 'pubDate') ?? rssTag(chunk, 'dc:date') ?? rssTag(chunk, 'published');
    const publishedAt = pubDate && !Number.isNaN(new Date(pubDate).getTime())
      ? new Date(pubDate).toISOString()
      : new Date().toISOString();
    const symbols = detectSymbolsFromText(title, summary);
    const keywordProbe: NewsItem = {
      id: '',
      title,
      titleKo: null,
      summary,
      summaryKo: null,
      body: summary,
      source,
      provider,
      publishedAt,
      symbols: [],
      category: null,
      thumbnailUrl: null,
      isImportant: false,
      tags: [],
      url: link,
    };
    items.push({
      id: `${provider}-${newsIdFromUrl(link, title)}`,
      scope: symbols.length > 0 ? 'coin' : 'market',
      title,
      titleKo: null,
      summary,
      summaryKo: null,
      body: summary,
      source,
      provider,
      publishedAt,
      symbols,
      category: 'market',
      thumbnailUrl: null,
      imageUrl: null,
      isImportant: false,
      tags: [...new Set(['market', ...symbols, ...ECOSYSTEM_KEYWORDS.SOL.filter((keyword) => textMentionsKeyword(keywordProbe, keyword))])],
      url: link,
      language: 'en',
      translated: false,
      translationProvider: 'unavailable',
      tone: toneFromText(title, summary),
    });
  }
  return items;
}

function configuredRssFeeds() {
  const value = env.NEWS_RSS_FEEDS?.trim();
  if (!value) {
    return DEFAULT_RSS_FEEDS;
  }
  return value.split(',')
    .map((url, index) => ({ provider: `rss_${index + 1}`, source: new URL(url.trim()).hostname, url: url.trim() }))
    .filter((feed) => feed.url);
}

function selectedNewsProvider(): NewsProvider {
  return env.NEWS_PROVIDER;
}

function classifyProviderError(error: unknown): NewsProviderStatusCode {
  const statusCode = typeof error === 'object' && error && 'statusCode' in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : typeof error === 'object' && error && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : null;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return statusCode === 429 || /rate.?limit|too many requests|quota/i.test(message) ? 'rate_limited' : 'error';
}

async function fetchCryptoPanicNews(params: { symbol?: string | null; scope: 'market' | 'coin' }): Promise<NewsFetchResult> {
  const apiKey = env.CRYPTOPANIC_API_KEY?.trim();
  if (!apiKey) {
    logger.info(
      { domain: 'external-news', provider: 'cryptopanic', configured: false, status: 'not_configured', fetchedCount: 0 },
      '[ExternalNewsFetch] provider=cryptopanic configured=false status=not_configured fetchedCount=0',
    );
    return { items: [] as NewsItem[], provider: 'cryptopanic', configured: false, available: false, status: 'disabled' };
  }
  try {
    const response = await cryptopanicClient.request<CryptoPanicResponse>('/posts/', {
      query: {
        auth_token: apiKey,
        public: true,
        kind: 'news',
        currencies: params.scope === 'coin' && params.symbol && params.symbol.length > 3 ? params.symbol : undefined,
      },
      timeoutMs: 3500,
      retryPolicy: { maxAttempts: 1 },
    });
    const items = toExternalNewsItems(response);
    logger.info(
      { domain: 'external-news', provider: 'cryptopanic', configured: true, status: 'success', fetchedCount: items.length },
      `[ExternalNewsFetch] provider=cryptopanic configured=true status=success fetchedCount=${items.length}`,
    );
    return { items, provider: 'cryptopanic', configured: true, available: items.length > 0, status: items.length > 0 ? 'ok' : 'empty' };
  } catch (error) {
    const status = classifyProviderError(error);
    logger.warn(
      { domain: 'external-news', provider: 'cryptopanic', configured: true, status, fetchedCount: 0, err: error },
      `[ExternalNewsFetch] provider=cryptopanic configured=true status=${status} fetchedCount=0`,
    );
    return { items: [] as NewsItem[], provider: 'cryptopanic', configured: true, available: false, status };
  }
}

async function fetchCryptocurrencyCvNews(params: { symbol?: string | null; limit: number; digest?: boolean; query?: string | null }): Promise<NewsFetchResult> {
  const endpoint = params.digest ? '/digest' : params.symbol ? '/search' : '/news';
  const query = params.digest
    ? { period: '24h', format: 'full' }
    : params.symbol
      ? { q: params.query ?? params.symbol, limit: params.limit }
      : { limit: params.limit };

  try {
    const response = await cryptocurrencyCvClient.request<CryptocurrencyCvResponse>(endpoint, {
      query,
      timeoutMs: 3500,
      retryPolicy: { maxAttempts: 1 },
    });
    const items = toCryptocurrencyCvNewsItems(response);
    logger.info(
      { domain: 'external-news', provider: 'cryptocurrency_cv', endpoint, configured: true, status: 'success', fetchedCount: items.length },
      `[ExternalNewsFetch] provider=cryptocurrency_cv endpoint=${endpoint} configured=true status=success fetchedCount=${items.length}`,
    );
    return { items, provider: 'cryptocurrency_cv', configured: true, available: items.length > 0, status: items.length > 0 ? 'ok' : 'empty' };
  } catch (error) {
    const status = classifyProviderError(error);
    logger.warn(
      { domain: 'external-news', provider: 'cryptocurrency_cv', endpoint, configured: true, status, fetchedCount: 0, err: error },
      `[ExternalNewsFetch] provider=cryptocurrency_cv endpoint=${endpoint} configured=true status=${status} fetchedCount=0`,
    );
    return { items: [] as NewsItem[], provider: 'cryptocurrency_cv', configured: true, available: false, status };
  }
}

async function fetchNewsApiNews(params: { symbol?: string | null; limit: number; query?: string | null; range?: DateRange }): Promise<NewsFetchResult> {
  const apiKey = env.NEWSAPI_API_KEY?.trim();
  if (!apiKey) {
    logger.info(
      { domain: 'external-news', provider: 'newsapi', configured: false, status: 'not_configured', fetchedCount: 0 },
      '[ExternalNewsFetch] provider=newsapi configured=false status=not_configured fetchedCount=0',
    );
    return { items: [] as NewsItem[], provider: 'newsapi', configured: false, available: false, status: 'disabled' };
  }

  const q = params.query ?? (params.symbol
    ? `${params.symbol} crypto OR cryptocurrency`
    : MARKET_NEWS_QUERY);
  try {
    const response = await newsApiClient.request<NewsApiResponse>('/everything', {
      query: {
        q,
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: Math.min(Math.max(params.limit, 1), 100),
        from: params.range?.startUTC ?? undefined,
        to: params.range?.endUTC ?? undefined,
      },
      headers: {
        'X-Api-Key': apiKey,
      },
      timeoutMs: 3500,
      retryPolicy: { maxAttempts: 1 },
    });
    const items = toNewsApiNewsItems(response);
    logger.info(
      { domain: 'external-news', provider: 'newsapi', configured: true, status: 'success', fetchedCount: items.length },
      `[ExternalNewsFetch] provider=newsapi configured=true status=success fetchedCount=${items.length}`,
    );
    return { items, provider: 'newsapi', configured: true, available: items.length > 0, status: items.length > 0 ? 'ok' : 'empty' };
  } catch (error) {
    const status = classifyProviderError(error);
    logger.warn(
      { domain: 'external-news', provider: 'newsapi', configured: true, status, fetchedCount: 0, err: error },
      `[ExternalNewsFetch] provider=newsapi configured=true status=${status} fetchedCount=0`,
    );
    return { items: [] as NewsItem[], provider: 'newsapi', configured: true, available: false, status };
  }
}

async function fetchRssNews() {
  const feeds = configuredRssFeeds();
  const results = await Promise.all(feeds.map(async (feed) => {
    try {
      const xml = await rssClient.request<string>(feed.url, {
        timeoutMs: 3500,
        retryPolicy: { maxAttempts: 1 },
      });
      const items = parseRssItems(String(xml), feed.provider, feed.source);
      logger.info(
        { domain: 'external-news', provider: feed.provider, configured: true, status: 'success', fetchedCount: items.length },
        `[ExternalNewsFetch] provider=${feed.provider} configured=true status=success fetchedCount=${items.length}`,
      );
      return { ...feed, items, available: items.length > 0, status: items.length > 0 ? 'ok' as const : 'empty' as const };
    } catch (error) {
      const status = classifyProviderError(error);
      logger.warn(
        { domain: 'external-news', provider: feed.provider, configured: true, status, fetchedCount: 0, err: error },
        `[ExternalNewsFetch] provider=${feed.provider} configured=true status=${status} fetchedCount=0`,
      );
      return { ...feed, items: [] as NewsItem[], available: false, status };
    }
  }));
  return results;
}

function dedupeNewsItems(items: NewsItem[]) {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const deduped = items.filter((item) => {
    const urlKey = item.url ? createHash('sha1').update(item.url.trim().toLowerCase()).digest('hex') : null;
    const titleKey = item.title.trim().toLowerCase().replace(/[^a-z0-9가-힣]/gi, '').slice(0, 120);
    if ((urlKey && seenUrl.has(urlKey)) || seenTitle.has(titleKey)) {
      return false;
    }
    if (urlKey) seenUrl.add(urlKey);
    seenTitle.add(titleKey);
    return true;
  });
  logger.info(
    { domain: 'external-news', before: items.length, after: deduped.length },
    `[ExternalNewsDedup] before=${items.length} after=${deduped.length}`,
  );
  return deduped;
}

function buildNewsCacheKey(params: {
  scope: 'market' | 'coin';
  symbol?: string | null;
  category?: string;
  date?: string | null;
  from?: string;
  to?: string;
  sort?: string;
  digest?: boolean;
}) {
  if (params.digest) {
    return `news:digest:${params.date ?? 'latest'}:${params.sort ?? 'latest'}`;
  }
  if (params.scope === 'coin') {
    return `news:coin:${normalizeNewsSymbol(params.symbol ?? '')}:${params.date ?? 'latest'}:${params.sort ?? 'latest'}:${params.category ?? ''}`;
  }
  return `news:market:${params.date ?? 'latest'}:${params.sort ?? 'latest'}:${params.category ?? ''}`;
}

function isNewsItemArray(value: unknown): value is NewsItem[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === 'object' && 'title' in item && 'publishedAt' in item);
}

async function writeNewsCache(params: { cacheKey: string; provider: string; symbol?: string | null; items: NewsItem[] }) {
  if (params.items.length === 0) {
    return;
  }
  const updatedAt = new Date().toISOString();
  const expiresAt = Date.now() + env.NEWS_CACHE_TTL_SECONDS * 1000;
  const entry: NewsCacheEntry = {
    cacheKey: params.cacheKey,
    provider: params.provider,
    items: params.items,
    expiresAt,
    updatedAt,
  };
  newsCacheByKey.set(params.cacheKey, entry);
  if (shouldSkipPersistentNewsCache()) {
    return;
  }
  try {
    const firstItem = params.items[0];
    await (prisma as any).newsCache?.upsert({
      where: { cacheKey: params.cacheKey },
      create: {
        cacheKey: params.cacheKey,
        provider: params.provider,
        symbol: params.symbol || null,
        providerNewsId: firstItem?.id ?? null,
        title: firstItem?.title ?? null,
        summary: firstItem?.summary ?? null,
        content: firstItem?.body ?? null,
        sourceName: firstItem?.source ?? null,
        originalUrl: firstItem?.url ?? null,
        imageUrl: firstItem?.imageUrl ?? firstItem?.thumbnailUrl ?? null,
        language: firstItem?.language ?? 'en',
        publishedAt: firstItem?.publishedAt ? new Date(firstItem.publishedAt) : null,
        symbols: firstItem?.symbols ?? [],
        tags: firstItem?.tags ?? [],
        relevanceScore: firstItem ? relevanceScoreForItem(firstItem, params.symbol) : null,
        scope: params.symbol ? 'coin' : 'market',
        rawPayload: { items: params.items },
        payload: { items: params.items },
        expiresAt: new Date(expiresAt),
      },
      update: {
        provider: params.provider,
        symbol: params.symbol || null,
        providerNewsId: firstItem?.id ?? null,
        title: firstItem?.title ?? null,
        summary: firstItem?.summary ?? null,
        content: firstItem?.body ?? null,
        sourceName: firstItem?.source ?? null,
        originalUrl: firstItem?.url ?? null,
        imageUrl: firstItem?.imageUrl ?? firstItem?.thumbnailUrl ?? null,
        language: firstItem?.language ?? 'en',
        publishedAt: firstItem?.publishedAt ? new Date(firstItem.publishedAt) : null,
        symbols: firstItem?.symbols ?? [],
        tags: firstItem?.tags ?? [],
        relevanceScore: firstItem ? relevanceScoreForItem(firstItem, params.symbol) : null,
        scope: params.symbol ? 'coin' : 'market',
        rawPayload: { items: params.items },
        payload: { items: params.items },
        expiresAt: new Date(expiresAt),
      },
    });
  } catch (error) {
    if (!shouldSuppressNewsCacheError(error)) {
      logger.warn({ domain: 'news-cache', action: 'write_failed', err: error }, '[NewsCache] action=write status=failed');
    }
  }
}

async function readNewsCache(cacheKey: string) {
  const memory = newsCacheByKey.get(cacheKey);
  if (memory?.items.length) {
    return {
      items: memory.items,
      provider: memory.provider,
      updatedAt: memory.updatedAt,
      stale: memory.expiresAt <= Date.now(),
    };
  }
  if (shouldSkipPersistentNewsCache()) {
    return null;
  }
  try {
    const row = await (prisma as any).newsCache?.findUnique({
      where: { cacheKey },
      select: { provider: true, payload: true, updatedAt: true, expiresAt: true },
    });
    const payload = row?.payload && typeof row.payload === 'object' ? row.payload as { items?: unknown } : null;
    if (row && isNewsItemArray(payload?.items)) {
      return {
        items: payload.items,
        provider: row.provider as string,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date().toISOString(),
        stale: row.expiresAt instanceof Date ? row.expiresAt.getTime() <= Date.now() : false,
      };
    }
  } catch (error) {
    if (!shouldSuppressNewsCacheError(error)) {
      logger.warn({ domain: 'news-cache', action: 'read_failed', err: error }, '[NewsCache] action=read status=failed');
    }
  }
  return null;
}

function normalizeFetchedNewsItems(items: NewsItem[]) {
  return items.map((item) => ({
    ...item,
    titleKo: null,
    summaryKo: null,
    translated: false,
    translationProvider: 'client',
  }));
}

function providerHadLimitOrError(providerStatus: Record<string, NewsProviderStatusCode>) {
  return Object.values(providerStatus).some((status) => status === 'rate_limited' || status === 'error');
}

function providerHadLimit(providerStatus: Record<string, NewsProviderStatusCode>) {
  return Object.values(providerStatus).some((status) => status === 'rate_limited');
}

function providerStatusReason(params: {
  providerStatus: Record<string, NewsProviderStatusCode>;
  cacheHit: boolean;
  itemCount: number;
}) {
  if (params.itemCount > 0) {
    return params.cacheHit && providerHadLimitOrError(params.providerStatus) ? 'using_stale_cache' : null;
  }
  if (providerHadLimit(params.providerStatus)) {
    return params.cacheHit ? 'provider_limit' : 'provider_limit_and_cache_empty';
  }
  if (providerHadLimitOrError(params.providerStatus)) {
    return params.cacheHit ? 'using_stale_cache' : 'provider_error';
  }
  return 'cache_empty';
}

async function fetchExternalNews(params: {
  symbol?: string | null;
  limit: number;
  digest?: boolean;
  cacheKey: string;
  scope: 'market' | 'coin';
  query: string;
  range: DateRange;
}) {
  const cached = await readNewsCache(params.cacheKey);
  if (cached?.items.length && !cached.stale) {
    return {
      items: cached.items,
      providers: [cached.provider],
      externalConfigured: true,
      externalAvailable: true,
      externalCount: 0,
      providerStatus: { cache: 'ok' as NewsProviderStatusCode },
      cacheHit: true,
      cacheUpdatedAt: cached.updatedAt,
      cacheStale: false,
      reason: null,
    };
  }

  const provider = selectedNewsProvider();
  const primary = provider === 'newsapi'
    ? await fetchNewsApiNews({ symbol: params.symbol, limit: params.limit, query: params.query, range: params.range })
    : provider === 'cryptocurrency_cv'
      ? await fetchCryptocurrencyCvNews({ symbol: params.symbol, limit: params.limit, digest: params.digest, query: params.query })
      : await fetchCryptoPanicNews({ symbol: params.symbol, scope: params.scope });
  const newsApi = provider !== 'newsapi' && primary.items.length === 0
    ? await fetchNewsApiNews({ symbol: params.symbol, limit: params.limit, query: params.query, range: params.range })
    : null;
  const rssResults = provider !== 'newsapi' && primary.items.length === 0 && (newsApi?.items.length ?? 0) === 0 ? await fetchRssNews() : [];
  const providerStatus: Record<string, NewsProviderStatusCode> = {
    [primary.provider]: primary.status,
    ...(provider === 'newsapi' ? {} : { newsapi: newsApi?.status ?? (env.NEWSAPI_API_KEY?.trim() ? 'empty' as const : 'disabled' as const) }),
    ...(provider === 'cryptopanic' ? { cryptocurrency_cv: 'disabled' as const } : { cryptopanic: env.CRYPTOPANIC_API_KEY?.trim() ? 'empty' as const : 'disabled' as const }),
    ...(provider === 'newsapi' ? { cryptocurrency_cv: 'disabled' as const } : {}),
  };
  for (const result of rssResults) {
    providerStatus[result.provider] = result.status;
  }
  const externalItems = [
    ...primary.items,
    ...(newsApi?.items ?? []),
    ...rssResults.flatMap((result) => result.items),
  ];
  const providers = [
    ...(primary.configured ? [primary.provider] : []),
    ...(newsApi?.configured ? [newsApi.provider] : []),
    ...rssResults.map((result) => result.provider),
  ];
  const externalAvailable = externalItems.length > 0;
  const deduped = normalizeFetchedNewsItems(dedupeNewsItems(externalItems));
  if (deduped.length > 0) {
    await writeNewsCache({
      cacheKey: params.cacheKey,
      provider: providers[0] ?? primary.provider,
      symbol: params.symbol,
      items: deduped,
    });
  }
  const fallbackCached = deduped.length === 0 ? cached : null;

  return {
    items: fallbackCached?.items ?? deduped,
    providers,
    externalConfigured: providers.length > 0,
    externalAvailable,
    externalCount: deduped.length,
    providerStatus,
    cacheHit: Boolean(fallbackCached?.items.length),
    cacheUpdatedAt: fallbackCached?.updatedAt ?? null,
    cacheStale: fallbackCached?.stale ?? false,
    reason: providerStatusReason({ providerStatus, cacheHit: Boolean(fallbackCached?.items.length), itemCount: (fallbackCached?.items ?? deduped).length }),
  };
}

function sortPublishedDesc(items: NewsItem[]) {
  return [...items].sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
}

function resolveNewsSort(params: { sort?: string; orderBy?: string; direction?: string; scope: 'market' | 'coin' }): NewsSort {
  if (params.sort === 'oldest') {
    return { orderBy: params.orderBy === 'relevanceScore' ? 'relevanceScore' : 'publishedAt', direction: params.direction === 'desc' ? 'desc' : 'asc' };
  }
  if (params.sort === 'popular') {
    return { orderBy: params.orderBy === 'publishedAt' || params.orderBy === 'createdAt' ? 'publishedAt' : 'relevanceScore', direction: params.direction === 'asc' ? 'asc' : 'desc' };
  }
  return {
    orderBy: params.orderBy === 'relevanceScore' ? 'relevanceScore' : 'publishedAt',
    direction: params.direction === 'asc' ? 'asc' : 'desc',
  };
}

function compareNewsItems(left: NewsItem, right: NewsItem, sort: NewsSort, relevance: (item: NewsItem) => number) {
  const multiplier = sort.direction === 'asc' ? 1 : -1;
  const value = (item: NewsItem) => {
    if (sort.orderBy === 'relevanceScore') return relevance(item);
    return Date.parse(item.publishedAt);
  };
  const diff = value(left) - value(right);
  if (diff !== 0) {
    return diff * multiplier;
  }
  return Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
}

function sourceStatus(params: {
  externalConfigured: boolean;
  externalAvailable: boolean;
  providers: string[];
  fallbackUsed: boolean;
  fallbackCount: number;
  externalCount: number;
  reason?: string | null;
}): NewsSourceStatus {
  return {
    externalConfigured: params.externalConfigured,
    externalAvailable: params.externalAvailable,
    providers: params.providers,
    fallbackUsed: params.fallbackUsed,
    reason: params.reason ?? (params.fallbackUsed
      ? params.externalConfigured
        ? 'NEWS_EXTERNAL_UNAVAILABLE'
        : 'NEWS_PROVIDER_NOT_CONFIGURED'
      : null),
    externalCount: params.externalCount,
    fallbackCount: params.fallbackCount,
  };
}

function filterMarketItems(items: NewsItem[], params: { category?: string; dateRange: DateRange; from?: string; to?: string }) {
  return items.filter((item) => {
    if (params.category && item.category !== params.category && !item.tags.includes(params.category)) {
      return false;
    }
    if (!isWithinDateRange(item, params.dateRange)) {
      return false;
    }
    const day = item.publishedAt.slice(0, 10);
    if (params.from && day < params.from) {
      return false;
    }
    if (params.to && day > params.to) {
      return false;
    }
    return true;
  });
}

function paginate<T extends { id: string }>(items: T[], cursor: string | undefined, limit: number) {
  const cursorIndex = cursor ? items.findIndex((item) => item.id === cursor) + 1 : 0;
  const offset = Math.max(cursorIndex, 0);
  const page = items.slice(offset, offset + limit);
  const next = items[offset + limit];
  return {
    page,
    nextCursor: next?.id ?? null,
    hasMore: Boolean(next),
  };
}

export async function listNews(params: {
  coin?: string;
  symbol?: string;
  coinName?: string;
  providerId?: string;
  category?: string;
  date?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
  fallback?: boolean;
  digest?: boolean;
  sort?: 'latest' | 'oldest' | 'popular';
  orderBy?: 'publishedAt' | 'createdAt' | 'relevanceScore';
  direction?: 'asc' | 'desc';
}) {
  const limit = parseNewsLimit(params.limit) ?? 20;
  const coin = (params.symbol ?? params.coin) ? normalizeNewsSymbol((params.symbol ?? params.coin) as string) : '';
  const category = params.category?.trim().toLowerCase();
  const date = safeDateOnly(params.date);
  const dateRange = kstDateToUtcRange(date);
  const scope = coin ? 'coin' as const : 'market' as const;
  const coinMetadata = coin ? await resolveCoinNewsMetadata({ symbol: coin, coinName: params.coinName, providerId: params.providerId }) : null;
  const coinName = coinMetadata?.coinName ?? null;
  const provider = selectedNewsProvider();
  const appliedSort = resolveNewsSort({ sort: params.sort, orderBy: params.orderBy, direction: params.direction, scope });
  const sortKey = `${appliedSort.orderBy}:${appliedSort.direction}`;
  const cacheKey = buildNewsCacheKey({
    scope,
    symbol: coin || null,
    category,
    date,
    from: params.from?.trim(),
    to: params.to?.trim(),
    sort: sortKey,
    digest: params.digest && !coin,
  });
  const providerQuery = coinMetadata
    ? coinMetadata.keywords.map((keyword) => keyword.includes(' ') ? `"${keyword}"` : keyword).join(' OR ')
    : MARKET_NEWS_QUERY;

  logger.info(
    { domain: 'coin-news', symbol: coin || null, coinName, provider, date, limit, sort: appliedSort, keywords: coinMetadata?.keywords ?? [] },
    `[CoinNewsRequest] symbol=${coin || ''} coinName=${coinName ?? ''} provider=${provider} date=${date ?? ''} limit=${limit} sort=${sortKey}`,
  );

  const external = await fetchExternalNews({
    symbol: coin || null,
    limit,
    digest: params.digest && !coin,
    cacheKey,
    scope,
    query: providerQuery,
    range: dateRange,
  });
  const staticFallbackAllowed = process.env.NODE_ENV === 'test';
  const fallbackUsed = external.items.length === 0 && staticFallbackAllowed;
  const sourceItems = fallbackUsed ? [...fallbackNewsItems] : external.items;
  let filteredBase = filterMarketItems(sortPublishedDesc(sourceItems), {
    category,
    dateRange,
    from: params.from?.trim(),
    to: params.to?.trim(),
  }).filter((item) => scope === 'coin' || itemLooksLikeCryptoMarketNews(item));
  const latestAvailableDate = sourceItems
    .map((item) => item.publishedAt.slice(0, 10))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  let fallbackDate: string | null = null;
  let fallbackUsedForDate = false;
  if (date && params.fallback && filteredBase.length === 0 && latestAvailableDate && latestAvailableDate !== date) {
    const fallbackRange = kstDateToUtcRange(latestAvailableDate);
    filteredBase = filterMarketItems(sortPublishedDesc(sourceItems), {
      category,
      dateRange: fallbackRange,
      from: undefined,
      to: undefined,
    }).filter((item) => scope === 'coin' || itemLooksLikeCryptoMarketNews(item));
    fallbackDate = latestAvailableDate;
    fallbackUsedForDate = filteredBase.length > 0;
  }
  if (scope === 'coin' && filteredBase.length === 0 && staticFallbackAllowed) {
    filteredBase = filterMarketItems(sortPublishedDesc(fallbackNewsItems), {
      category,
      dateRange,
      from: params.from?.trim(),
      to: params.to?.trim(),
    }).filter((item) => itemLooksLikeCryptoMarketNews(item));
  }

  if (scope === 'coin') {
    const metadata = coinMetadata ?? {
      symbol: coin,
      coinName,
      providerId: null,
      keywords: uniqueStrings([coinName, ...builtInCoinAliases(coin, coinName, null)]),
    };
    const scored = filteredBase
      .map((item) => ({ id: item.id, item, relevanceScore: coinRelevanceScoreForItem(item, metadata) }))
      .filter((entry) => entry.relevanceScore >= 0.7);
    const direct = scored
      .filter((entry) => entry.relevanceScore >= 0.7)
      .sort((left, right) => compareNewsItems(left.item, right.item, appliedSort, (item) => coinRelevanceScoreForItem(item, metadata)));
    const related = scored
      .filter((entry) => entry.relevanceScore < 0.7)
      .sort((left, right) => compareNewsItems(left.item, right.item, appliedSort, (item) => coinRelevanceScoreForItem(item, metadata)));
    const filteredOutCount = filteredBase.length - direct.length - related.length;
    const directPage = paginate(direct, params.cursor, limit);
    const relatedItems = related.slice(0, Math.min(limit, 10)).map((entry) => projectNewsItem(entry.item, 'coin', entry.relevanceScore));
    const projectedItems = directPage.page.map((entry) => projectNewsItem(entry.item, 'coin', entry.relevanceScore));
    const emptyReason = projectedItems.length === 0
      ? relatedItems.length > 0
        ? 'NO_DIRECT_COIN_NEWS'
        : 'NO_RELATED_COIN_NEWS'
      : null;
    const reason = fallbackUsedForDate
      ? 'no_news_for_requested_date_using_latest_available'
      : projectedItems.length === 0
      ? external.reason === 'provider_limit_and_cache_empty'
        ? 'provider_limit_and_cache_empty'
        : external.reason === 'provider_error'
          ? 'provider_error'
          : 'no_related_news'
      : external.reason === 'using_stale_cache' ? 'using_stale_cache' : null;
    const status = sourceStatus({
      externalConfigured: external.externalConfigured,
      externalAvailable: external.externalAvailable,
      providers: external.providers,
      fallbackUsed: fallbackUsed || external.cacheHit,
      fallbackCount: fallbackUsed ? fallbackNewsItems.length : 0,
      externalCount: external.externalCount,
    });
    logger.info(
      { domain: 'coin-news', provider: status.providers[0] ?? 'cryptory_research', configured: status.externalConfigured, status: status.externalAvailable ? 'success' : 'fallback', fetchedCount: external.externalCount },
      `[CoinNewsProvider] provider=${status.providers[0] ?? 'cryptory_research'} configured=${status.externalConfigured} status=${status.externalAvailable ? 'success' : 'fallback'} fetchedCount=${external.externalCount}`,
    );
    logger.info(
      { domain: 'coin-news', symbol: coin, coinName, keywords: metadata.keywords, directCount: direct.length, relatedCount: related.length, filteredOutCount, strategy: 'metadata_keywords,relevance_score' },
      `[CoinNewsMatch] symbol=${coin} directCount=${direct.length} relatedCount=${related.length} filteredOutCount=${filteredOutCount} strategy=metadata_keywords,relevance_score`,
    );
    logger.info(
      { domain: 'coin-news', symbol: coin, itemCount: projectedItems.length, relatedCount: relatedItems.length, emptyReason, fallbackUsed },
      `[CoinNewsResponse] symbol=${coin} itemCount=${projectedItems.length} relatedCount=${relatedItems.length} emptyReason=${emptyReason ?? ''} fallbackUsed=${fallbackUsed}`,
    );
    return {
      scope,
      symbol: coin,
      coinName,
      requestedDate: date,
      resolvedRange: dateRange,
      provider: status.providers[0] ?? (fallbackUsed ? 'cryptory_research' : null),
      sourceStatus: status,
      providerStatus: external.providerStatus,
      source: external.cacheHit ? 'cache' : fallbackUsed ? 'fallback' : status.providers[0] ?? 'none',
      cacheHit: external.cacheHit,
      fallbackUsed: fallbackUsedForDate,
      fallbackDate,
      latestAvailableDate,
      items: projectedItems,
      relatedItems,
      pagination: {
        nextCursor: directPage.nextCursor,
        hasMore: directPage.hasMore,
      },
      emptyState: {
        isEmpty: projectedItems.length === 0,
        reason: emptyReason,
      },
      reason,
      date: date ?? new Date().toISOString().slice(0, 10),
      sort: appliedSort,
      updatedAt: external.cacheUpdatedAt ?? new Date().toISOString(),
      nextCursor: directPage.nextCursor,
    };
  }

  const sortedMarketItems = [...filteredBase].sort((left, right) => compareNewsItems(left, right, appliedSort, () => 0.8));
  const paginated = paginate(sortedMarketItems, params.cursor, limit);
  const projectedItems = paginated.page.map((item) => projectNewsItem(item, 'market'));
  const reason = fallbackUsedForDate
    ? 'no_news_for_requested_date_using_latest_available'
    : projectedItems.length === 0
      ? date
        ? 'no_news_for_date'
        : external.reason ?? 'cache_empty'
      : external.reason === 'using_stale_cache' ? 'using_stale_cache' : null;
  const status = sourceStatus({
    externalConfigured: external.externalConfigured,
    externalAvailable: external.externalAvailable,
    providers: external.providers,
    fallbackUsed: fallbackUsed || external.cacheHit,
    fallbackCount: fallbackUsed ? fallbackNewsItems.length : 0,
    externalCount: external.externalCount,
  });
  const latestPublishedAt = projectedItems[0]?.publishedAt ?? null;
  logger.info(
    {
      domain: 'news',
      itemCount: projectedItems.length,
      externalCount: status.externalCount,
      fallbackCount: status.fallbackCount,
      providers: status.providers,
      latestPublishedAt,
    },
    `[NewsResponse] itemCount=${projectedItems.length} externalCount=${status.externalCount} fallbackCount=${status.fallbackCount} providers=${status.providers.join(',')} latestPublishedAt=${latestPublishedAt ?? ''}`,
  );
  return {
    scope,
    sourceStatus: status,
    providerStatus: external.providerStatus,
    source: external.cacheHit ? 'cache' : fallbackUsed ? 'fallback' : status.providers[0] ?? 'none',
    cacheHit: external.cacheHit,
    requestedDate: date,
    resolvedRange: dateRange,
    latestAvailableDate,
    fallbackUsed: fallbackUsedForDate,
    fallbackDate,
    items: projectedItems,
    pagination: {
      nextCursor: paginated.nextCursor,
      hasMore: paginated.hasMore,
    },
    emptyState: {
      isEmpty: projectedItems.length === 0,
      reason: projectedItems.length === 0 ? 'NO_MARKET_NEWS' : null,
    },
    reason,
    date: date ?? new Date().toISOString().slice(0, 10),
    sort: appliedSort,
    updatedAt: external.cacheUpdatedAt ?? new Date().toISOString(),
    nextCursor: paginated.nextCursor,
  };
}

export function getNewsById(newsId: string) {
  const item = fallbackNewsItems.find((candidate) => candidate.id === newsId);
  if (!item) {
    return null;
  }

  return {
    ...projectNewsItem(item, 'market'),
  };
}

export async function summarizeNews(params: {
  date?: string;
  targetLanguage?: string;
}) {
  const date = params.date?.trim();
  const targetLanguage = params.targetLanguage?.trim().toLowerCase() || 'ko';
  const news = await listNews({
    date,
    limit: 5,
    digest: true,
  });
  return {
    items: news.items.slice(0, 5).map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      translatedTitle: null,
      translatedSummary: null,
      sourceName: item.sourceName ?? item.source,
      originalUrl: item.originalUrl ?? item.url,
      publishedAt: item.publishedAt,
      language: item.language ?? 'en',
    })),
    date: date ?? new Date().toISOString().slice(0, 10),
    source: news.source,
    cacheHit: news.cacheHit,
    reason: news.items.length === 0 ? news.reason ?? 'summary_empty' : null,
    updatedAt: news.updatedAt,
    translated: false,
    targetLanguage,
  };
}
