import { COINS } from '../../config/constants';
import { getReferenceTicker } from './market-data.service';
import { logger } from '../../utils/logger';

export type MarketThemeItem = {
  id: string;
  name: string;
  change24h: number | null;
  marketCap: number | null;
  symbols: string[];
};

export type MarketThemesResponse = {
  items: MarketThemeItem[];
  updatedAt: string;
};

const THEME_DEFINITIONS = [
  {
    id: 'layer1',
    name: 'Layer 1',
    symbols: ['BTC', 'ETH', 'SOL', 'ADA', 'AVAX', 'DOT', 'ATOM', 'APT'],
  },
  {
    id: 'defi',
    name: 'DeFi',
    symbols: ['UNI', 'LINK'],
  },
  {
    id: 'meme',
    name: 'Meme',
    symbols: ['DOGE', 'SHIB'],
  },
  {
    id: 'metaverse',
    name: 'Metaverse',
    symbols: ['SAND'],
  },
] as const;

function toFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function getSymbolChange24h(symbol: string) {
  try {
    const ticker = await getReferenceTicker(symbol);
    return toFiniteNumber(ticker?.change24h);
  } catch (error) {
    logger.warn({ domain: 'market-themes', symbol, err: error }, 'Theme ticker lookup failed');
    return null;
  }
}

function average(values: number[]) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function getMarketThemes(): Promise<MarketThemesResponse> {
  const availableSymbols = new Set(COINS.map((coin) => coin.symbol));
  const items: Array<MarketThemeItem | null> = await Promise.all(
    THEME_DEFINITIONS.map(async (theme) => {
      const symbols = theme.symbols.filter((symbol) => availableSymbols.has(symbol));
      if (symbols.length === 0) {
        return null;
      }

      const changes = await Promise.all(symbols.map((symbol) => getSymbolChange24h(symbol)));
      return {
        id: theme.id,
        name: theme.name,
        change24h: average(changes.filter((value): value is number => value !== null)),
        marketCap: null,
        symbols,
      } satisfies MarketThemeItem;
    }),
  );

  return {
    items: items.filter((item): item is MarketThemeItem => item !== null),
    updatedAt: new Date().toISOString(),
  };
}
