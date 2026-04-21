import type { ExchangeId } from './exchange.types';

export type AssetType = 'crypto' | 'stablecoin' | 'wrapped' | 'fiat' | 'synthetic' | 'exchange_only' | 'unknown';
export type AssetImagePolicy = 'metadata' | 'underlying' | 'fiat_initials' | 'placeholder';

export type AssetRegistryEntry = {
  canonicalAssetKey: string;
  canonicalName: string;
  assetType: AssetType;
  aliases?: string[];
  underlyingAssetKey?: string;
  brandColor?: string;
  initials?: string;
  imagePolicy?: AssetImagePolicy;
};

export const QUOTE_ASSET_TOKENS = [
  'FDUSD',
  'USDT',
  'USDC',
  'BUSD',
  'TUSD',
  'USDP',
  'DAI',
  'USD',
  'KRW',
  'BTC',
  'ETH',
  'BNB',
  'EUR',
  'TRY',
  'BRL',
] as const;

export const ASSET_REGISTRY: Record<string, AssetRegistryEntry> = {
  BTC: {
    canonicalAssetKey: 'BTC',
    canonicalName: 'Bitcoin',
    assetType: 'crypto',
    aliases: ['bitcoin', 'xbt'],
    brandColor: '#F7931A',
    initials: 'BTC',
  },
  ETH: {
    canonicalAssetKey: 'ETH',
    canonicalName: 'Ethereum',
    assetType: 'crypto',
    aliases: ['ethereum'],
    brandColor: '#627EEA',
    initials: 'ETH',
  },
  USDT: {
    canonicalAssetKey: 'USDT',
    canonicalName: 'Tether USDt',
    assetType: 'stablecoin',
    aliases: ['tether', 'tether usd', 'usd tether'],
    brandColor: '#26A17B',
    initials: 'USDT',
  },
  USDC: {
    canonicalAssetKey: 'USDC',
    canonicalName: 'USD Coin',
    assetType: 'stablecoin',
    aliases: ['usd coin', 'usdc.e', 'usdce'],
    brandColor: '#2775CA',
    initials: 'USDC',
  },
  FDUSD: {
    canonicalAssetKey: 'FDUSD',
    canonicalName: 'First Digital USD',
    assetType: 'stablecoin',
    aliases: ['first digital usd', 'firstdigitalusd'],
    brandColor: '#1B4D89',
    initials: 'FD',
  },
  RLUSD: {
    canonicalAssetKey: 'RLUSD',
    canonicalName: 'Ripple USD',
    assetType: 'stablecoin',
    aliases: ['ripple usd', 'rippleusd'],
    brandColor: '#23292F',
    initials: 'RL',
  },
  USD1: {
    canonicalAssetKey: 'USD1',
    canonicalName: 'USD1',
    assetType: 'stablecoin',
    aliases: ['world liberty financial usd', 'world liberty usd', 'usd1'],
    brandColor: '#1F6FEB',
    initials: 'U1',
  },
  DAI: {
    canonicalAssetKey: 'DAI',
    canonicalName: 'Dai',
    assetType: 'stablecoin',
    aliases: ['dai stablecoin'],
    brandColor: '#F5AC37',
    initials: 'DAI',
  },
  BUSD: {
    canonicalAssetKey: 'BUSD',
    canonicalName: 'Binance USD',
    assetType: 'stablecoin',
    aliases: ['binance usd'],
    brandColor: '#F0B90B',
    initials: 'BUSD',
  },
  TUSD: {
    canonicalAssetKey: 'TUSD',
    canonicalName: 'TrueUSD',
    assetType: 'stablecoin',
    aliases: ['true usd', 'trueusd'],
    brandColor: '#2B6DEF',
    initials: 'TUSD',
  },
  WBTC: {
    canonicalAssetKey: 'WBTC',
    canonicalName: 'Wrapped Bitcoin',
    assetType: 'wrapped',
    aliases: ['wrapped bitcoin', 'wrapped btc'],
    underlyingAssetKey: 'BTC',
    brandColor: '#F7931A',
    initials: 'WBTC',
    imagePolicy: 'underlying',
  },
  WETH: {
    canonicalAssetKey: 'WETH',
    canonicalName: 'Wrapped Ether',
    assetType: 'wrapped',
    aliases: ['wrapped ether', 'wrapped ethereum'],
    underlyingAssetKey: 'ETH',
    brandColor: '#627EEA',
    initials: 'WETH',
    imagePolicy: 'underlying',
  },
  WBNB: {
    canonicalAssetKey: 'WBNB',
    canonicalName: 'Wrapped BNB',
    assetType: 'wrapped',
    aliases: ['wrapped bnb'],
    underlyingAssetKey: 'BNB',
    brandColor: '#F0B90B',
    initials: 'WBNB',
    imagePolicy: 'underlying',
  },
  USD: {
    canonicalAssetKey: 'USD',
    canonicalName: 'US Dollar',
    assetType: 'fiat',
    aliases: ['us dollar', 'dollar'],
    brandColor: '#2E7D32',
    initials: '$',
    imagePolicy: 'fiat_initials',
  },
  KRW: {
    canonicalAssetKey: 'KRW',
    canonicalName: 'Korean Won',
    assetType: 'fiat',
    aliases: ['korean won'],
    brandColor: '#3949AB',
    initials: 'KRW',
    imagePolicy: 'fiat_initials',
  },
  EUR: {
    canonicalAssetKey: 'EUR',
    canonicalName: 'Euro',
    assetType: 'fiat',
    aliases: ['euro'],
    brandColor: '#1A5FB4',
    initials: 'EUR',
    imagePolicy: 'fiat_initials',
  },
};

