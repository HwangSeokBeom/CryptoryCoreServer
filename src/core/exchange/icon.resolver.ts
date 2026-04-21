function buildIconUrl(symbol: string) {
  return `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${symbol}.png`;
}

export const DEFAULT_COIN_PLACEHOLDER_ICON_URL = buildIconUrl('generic');

const CURATED_ICON_URLS: Record<string, string> = {
  BTC: buildIconUrl('btc'),
  ETH: buildIconUrl('eth'),
  XRP: buildIconUrl('xrp'),
  SOL: buildIconUrl('sol'),
  DOGE: buildIconUrl('doge'),
  ADA: buildIconUrl('ada'),
  AVAX: buildIconUrl('avax'),
  DOT: buildIconUrl('dot'),
  MATIC: buildIconUrl('matic'),
  LINK: buildIconUrl('link'),
  ATOM: buildIconUrl('atom'),
  UNI: buildIconUrl('uni'),
  SAND: buildIconUrl('sand'),
  SHIB: buildIconUrl('shib'),
  APT: buildIconUrl('apt'),
};

function normalizeIconSymbol(symbol: string) {
  return symbol.trim().toUpperCase().replace(/\s+/g, '');
}

class IconResolver {
  private readonly memoryCache = new Map<string, string | null>();

  resolveIconUrl(canonicalSymbol: string): string | null {
    const normalized = normalizeIconSymbol(canonicalSymbol);
    if (!normalized) {
      return null;
    }

    if (this.memoryCache.has(normalized)) {
      return this.memoryCache.get(normalized) ?? null;
    }

    const resolved = CURATED_ICON_URLS[normalized] ?? null;
    this.memoryCache.set(normalized, resolved);
    return resolved;
  }

  primeForTests(entries: Record<string, string | null>) {
    for (const [symbol, iconUrl] of Object.entries(entries)) {
      this.memoryCache.set(normalizeIconSymbol(symbol), iconUrl);
    }
  }

  resetForTests() {
    this.memoryCache.clear();
  }
}

export const iconResolver = new IconResolver();

export function resolveIconUrl(canonicalSymbol: string): string | null {
  return iconResolver.resolveIconUrl(canonicalSymbol);
}