const GENERIC_ASSET_ALIASES: Record<string, string> = {
  XBT: 'BTC',
  XDG: 'DOGE',
  BCC: 'BCH',
  BCHABC: 'BCH',
  RNDR: 'RENDER',
  RENDERTOKEN: 'RENDER',
  POLYGON: 'POL',
  USDCE: 'USDC',
  USDC_E: 'USDC',
  USDTE: 'USDT',
  FIRSTDIGITALUSD: 'FDUSD',
  RIPPLEUSD: 'RLUSD',
  WORLDLIBERTYFINANCIALUSD: 'USD1',
  WORLDLIBERTYUSD: 'USD1',
  WBTC: 'BTC',
  WETH: 'ETH',
  WBETH: 'ETH',
  STETH: 'ETH',
  WSTETH: 'ETH',
  BETH: 'ETH',
  WBNB: 'BNB',
  WMATIC: 'POL',
  BTTC: 'BTT',
  BTTOLD: 'BTT',
  LUNA2: 'LUNA',
  LUNANEW: 'LUNA',
  LUNAOLD: 'LUNC',
  GAL: 'G',
  VAULTA: 'A',
  THRESHOLD: 'T',
  WORMHOLE: 'W',
  S: 'SONIC',
};

const COMMON_EXCHANGE_ASSET_ALIASES: Record<string, string> = {
  RNDR: 'RENDER',
  RENDERTOKEN: 'RENDER',
  POLYGON: 'POL',
  USDCE: 'USDC',
  USDC_E: 'USDC',
  USDTE: 'USDT',
  BTTOLD: 'BTT',
  BTTC: 'BTT',
  GAL: 'G',
  VAULTA: 'A',
  THRESHOLD: 'T',
  WORMHOLE: 'W',
};

export const EXCHANGE_ASSET_ALIASES: Partial<Record<ExchangeId, Record<string, string>>> = {
  upbit: {
    ...COMMON_EXCHANGE_ASSET_ALIASES,
    A: 'A',
    G: 'G',
    S: 'SONIC',
    T: 'T',
    W: 'W',
  },
  bithumb: {
    ...COMMON_EXCHANGE_ASSET_ALIASES,
    A: 'A',
    G: 'G',
    S: 'SONIC',
    T: 'T',
    W: 'W',
  },
  coinone: {
    ...COMMON_EXCHANGE_ASSET_ALIASES,
    A: 'A',
    G: 'G',
    S: 'SONIC',
    T: 'T',
    W: 'W',
  },
  korbit: {
    ...COMMON_EXCHANGE_ASSET_ALIASES,
    A: 'A',
    G: 'G',
    S: 'SONIC',
    T: 'T',
    W: 'W',
  },
  binance: {
    ...COMMON_EXCHANGE_ASSET_ALIASES,
    '1000SHIB': 'SHIB',
    '1000PEPE': 'PEPE',
    '1000BONK': 'BONK',
    '1000FLOKI': 'FLOKI',
    '1000LUNC': 'LUNC',
    '1000SATS': 'SATS',
    '1000XEC': 'XEC',
    '1000CAT': 'CAT',
    '1000CHEEMS': 'CHEEMS',
    '1000MOG': 'MOG',
    '1000RATS': 'RATS',
    '1000TOSHI': 'TOSHI',
    '1000WHY': 'WHY',
    '1000000MOG': 'MOG',
    '1MBABYDOGE': 'BABYDOGE',
    S: 'SONIC',
  },
};

export function normalizeAssetToken(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

export function compactAssetToken(value: string) {
  return normalizeAssetToken(value).replace(/[^A-Z0-9]+/g, '');
}

function buildRegistryAliasMap() {
  const aliases: Record<string, string> = { ...GENERIC_ASSET_ALIASES };
  for (const [canonicalAssetKey, entry] of Object.entries(ASSET_REGISTRY)) {
    aliases[compactAssetToken(canonicalAssetKey)] ??= entry.canonicalAssetKey;
    for (const alias of entry.aliases ?? []) {
      aliases[compactAssetToken(alias)] ??= entry.canonicalAssetKey;
    }
  }
  return aliases;
}

const REGISTRY_ALIAS_MAP = buildRegistryAliasMap();

export function isKnownQuoteAssetToken(value: string) {
  const compact = compactAssetToken(value);
  return QUOTE_ASSET_TOKENS.includes(compact as (typeof QUOTE_ASSET_TOKENS)[number]);
}

export function resolveAssetAliasCandidate(candidate: string, exchange?: ExchangeId) {
  const direct = normalizeAssetToken(candidate);
  const compact = compactAssetToken(candidate);
  const exchangeAliases = exchange ? EXCHANGE_ASSET_ALIASES[exchange] : undefined;
  const exchangeAlias = exchangeAliases?.[direct] ?? exchangeAliases?.[compact];
  if (exchangeAlias) {
    return {
      canonicalAssetKey: exchangeAlias,
      matchedBy: 'exchange_alias' as const,
    };
  }

  const genericAlias = REGISTRY_ALIAS_MAP[direct] ?? REGISTRY_ALIAS_MAP[compact];
  if (genericAlias && genericAlias !== compact) {
    return {
      canonicalAssetKey: genericAlias,
      matchedBy: 'global_alias' as const,
    };
  }

  const multiplierMatch = compact.match(/^\d+(SHIB|PEPE|BONK|FLOKI|LUNC|SATS|XEC|CAT|CHEEMS|MOG|RATS|TOSHI|WHY)$/);
  if (multiplierMatch) {
    return {
      canonicalAssetKey: multiplierMatch[1],
      matchedBy: exchange ? 'exchange_alias' as const : 'global_alias' as const,
    };
  }

  return null;
}

export function splitKnownQuotePair(value: string) {
  const compact = compactAssetToken(value);
  if (!compact || ASSET_REGISTRY[compact] || REGISTRY_ALIAS_MAP[compact]) {
    return null;
  }

  for (const quoteAsset of QUOTE_ASSET_TOKENS) {
    if (compact.length > quoteAsset.length && compact.endsWith(quoteAsset)) {
      return {
        baseAsset: compact.slice(0, -quoteAsset.length),
        quoteAsset,
        quotePosition: 'suffix' as const,
      };
    }
  }

  for (const quoteAsset of QUOTE_ASSET_TOKENS) {
    if (compact.length > quoteAsset.length && compact.startsWith(quoteAsset)) {
      return {
        baseAsset: compact.slice(quoteAsset.length),
        quoteAsset,
        quotePosition: 'prefix' as const,
      };
    }
  }

  return null;
}

export function getAssetRegistryMetadata(canonicalAssetKey?: string | null, originalSymbol?: string | null) {
  const canonical = canonicalAssetKey ? compactAssetToken(canonicalAssetKey) : '';
  const original = originalSymbol ? compactAssetToken(originalSymbol) : '';
  const direct = canonical ? ASSET_REGISTRY[canonical] : undefined;
  const originalEntry = original ? ASSET_REGISTRY[original] : undefined;

  const entry = originalEntry ?? direct;
  if (!entry) {
    return {
      assetType: 'unknown' as const,
      canonicalName: canonicalAssetKey ?? originalSymbol ?? null,
      fallbackColor: '#64748B',
      fallbackInitials: (canonicalAssetKey ?? originalSymbol ?? '?').slice(0, 4).toUpperCase(),
      imagePolicy: 'metadata' as AssetImagePolicy,
      underlyingAssetKey: null,
    };
  }

  return {
    assetType: entry.assetType,
    canonicalName: entry.canonicalName,
    fallbackColor: entry.brandColor ?? '#64748B',
    fallbackInitials: entry.initials ?? entry.canonicalAssetKey.slice(0, 4),
    imagePolicy: entry.imagePolicy ?? 'metadata',
    underlyingAssetKey: entry.underlyingAssetKey ?? null,
  };
}

export function containsNonAsciiAssetText(value?: string | null) {
  return Boolean(value && /[^\x00-\x7F]/.test(value));
}
