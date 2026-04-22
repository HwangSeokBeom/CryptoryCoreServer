import type { ExchangeId } from './exchange.types';

export type AssetType = 'crypto' | 'stablecoin' | 'wrapped' | 'fiat' | 'synthetic' | 'exchange_only' | 'unknown';
export type AssetImagePolicy = 'metadata' | 'underlying' | 'fiat_initials' | 'placeholder';

export type AssetRegistryEntry = {
  canonicalAssetKey: string;
  canonicalName: string;
  assetType: AssetType;
  aliases?: string[];
  assetSlug?: string;
  coingeckoId?: string;
  imageFallbackKey?: string;
  underlyingAssetKey?: string;
  brandColor?: string;
  initials?: string;
  imagePolicy?: AssetImagePolicy;
};

export type AssetImageResolutionSource =
  | 'registry_direct'
  | 'registry_underlying'
  | 'exchange_image_alias_override'
  | 'image_alias_override'
  | 'numeric_multiplier_variant'
  | 'ultra_short_override'
  | 'branded_override'
  | 'fiat_or_quote_policy'
  | 'fallback_registry_slug'
  | 'unresolved';

export type AssetImageResolutionStage =
  | 'canonical_resolved'
  | 'registry_identity'
  | 'preferred_image'
  | 'fallback_only';

export type AssetImageMissingReason =
  | 'missing_curated_mapping'
  | 'missing_preferred_slug'
  | 'missing_registry_image_metadata'
  | 'ambiguous_short_symbol'
  | 'unresolved_numeric_variant'
  | 'unresolved_branded_variant'
  | 'fiat_or_quote_like_symbol'
  | 'intentionally_fallback_only'
  | 'curated_slug_resolved_but_metadata_missing'
  | 'curated_slug_resolved_but_cache_stale'
  | 'curated_slug_resolved_but_projection_not_promoted'
  | 'curated_slug_resolved_but_source_merge_failed'
  | 'source_metadata_absent';

export type PreferredAssetImageIdentity = {
  canonicalAssetKey: string | null;
  preferredImageSymbol: string | null;
  preferredImageSlug: string | null;
  preferredImageCoingeckoId: string | null;
  resolutionSource: AssetImageResolutionSource;
  resolutionStage: AssetImageResolutionStage;
  imageMissingReason: AssetImageMissingReason | null;
  fallbackOnly: boolean;
  manualCurationRecommended: boolean;
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
  USDS: {
    canonicalAssetKey: 'USDS',
    canonicalName: 'USDS',
    assetType: 'stablecoin',
    aliases: ['usds', 'sky dollar'],
    assetSlug: 'usds',
    coingeckoId: 'usds',
    brandColor: '#1F6FEB',
    initials: 'USDS',
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
    assetSlug: 'true-usd',
    coingeckoId: 'true-usd',
    brandColor: '#2B6DEF',
    initials: 'TUSD',
  },
  BFUSD: {
    canonicalAssetKey: 'BFUSD',
    canonicalName: 'BFUSD',
    assetType: 'stablecoin',
    aliases: ['bfusd', 'binance fixed rate usd'],
    assetSlug: 'bfusd',
    coingeckoId: 'bfusd',
    brandColor: '#F0B90B',
    initials: 'BF',
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
  A: {
    canonicalAssetKey: 'A',
    canonicalName: 'Vaulta',
    assetType: 'crypto',
    aliases: ['vaulta'],
    assetSlug: 'vaulta',
    coingeckoId: 'vaulta',
    brandColor: '#111827',
    initials: 'A',
  },
  G: {
    canonicalAssetKey: 'G',
    canonicalName: 'Gravity',
    assetType: 'crypto',
    aliases: ['gravity', 'gravity by galxe', 'g token'],
    assetSlug: 'g-token',
    coingeckoId: 'g-token',
    brandColor: '#111827',
    initials: 'G',
  },
  T: {
    canonicalAssetKey: 'T',
    canonicalName: 'Threshold',
    assetType: 'crypto',
    aliases: ['threshold', 'threshold network'],
    assetSlug: 'threshold-network-token',
    coingeckoId: 'threshold-network-token',
    brandColor: '#111827',
    initials: 'T',
  },
  W: {
    canonicalAssetKey: 'W',
    canonicalName: 'Wormhole',
    assetType: 'crypto',
    aliases: ['wormhole'],
    assetSlug: 'wormhole',
    coingeckoId: 'wormhole',
    brandColor: '#111827',
    initials: 'W',
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
  '0G': {
    canonicalAssetKey: '0G',
    canonicalName: '0G',
    assetType: 'crypto',
    aliases: ['zero gravity', '0g'],
    assetSlug: 'zero-gravity',
    coingeckoId: 'zero-gravity',
    brandColor: '#111827',
    initials: '0G',
  },
  A8: {
    canonicalAssetKey: 'A8',
    canonicalName: 'Ancient8',
    assetType: 'crypto',
    aliases: ['ancient8', 'ancient 8'],
    assetSlug: 'ancient8',
    coingeckoId: 'ancient8',
    brandColor: '#111827',
    initials: 'A8',
  },
  B3: {
    canonicalAssetKey: 'B3',
    canonicalName: 'B3',
    assetType: 'crypto',
    aliases: ['b3', 'b3 base'],
    assetSlug: 'b3',
    coingeckoId: 'b3',
    brandColor: '#111827',
    initials: 'B3',
  },
  C: {
    canonicalAssetKey: 'C',
    canonicalName: 'Chainbase',
    assetType: 'crypto',
    aliases: ['chainbase', 'chainbase token'],
    assetSlug: 'chainbase',
    coingeckoId: 'chainbase',
    brandColor: '#111827',
    initials: 'C',
  },
  D: {
    canonicalAssetKey: 'D',
    canonicalName: 'DAR Open Network',
    assetType: 'crypto',
    aliases: ['dar open network'],
    assetSlug: 'dar-open-network',
    coingeckoId: 'dar-open-network',
    brandColor: '#111827',
    initials: 'D',
  },
  F: {
    canonicalAssetKey: 'F',
    canonicalName: 'SynFutures',
    assetType: 'crypto',
    aliases: ['synfutures', 'syn futures'],
    assetSlug: 'synfutures',
    coingeckoId: 'synfutures',
    brandColor: '#111827',
    initials: 'F',
  },
  FCT2: {
    canonicalAssetKey: 'FCT2',
    canonicalName: 'Firmachain',
    assetType: 'crypto',
    aliases: ['firmachain', 'fct'],
    assetSlug: 'firmachain',
    coingeckoId: 'firmachain',
    brandColor: '#111827',
    initials: 'FCT',
  },
  H: {
    canonicalAssetKey: 'H',
    canonicalName: 'Humanity',
    assetType: 'crypto',
    aliases: ['humanity'],
    assetSlug: 'humanity',
    coingeckoId: 'humanity',
    brandColor: '#111827',
    initials: 'H',
  },
  IN: {
    canonicalAssetKey: 'IN',
    canonicalName: 'INFINIT',
    assetType: 'crypto',
    aliases: ['infinit'],
    assetSlug: 'infinit',
    coingeckoId: 'infinit',
    brandColor: '#111827',
    initials: 'IN',
  },
  IP: {
    canonicalAssetKey: 'IP',
    canonicalName: 'Story',
    assetType: 'crypto',
    aliases: ['story'],
    assetSlug: 'story-2',
    coingeckoId: 'story-2',
    brandColor: '#111827',
    initials: 'IP',
  },
  LA: {
    canonicalAssetKey: 'LA',
    canonicalName: 'Lagrange',
    assetType: 'crypto',
    aliases: ['lagrange'],
    assetSlug: 'lagrange',
    coingeckoId: 'lagrange',
    brandColor: '#111827',
    initials: 'LA',
  },
  LM: {
    canonicalAssetKey: 'LM',
    canonicalName: 'LeisureMeta',
    assetType: 'crypto',
    aliases: ['leisuremeta', 'leisure meta'],
    assetSlug: 'leisuremeta',
    coingeckoId: 'leisuremeta',
    brandColor: '#111827',
    initials: 'LM',
  },
  MAY: {
    canonicalAssetKey: 'MAY',
    canonicalName: 'Mayflower',
    assetType: 'crypto',
    aliases: ['mayflower'],
    assetSlug: 'neopin',
    coingeckoId: 'neopin',
    brandColor: '#111827',
    initials: 'MAY',
  },
  ME: {
    canonicalAssetKey: 'ME',
    canonicalName: 'Magic Eden',
    assetType: 'crypto',
    aliases: ['magic eden'],
    assetSlug: 'magic-eden',
    coingeckoId: 'magic-eden',
    brandColor: '#111827',
    initials: 'ME',
  },
  YB: {
    canonicalAssetKey: 'YB',
    canonicalName: 'Yield Basis',
    assetType: 'crypto',
    aliases: ['yieldbasis', 'yield basis'],
    assetSlug: 'yield-basis',
    coingeckoId: 'yield-basis',
    brandColor: '#111827',
    initials: 'YB',
  },
  ZBT: {
    canonicalAssetKey: 'ZBT',
    canonicalName: 'ZEROBASE',
    assetType: 'crypto',
    aliases: ['zerobase', 'zero base'],
    assetSlug: 'zerobase',
    coingeckoId: 'zerobase',
    brandColor: '#111827',
    initials: 'ZBT',
  },
  SONICSVM: {
    canonicalAssetKey: 'SONICSVM',
    canonicalName: 'Sonic SVM',
    assetType: 'crypto',
    aliases: ['sonic svm'],
    assetSlug: 'sonic-svm',
    coingeckoId: 'sonic-svm',
    brandColor: '#111827',
    initials: 'SONIC',
  },
  SONIC: {
    canonicalAssetKey: 'SONIC',
    canonicalName: 'Sonic',
    assetType: 'crypto',
    aliases: ['ftm sonic'],
    assetSlug: 'sonic-3',
    coingeckoId: 'sonic-3',
    brandColor: '#00AEEF',
    initials: 'S',
  },
  API3: {
    canonicalAssetKey: 'API3',
    canonicalName: 'Api3',
    assetType: 'crypto',
    aliases: ['api3'],
    assetSlug: 'api3',
    coingeckoId: 'api3',
    brandColor: '#6D46FF',
    initials: 'API3',
  },
  SIGN: {
    canonicalAssetKey: 'SIGN',
    canonicalName: 'Sign',
    assetType: 'crypto',
    aliases: ['sign protocol', 'sign global'],
    assetSlug: 'sign-global',
    coingeckoId: 'sign-global',
    brandColor: '#111827',
    initials: 'SIGN',
  },
  '2Z': {
    canonicalAssetKey: '2Z',
    canonicalName: 'DoubleZero',
    assetType: 'crypto',
    aliases: ['doublezero', 'double zero'],
    assetSlug: 'doublezero',
    coingeckoId: 'doublezero',
    brandColor: '#2563EB',
    initials: '2Z',
  },
  ZKC: {
    canonicalAssetKey: 'ZKC',
    canonicalName: 'Boundless',
    assetType: 'crypto',
    aliases: ['boundless', 'zkc'],
    assetSlug: 'boundless',
    coingeckoId: 'boundless',
    brandColor: '#7C3AED',
    initials: 'ZKC',
  },
  WLFI: {
    canonicalAssetKey: 'WLFI',
    canonicalName: 'World Liberty Financial',
    assetType: 'crypto',
    aliases: ['world liberty financial'],
    assetSlug: 'world-liberty-financial',
    coingeckoId: 'world-liberty-financial',
    brandColor: '#1D4ED8',
    initials: 'WLFI',
  },
  FF: {
    canonicalAssetKey: 'FF',
    canonicalName: 'Falcon Finance',
    assetType: 'crypto',
    aliases: ['falcon finance'],
    assetSlug: 'falcon-finance-ff',
    coingeckoId: 'falcon-finance-ff',
    brandColor: '#0F766E',
    initials: 'FF',
  },
  GAME2: {
    canonicalAssetKey: 'GAME2',
    canonicalName: 'GameBuild',
    assetType: 'crypto',
    aliases: ['gamebuild', 'game build', 'game2'],
    assetSlug: 'gamebuild',
    coingeckoId: 'gamebuild',
    brandColor: '#EA580C',
    initials: 'G2',
  },
  CORE: {
    canonicalAssetKey: 'CORE',
    canonicalName: 'Core',
    assetType: 'crypto',
    aliases: ['core dao', 'coredao'],
    assetSlug: 'coredaoorg',
    coingeckoId: 'coredaoorg',
    brandColor: '#FFB000',
    initials: 'CORE',
  },
  CHIP: {
    canonicalAssetKey: 'CHIP',
    canonicalName: 'USDai',
    assetType: 'stablecoin',
    aliases: ['usd.ai', 'usdai'],
    assetSlug: 'usdai',
    coingeckoId: 'usdai',
    brandColor: '#111827',
    initials: 'USD',
  },
  BIO: {
    canonicalAssetKey: 'BIO',
    canonicalName: 'Bio Protocol',
    assetType: 'crypto',
    aliases: ['bio protocol'],
    assetSlug: 'bio-protocol',
    coingeckoId: 'bio-protocol',
    brandColor: '#16A34A',
    initials: 'BIO',
  },
  CFG: {
    canonicalAssetKey: 'CFG',
    canonicalName: 'Centrifuge',
    assetType: 'crypto',
    aliases: ['centrifuge'],
    assetSlug: 'centrifuge-2',
    coingeckoId: 'centrifuge-2',
    brandColor: '#111827',
    initials: 'CFG',
  },
  SUPER: {
    canonicalAssetKey: 'SUPER',
    canonicalName: 'SuperVerse',
    assetType: 'crypto',
    aliases: ['superverse', 'superfarm'],
    assetSlug: 'superfarm',
    coingeckoId: 'superfarm',
    brandColor: '#7C3AED',
    initials: 'SUPER',
  },
  SENT: {
    canonicalAssetKey: 'SENT',
    canonicalName: 'Sentient',
    assetType: 'crypto',
    aliases: ['sentient'],
    assetSlug: 'sentient',
    coingeckoId: 'sentient',
    brandColor: '#111827',
    initials: 'SENT',
  },
  ONT: {
    canonicalAssetKey: 'ONT',
    canonicalName: 'Ontology',
    assetType: 'crypto',
    aliases: ['ontology'],
    assetSlug: 'ontology',
    coingeckoId: 'ontology',
    brandColor: '#32A4BE',
    initials: 'ONT',
  },
  XPL: {
    canonicalAssetKey: 'XPL',
    canonicalName: 'Plasma',
    assetType: 'crypto',
    aliases: ['plasma'],
    assetSlug: 'plasma',
    coingeckoId: 'plasma',
    brandColor: '#2563EB',
    initials: 'XPL',
  },
  OPEN: {
    canonicalAssetKey: 'OPEN',
    canonicalName: 'OpenLedger',
    assetType: 'crypto',
    aliases: ['openledger', 'open ledger'],
    assetSlug: 'openledger-2',
    coingeckoId: 'openledger-2',
    brandColor: '#111827',
    initials: 'OPEN',
  },
  TAO: {
    canonicalAssetKey: 'TAO',
    canonicalName: 'Bittensor',
    assetType: 'crypto',
    aliases: ['bittensor'],
    assetSlug: 'bittensor',
    coingeckoId: 'bittensor',
    brandColor: '#111827',
    initials: 'TAO',
  },
  WIF: {
    canonicalAssetKey: 'WIF',
    canonicalName: 'dogwifhat',
    assetType: 'crypto',
    aliases: ['dogwifhat', 'dog wif hat'],
    assetSlug: 'dogwifcoin',
    coingeckoId: 'dogwifcoin',
    brandColor: '#D97706',
    initials: 'WIF',
  },
  MOCA: {
    canonicalAssetKey: 'MOCA',
    canonicalName: 'Moca Network',
    assetType: 'crypto',
    aliases: ['mocaverse', 'moca network'],
    assetSlug: 'mocaverse',
    coingeckoId: 'mocaverse',
    brandColor: '#111827',
    initials: 'MOCA',
  },
  GRASS: {
    canonicalAssetKey: 'GRASS',
    canonicalName: 'Grass',
    assetType: 'crypto',
    aliases: ['grass'],
    assetSlug: 'grass',
    coingeckoId: 'grass',
    brandColor: '#16A34A',
    initials: 'GRASS',
  },
  MOC: {
    canonicalAssetKey: 'MOC',
    canonicalName: 'Mossland',
    assetType: 'crypto',
    aliases: ['mossland', 'moss coin'],
    assetSlug: 'mossland',
    coingeckoId: 'mossland',
    brandColor: '#047857',
    initials: 'MOC',
  },
  MOVE: {
    canonicalAssetKey: 'MOVE',
    canonicalName: 'Movement',
    assetType: 'crypto',
    aliases: ['movement'],
    assetSlug: 'movement',
    coingeckoId: 'movement',
    brandColor: '#111827',
    initials: 'MOVE',
  },
  SCR: {
    canonicalAssetKey: 'SCR',
    canonicalName: 'Scroll',
    assetType: 'crypto',
    aliases: ['scroll'],
    assetSlug: 'scroll',
    coingeckoId: 'scroll',
    brandColor: '#F59E0B',
    initials: 'SCR',
  },
  BTR: {
    canonicalAssetKey: 'BTR',
    canonicalName: 'Bitlayer',
    assetType: 'crypto',
    aliases: ['bitlayer'],
    assetSlug: 'bitlayer-bitvm',
    coingeckoId: 'bitlayer-bitvm',
    brandColor: '#111827',
    initials: 'BTR',
  },
  ACT: {
    canonicalAssetKey: 'ACT',
    canonicalName: 'Act I The AI Prophecy',
    assetType: 'crypto',
    aliases: ['act i the ai prophecy', 'act i'],
    assetSlug: 'act-i-the-ai-prophecy',
    coingeckoId: 'act-i-the-ai-prophecy',
    brandColor: '#111827',
    initials: 'ACT',
  },
  ADX: {
    canonicalAssetKey: 'ADX',
    canonicalName: 'AdEx',
    assetType: 'crypto',
    aliases: ['adex'],
    assetSlug: 'adex',
    coingeckoId: 'adex',
    brandColor: '#111827',
    initials: 'ADX',
  },
  ATA: {
    canonicalAssetKey: 'ATA',
    canonicalName: 'Automata',
    assetType: 'crypto',
    aliases: ['automata'],
    assetSlug: 'automata',
    coingeckoId: 'automata',
    brandColor: '#111827',
    initials: 'ATA',
  },
  BROCCOLI714: {
    canonicalAssetKey: 'BROCCOLI714',
    canonicalName: "CZ's Dog",
    assetType: 'crypto',
    aliases: ['broccoli714', "cz's dog", 'czs dog', 'broccoli'],
    assetSlug: 'czs-dog',
    coingeckoId: 'czs-dog',
    brandColor: '#16A34A',
    initials: 'BRO',
  },
  CHR: {
    canonicalAssetKey: 'CHR',
    canonicalName: 'Chromia',
    assetType: 'crypto',
    aliases: ['chromia'],
    assetSlug: 'chromaway',
    coingeckoId: 'chromaway',
    brandColor: '#111827',
    initials: 'CHR',
  },
  COS: {
    canonicalAssetKey: 'COS',
    canonicalName: 'Contentos',
    assetType: 'crypto',
    aliases: ['contentos'],
    assetSlug: 'contentos',
    coingeckoId: 'contentos',
    brandColor: '#111827',
    initials: 'COS',
  },
  JOE: {
    canonicalAssetKey: 'JOE',
    canonicalName: 'JOE',
    assetType: 'crypto',
    aliases: ['trader joe'],
    assetSlug: 'joe',
    coingeckoId: 'joe',
    brandColor: '#111827',
    initials: 'JOE',
  },
  INIT: {
    canonicalAssetKey: 'INIT',
    canonicalName: 'Initia',
    assetType: 'crypto',
    aliases: ['initia'],
    assetSlug: 'initia',
    coingeckoId: 'initia',
    brandColor: '#111827',
    initials: 'INIT',
  },
  SHELL: {
    canonicalAssetKey: 'SHELL',
    canonicalName: 'MyShell',
    assetType: 'crypto',
    aliases: ['myshell', 'my shell'],
    assetSlug: 'myshell',
    coingeckoId: 'myshell',
    brandColor: '#111827',
    initials: 'SHELL',
  },
  BMT: {
    canonicalAssetKey: 'BMT',
    canonicalName: 'Bubblemaps',
    assetType: 'crypto',
    aliases: ['bubblemaps'],
    assetSlug: 'bubblemaps',
    coingeckoId: 'bubblemaps',
    brandColor: '#111827',
    initials: 'BMT',
  },
  MOODENG: {
    canonicalAssetKey: 'MOODENG',
    canonicalName: 'Moo Deng',
    assetType: 'crypto',
    aliases: ['moo deng', 'moodeng'],
    assetSlug: 'moo-deng',
    coingeckoId: 'moo-deng',
    brandColor: '#111827',
    initials: 'MOODENG',
  },
  XTZ: {
    canonicalAssetKey: 'XTZ',
    canonicalName: 'Tezos',
    assetType: 'crypto',
    aliases: ['tezos'],
    assetSlug: 'tezos',
    coingeckoId: 'tezos',
    brandColor: '#2C7DF7',
    initials: 'XTZ',
  },
  PIXEL: {
    canonicalAssetKey: 'PIXEL',
    canonicalName: 'Pixels',
    assetType: 'crypto',
    aliases: ['pixels'],
    assetSlug: 'pixels',
    coingeckoId: 'pixels',
    brandColor: '#111827',
    initials: 'PIXEL',
  },
  PERP: {
    canonicalAssetKey: 'PERP',
    canonicalName: 'Perpetual Protocol',
    assetType: 'crypto',
    aliases: ['perpetual protocol'],
    assetSlug: 'perpetual-protocol',
    coingeckoId: 'perpetual-protocol',
    brandColor: '#111827',
    initials: 'PERP',
  },
  RARE: {
    canonicalAssetKey: 'RARE',
    canonicalName: 'SuperRare',
    assetType: 'crypto',
    aliases: ['superrare'],
    assetSlug: 'superrare',
    coingeckoId: 'superrare',
    brandColor: '#111827',
    initials: 'RARE',
  },
  DASH: {
    canonicalAssetKey: 'DASH',
    canonicalName: 'Dash',
    assetType: 'crypto',
    aliases: ['dash'],
    assetSlug: 'dash',
    coingeckoId: 'dash',
    brandColor: '#008CE7',
    initials: 'DASH',
  },
  DODO: {
    canonicalAssetKey: 'DODO',
    canonicalName: 'DODO',
    assetType: 'crypto',
    aliases: ['dodo'],
    assetSlug: 'dodo',
    coingeckoId: 'dodo',
    brandColor: '#111827',
    initials: 'DODO',
  },
  NEO: {
    canonicalAssetKey: 'NEO',
    canonicalName: 'NEO',
    assetType: 'crypto',
    aliases: ['neo'],
    assetSlug: 'neo',
    coingeckoId: 'neo',
    brandColor: '#58BF00',
    initials: 'NEO',
  },
  GNO: {
    canonicalAssetKey: 'GNO',
    canonicalName: 'Gnosis',
    assetType: 'crypto',
    aliases: ['gnosis'],
    assetSlug: 'gnosis',
    coingeckoId: 'gnosis',
    brandColor: '#111827',
    initials: 'GNO',
  },
  OHM: {
    canonicalAssetKey: 'OHM',
    canonicalName: 'Olympus',
    assetType: 'crypto',
    aliases: ['olympus'],
    assetSlug: 'olympus',
    coingeckoId: 'olympus',
    brandColor: '#111827',
    initials: 'OHM',
  },
  MNT: {
    canonicalAssetKey: 'MNT',
    canonicalName: 'Mantle',
    assetType: 'crypto',
    aliases: ['mantle'],
    assetSlug: 'mantle',
    coingeckoId: 'mantle',
    brandColor: '#111827',
    initials: 'MNT',
  },
  MBX: {
    canonicalAssetKey: 'MBX',
    canonicalName: 'MARBLEX',
    assetType: 'crypto',
    aliases: ['marblex'],
    assetSlug: 'marblex',
    coingeckoId: 'marblex',
    brandColor: '#111827',
    initials: 'MBX',
  },
  AVA: {
    canonicalAssetKey: 'AVA',
    canonicalName: 'AVA (Travala)',
    assetType: 'crypto',
    aliases: ['travala', 'travala token', 'ava travala'],
    assetSlug: 'concierge-io',
    coingeckoId: 'concierge-io',
    brandColor: '#0F766E',
    initials: 'AVA',
  },
  FRAX: {
    canonicalAssetKey: 'FRAX',
    canonicalName: 'Legacy Frax Dollar',
    assetType: 'stablecoin',
    aliases: ['frax'],
    assetSlug: 'frax',
    coingeckoId: 'frax',
    brandColor: '#111827',
    initials: 'FRAX',
  },
  HIVE: {
    canonicalAssetKey: 'HIVE',
    canonicalName: 'Hive',
    assetType: 'crypto',
    aliases: ['hive'],
    assetSlug: 'hive',
    coingeckoId: 'hive',
    brandColor: '#F59E0B',
    initials: 'HIVE',
  },
  HOLO: {
    canonicalAssetKey: 'HOLO',
    canonicalName: 'Holo',
    assetType: 'crypto',
    aliases: ['holo'],
    assetSlug: 'holo',
    coingeckoId: 'holo',
    brandColor: '#7C3AED',
    initials: 'HOLO',
  },
  SAFE: {
    canonicalAssetKey: 'SAFE',
    canonicalName: 'Safe',
    assetType: 'crypto',
    aliases: ['safe'],
    assetSlug: 'safe',
    coingeckoId: 'safe',
    brandColor: '#10B981',
    initials: 'SAFE',
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
  SKYDOLLAR: 'USDS',
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
  ETHFI: 'ETHFI',
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
  SONICSVM: 'SONICSVM',
  SONIC_SVM: 'SONICSVM',
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
    SONIC: 'SONICSVM',
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

type AssetImageOverride = {
  preferredImageSymbol?: string;
  preferredImageSlug?: string;
  coingeckoId?: string;
  source: Extract<
    AssetImageResolutionSource,
    'exchange_image_alias_override'
    | 'image_alias_override'
    | 'numeric_multiplier_variant'
    | 'ultra_short_override'
    | 'branded_override'
  >;
};

const IMAGE_ALIAS_OVERRIDES: Record<string, AssetImageOverride> = {
  '1000CAT': { preferredImageSymbol: '1000CAT', preferredImageSlug: '1000cat', coingeckoId: '1000cat', source: 'numeric_multiplier_variant' },
  '1000CHEEMS': { preferredImageSymbol: 'CHEEMS', preferredImageSlug: 'cheems-token', coingeckoId: 'cheems-token', source: 'numeric_multiplier_variant' },
  '1000SATS': { preferredImageSymbol: '1000SATS', preferredImageSlug: '1000sats-ordinals', coingeckoId: '1000sats-ordinals', source: 'numeric_multiplier_variant' },
  ACE: { preferredImageSymbol: 'ACE', preferredImageSlug: 'endurance', coingeckoId: 'endurance', source: 'image_alias_override' },
  ACS: { preferredImageSymbol: 'ACS', preferredImageSlug: 'access-protocol', coingeckoId: 'access-protocol', source: 'image_alias_override' },
  AGI: { preferredImageSymbol: 'AGI', preferredImageSlug: 'delysium', coingeckoId: 'delysium', source: 'image_alias_override' },
  AI: { preferredImageSymbol: 'AI', preferredImageSlug: 'sleepless-ai', coingeckoId: 'sleepless-ai', source: 'image_alias_override' },
  AKT: { preferredImageSymbol: 'AKT', preferredImageSlug: 'akash-network', coingeckoId: 'akash-network', source: 'image_alias_override' },
  ALICE: { preferredImageSymbol: 'ALICE', preferredImageSlug: 'my-neighbor-alice', coingeckoId: 'my-neighbor-alice', source: 'image_alias_override' },
  ALT: { preferredImageSymbol: 'ALT', preferredImageSlug: 'altlayer', coingeckoId: 'altlayer', source: 'image_alias_override' },
  ANIME: { preferredImageSymbol: 'ANIME', preferredImageSlug: 'anime', coingeckoId: 'anime', source: 'image_alias_override' },
  ARK: { preferredImageSymbol: 'ARK', preferredImageSlug: 'ark', coingeckoId: 'ark', source: 'image_alias_override' },
  ASTR: { preferredImageSymbol: 'ASTR', preferredImageSlug: 'astar', coingeckoId: 'astar', source: 'image_alias_override' },
  ATH: { preferredImageSymbol: 'ATH', preferredImageSlug: 'aethir', coingeckoId: 'aethir', source: 'image_alias_override' },
  AUCTION: { preferredImageSymbol: 'AUCTION', preferredImageSlug: 'auction', coingeckoId: 'auction', source: 'image_alias_override' },
  AVL: { preferredImageSymbol: 'AVL', preferredImageSlug: 'avalon-2', coingeckoId: 'avalon-2', source: 'image_alias_override' },
  BAT: { preferredImageSymbol: 'BAT', preferredImageSlug: 'basic-attention-token', coingeckoId: 'basic-attention-token', source: 'image_alias_override' },
  BB: { preferredImageSymbol: 'BB', preferredImageSlug: 'bouncebit', coingeckoId: 'bouncebit', source: 'ultra_short_override' },
  BEAM: { preferredImageSymbol: 'BEAM', preferredImageSlug: 'beam-2', coingeckoId: 'beam-2', source: 'image_alias_override' },
  BEL: { preferredImageSymbol: 'BEL', preferredImageSlug: 'bella-protocol', coingeckoId: 'bella-protocol', source: 'image_alias_override' },
  BIRB: { preferredImageSymbol: 'BIRB', preferredImageSlug: 'moonbirds', coingeckoId: 'moonbirds', source: 'image_alias_override' },
  BOBA: { preferredImageSymbol: 'BOBA', preferredImageSlug: 'boba-network', coingeckoId: 'boba-network', source: 'image_alias_override' },
  CAT: { preferredImageSymbol: 'CAT', preferredImageSlug: 'simons-cat', coingeckoId: 'simons-cat', source: 'image_alias_override' },
  CFX: { preferredImageSymbol: 'CFX', preferredImageSlug: 'conflux-token', coingeckoId: 'conflux-token', source: 'image_alias_override' },
  CHEEMS: { preferredImageSymbol: 'CHEEMS', preferredImageSlug: 'cheems-token', coingeckoId: 'cheems-token', source: 'image_alias_override' },
  COOKIE: { preferredImageSymbol: 'COOKIE', preferredImageSlug: 'cookie', coingeckoId: 'cookie', source: 'image_alias_override' },
  CRO: { preferredImageSymbol: 'CRO', preferredImageSlug: 'crypto-com-chain', coingeckoId: 'crypto-com-chain', source: 'image_alias_override' },
  CRV: { preferredImageSymbol: 'CRV', preferredImageSlug: 'curve-dao-token', coingeckoId: 'curve-dao-token', source: 'image_alias_override' },
  DBR: { preferredImageSymbol: 'DBR', preferredImageSlug: 'debridge', coingeckoId: 'debridge', source: 'image_alias_override' },
  DEEP: { preferredImageSymbol: 'DEEP', preferredImageSlug: 'deep', coingeckoId: 'deep', source: 'image_alias_override' },
  ERA: { preferredImageSymbol: 'ERA', preferredImageSlug: 'caldera', coingeckoId: 'caldera', source: 'image_alias_override' },
  ESP: { preferredImageSymbol: 'ESP', preferredImageSlug: 'espresso', coingeckoId: 'espresso', source: 'image_alias_override' },
  ETHFI: { preferredImageSymbol: 'ETHFI', preferredImageSlug: 'ether-fi', coingeckoId: 'ether-fi', source: 'branded_override' },
  FARM: { preferredImageSymbol: 'FARM', preferredImageSlug: 'harvest-finance', coingeckoId: 'harvest-finance', source: 'image_alias_override' },
  BROCCOLI714: { preferredImageSymbol: 'BROCCOLI714', preferredImageSlug: 'czs-dog', coingeckoId: 'czs-dog', source: 'branded_override' },
  GAS: { preferredImageSymbol: 'GAS', preferredImageSlug: 'gas', coingeckoId: 'gas', source: 'image_alias_override' },
  GEOD: { preferredImageSymbol: 'GEOD', preferredImageSlug: 'geodnet', coingeckoId: 'geodnet', source: 'image_alias_override' },
  GTC: { preferredImageSymbol: 'GTC', preferredImageSlug: 'gitcoin', coingeckoId: 'gitcoin', source: 'image_alias_override' },
  ID: { preferredImageSymbol: 'ID', preferredImageSlug: 'space-id', coingeckoId: 'space-id', source: 'ultra_short_override' },
  IOTX: { preferredImageSymbol: 'IOTX', preferredImageSlug: 'iotex', coingeckoId: 'iotex', source: 'image_alias_override' },
  KAT: { preferredImageSymbol: 'KAT', preferredImageSlug: 'katana-network-token', coingeckoId: 'katana-network-token', source: 'image_alias_override' },
  LDO: { preferredImageSymbol: 'LDO', preferredImageSlug: 'lido-dao', coingeckoId: 'lido-dao', source: 'image_alias_override' },
  LAYER: { preferredImageSymbol: 'LAYER', preferredImageSlug: 'solayer', coingeckoId: 'solayer', source: 'image_alias_override' },
  MANA: { preferredImageSymbol: 'MANA', preferredImageSlug: 'decentraland', coingeckoId: 'decentraland', source: 'image_alias_override' },
  MASK: { preferredImageSymbol: 'MASK', preferredImageSlug: 'mask-network', coingeckoId: 'mask-network', source: 'image_alias_override' },
  MON: { preferredImageSymbol: 'MON', preferredImageSlug: 'monad', coingeckoId: 'monad', source: 'image_alias_override' },
  NCT: { preferredImageSymbol: 'NCT', preferredImageSlug: 'polyswarm', coingeckoId: 'polyswarm', source: 'image_alias_override' },
  NXPC: { preferredImageSymbol: 'NXPC', preferredImageSlug: 'nexpace', coingeckoId: 'nexpace', source: 'image_alias_override' },
  ORDER: { preferredImageSymbol: 'ORDER', preferredImageSlug: 'orderly-network', coingeckoId: 'orderly-network', source: 'image_alias_override' },
  POLA: { preferredImageSymbol: 'POLA', preferredImageSlug: 'polaris-share', coingeckoId: 'polaris-share', source: 'image_alias_override' },
  QI: { preferredImageSymbol: 'QI', preferredImageSlug: 'benqi', coingeckoId: 'benqi', source: 'ultra_short_override' },
  RED: { preferredImageSymbol: 'RED', preferredImageSlug: 'redstone-oracles', coingeckoId: 'redstone-oracles', source: 'image_alias_override' },
  SATS: { preferredImageSymbol: 'SATS', preferredImageSlug: 'sats-ordinals', coingeckoId: 'sats-ordinals', source: 'image_alias_override' },
  SKR: { preferredImageSymbol: 'SKR', preferredImageSlug: 'seeker', coingeckoId: 'seeker', source: 'image_alias_override' },
  SOPH: { preferredImageSymbol: 'SOPH', preferredImageSlug: 'sophon', coingeckoId: 'sophon', source: 'image_alias_override' },
  SYN: { preferredImageSymbol: 'SYN', preferredImageSlug: 'synapse-2', coingeckoId: 'synapse-2', source: 'image_alias_override' },
  THE: { preferredImageSymbol: 'THE', preferredImageSlug: 'thena', coingeckoId: 'thena', source: 'image_alias_override' },
  TRAC: { preferredImageSymbol: 'TRAC', preferredImageSlug: 'origintrail', coingeckoId: 'origintrail', source: 'image_alias_override' },
  WET: { preferredImageSymbol: 'WET', preferredImageSlug: 'humidifi', coingeckoId: 'humidifi', source: 'image_alias_override' },
  XPLA: { preferredImageSymbol: 'CONX', preferredImageSlug: 'xpla', coingeckoId: 'xpla', source: 'image_alias_override' },
  ZKP: { preferredImageSymbol: 'ZKP', preferredImageSlug: 'zkpass', coingeckoId: 'zkpass', source: 'image_alias_override' },
  ZRX: { preferredImageSymbol: 'ZRX', preferredImageSlug: '0x', coingeckoId: '0x', source: 'image_alias_override' },
};

const EXCHANGE_IMAGE_ALIAS_OVERRIDES: Partial<Record<ExchangeId, Record<string, AssetImageOverride>>> = {
  bithumb: {
    KRWSTABLE: { preferredImageSymbol: 'STABLE', preferredImageSlug: 'stable-3', coingeckoId: 'stable-3', source: 'exchange_image_alias_override' },
    KRWBABY: { preferredImageSymbol: 'BABY', preferredImageSlug: 'babylon', coingeckoId: 'babylon', source: 'exchange_image_alias_override' },
  },
  coinone: {
    STABLE: { preferredImageSymbol: 'STABLE', preferredImageSlug: 'stable-3', coingeckoId: 'stable-3', source: 'exchange_image_alias_override' },
  },
  binance: {
    '1000CATUSDT': { preferredImageSymbol: '1000CAT', preferredImageSlug: '1000cat', coingeckoId: '1000cat', source: 'exchange_image_alias_override' },
    '1000CHEEMSUSDT': { preferredImageSymbol: 'CHEEMS', preferredImageSlug: 'cheems-token', coingeckoId: 'cheems-token', source: 'exchange_image_alias_override' },
    '1000SATSUSDT': { preferredImageSymbol: '1000SATS', preferredImageSlug: '1000sats-ordinals', coingeckoId: '1000sats-ordinals', source: 'exchange_image_alias_override' },
    ATMUSDT: { preferredImageSymbol: 'ATM', preferredImageSlug: 'atletico-madrid', coingeckoId: 'atletico-madrid', source: 'exchange_image_alias_override' },
    BARUSDT: { preferredImageSymbol: 'BAR', preferredImageSlug: 'fc-barcelona-fan-token', coingeckoId: 'fc-barcelona-fan-token', source: 'exchange_image_alias_override' },
    CITYUSDT: { preferredImageSymbol: 'CITY', preferredImageSlug: 'manchester-city-fan-token', coingeckoId: 'manchester-city-fan-token', source: 'exchange_image_alias_override' },
    BROCCOLI714USDT: { preferredImageSymbol: 'BROCCOLI714', preferredImageSlug: 'czs-dog', coingeckoId: 'czs-dog', source: 'exchange_image_alias_override' },
    BFUSDUSDT: { preferredImageSymbol: 'BFUSD', preferredImageSlug: 'bfusd', coingeckoId: 'bfusd', source: 'exchange_image_alias_override' },
  },
};

const NUMERIC_MULTIPLIER_IMAGE_OVERRIDES = new Set([
  'CAT',
  'CHEEMS',
  'SATS',
  'SHIB',
  'PEPE',
  'BONK',
  'FLOKI',
  'LUNC',
  'XEC',
  'MOG',
  'RATS',
  'TOSHI',
  'WHY',
  'BABYDOGE',
]);

export function normalizeAssetToken(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

export function compactAssetToken(value: string) {
  return normalizeAssetToken(value).replace(/[^A-Z0-9]+/g, '');
}

export function buildDefaultAssetSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown-asset';
}

function lookupImageOverride(candidate?: string | null) {
  if (!candidate) {
    return null;
  }
  const compact = compactAssetToken(candidate);
  return compact ? IMAGE_ALIAS_OVERRIDES[compact] ?? null : null;
}

function lookupExchangeImageOverride(exchange: ExchangeId | undefined | null, candidate?: string | null) {
  if (!exchange || !candidate) {
    return null;
  }
  const compact = compactAssetToken(candidate);
  return compact ? EXCHANGE_IMAGE_ALIAS_OVERRIDES[exchange]?.[compact] ?? null : null;
}

function resolveNumericMultiplierVariant(candidate?: string | null) {
  if (!candidate) {
    return null;
  }
  const compact = compactAssetToken(candidate);
  const multiplierMatch = compact.match(/^\d+(?:K|M)?([A-Z][A-Z0-9]{1,})$/);
  if (!multiplierMatch) {
    return null;
  }
  const underlyingSymbol = multiplierMatch[1];
  if (!NUMERIC_MULTIPLIER_IMAGE_OVERRIDES.has(underlyingSymbol)) {
    return {
      underlyingSymbol,
      override: null,
    };
  }
  return {
    underlyingSymbol,
    override: lookupImageOverride(underlyingSymbol),
  };
}

function isAmbiguousUltraShortSymbol(candidate?: string | null) {
  const compact = candidate ? compactAssetToken(candidate) : '';
  if (!compact || compact.length > 2) {
    return false;
  }
  if (lookupImageOverride(compact)) {
    return false;
  }
  const entry = ASSET_REGISTRY[compact];
  return !entry?.coingeckoId && !entry?.assetSlug;
}

function isLikelyBrandedVariant(candidate?: string | null) {
  const compact = candidate ? compactAssetToken(candidate) : '';
  return compact.length > 3 && /\d/.test(compact) && /[A-Z]/.test(compact);
}

function buildFallbackOnlyImageIdentity(params: {
  canonicalAssetKey: string | null;
  preferredImageSymbol: string | null;
  preferredImageSlug?: string | null;
  reason: AssetImageMissingReason;
  manualCurationRecommended?: boolean;
  resolutionSource?: AssetImageResolutionSource;
}): PreferredAssetImageIdentity {
  return {
    canonicalAssetKey: params.canonicalAssetKey,
    preferredImageSymbol: params.preferredImageSymbol,
    preferredImageSlug: params.preferredImageSlug ?? null,
    preferredImageCoingeckoId: null,
    resolutionSource: params.resolutionSource ?? 'unresolved',
    resolutionStage: 'fallback_only',
    imageMissingReason: params.reason,
    fallbackOnly: true,
    manualCurationRecommended: params.manualCurationRecommended ?? true,
  };
}

export function buildImageFallbackKey(params: {
  canonicalAssetKey?: string | null;
  assetSlug?: string | null;
  coingeckoId?: string | null;
  exchange?: ExchangeId | string | null;
  symbol?: string | null;
  rawSymbol?: string | null;
  marketId?: string | null;
}) {
  if (params.coingeckoId) {
    return `coingecko:${params.coingeckoId}`;
  }
  if (params.assetSlug) {
    return `asset:${params.assetSlug}`;
  }
  if (params.canonicalAssetKey) {
    return `symbol:${compactAssetToken(params.canonicalAssetKey)}`;
  }
  const unresolvedCandidates = [
    params.symbol,
    params.rawSymbol,
    params.marketId,
  ].filter((value): value is string => Boolean(value?.trim()));
  const unresolvedIdentity = unresolvedCandidates.find((value) => buildDefaultAssetSlug(value) !== 'unknown-asset')
    ?? unresolvedCandidates[0];
  if (unresolvedIdentity) {
    const exchangePrefix = params.exchange ? `${String(params.exchange).toLowerCase()}:` : '';
    const unresolvedSlug = buildDefaultAssetSlug(unresolvedIdentity);
    return `unresolved:${exchangePrefix}${
      unresolvedSlug !== 'unknown-asset'
        ? unresolvedSlug
        : `raw-${Buffer.from(unresolvedIdentity).toString('hex').toLowerCase()}`
    }`;
  }
  return 'symbol:UNKNOWN';
}

export function resolvePreferredAssetImage(params: {
  exchange?: ExchangeId | null;
  canonicalAssetKey?: string | null;
  symbol?: string | null;
  rawSymbol?: string | null;
  marketId?: string | null;
}) : PreferredAssetImageIdentity {
  const canonicalAssetKey = params.canonicalAssetKey ? compactAssetToken(params.canonicalAssetKey) : null;
  const candidateTokens = [
    params.symbol,
    params.rawSymbol,
    params.marketId,
    params.canonicalAssetKey,
  ]
    .map((value) => value ? compactAssetToken(value) : '')
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidateTokens) {
    const override = lookupExchangeImageOverride(params.exchange, candidate);
    if (override) {
      return {
        canonicalAssetKey,
        preferredImageSymbol: override.preferredImageSymbol ?? candidate,
        preferredImageSlug: override.preferredImageSlug ?? override.coingeckoId ?? buildDefaultAssetSlug(candidate),
        preferredImageCoingeckoId: override.coingeckoId ?? null,
        resolutionSource: override.source,
        resolutionStage: 'preferred_image',
        imageMissingReason: null,
        fallbackOnly: false,
        manualCurationRecommended: false,
      };
    }
  }

  for (const candidate of candidateTokens) {
    const override = lookupImageOverride(candidate);
    if (override) {
      return {
        canonicalAssetKey,
        preferredImageSymbol: override.preferredImageSymbol ?? candidate,
        preferredImageSlug: override.preferredImageSlug ?? override.coingeckoId ?? buildDefaultAssetSlug(candidate),
        preferredImageCoingeckoId: override.coingeckoId ?? null,
        resolutionSource: override.source,
        resolutionStage: 'preferred_image',
        imageMissingReason: null,
        fallbackOnly: false,
        manualCurationRecommended: false,
      };
    }
  }

  const numericVariant = candidateTokens
    .map((candidate) => resolveNumericMultiplierVariant(candidate))
    .find((candidate) => candidate);
  if (numericVariant) {
    if (numericVariant.override) {
      return {
        canonicalAssetKey,
        preferredImageSymbol: numericVariant.override.preferredImageSymbol ?? numericVariant.underlyingSymbol,
        preferredImageSlug: numericVariant.override.preferredImageSlug ?? numericVariant.override.coingeckoId ?? buildDefaultAssetSlug(numericVariant.underlyingSymbol),
        preferredImageCoingeckoId: numericVariant.override.coingeckoId ?? null,
        resolutionSource: 'numeric_multiplier_variant',
        resolutionStage: 'preferred_image',
        imageMissingReason: null,
        fallbackOnly: false,
        manualCurationRecommended: false,
      };
    }

    return {
      canonicalAssetKey,
      preferredImageSymbol: numericVariant.underlyingSymbol,
      preferredImageSlug: null,
      preferredImageCoingeckoId: null,
      resolutionSource: 'numeric_multiplier_variant',
      resolutionStage: 'fallback_only',
      imageMissingReason: 'unresolved_numeric_variant',
      fallbackOnly: true,
      manualCurationRecommended: true,
    };
  }

  if (canonicalAssetKey) {
    const entry = ASSET_REGISTRY[canonicalAssetKey];
    if (entry?.imagePolicy === 'underlying' && entry.underlyingAssetKey) {
      const underlyingEntry = ASSET_REGISTRY[compactAssetToken(entry.underlyingAssetKey)];
      return {
        canonicalAssetKey,
        preferredImageSymbol: underlyingEntry?.canonicalAssetKey ?? entry.underlyingAssetKey,
        preferredImageSlug: underlyingEntry?.assetSlug ?? underlyingEntry?.coingeckoId ?? buildDefaultAssetSlug(entry.underlyingAssetKey),
        preferredImageCoingeckoId: underlyingEntry?.coingeckoId ?? null,
        resolutionSource: 'registry_underlying',
        resolutionStage: 'registry_identity',
        imageMissingReason: null,
        fallbackOnly: false,
        manualCurationRecommended: false,
      };
    }

    if (entry?.coingeckoId || entry?.assetSlug) {
      return {
        canonicalAssetKey,
        preferredImageSymbol: entry.canonicalAssetKey,
        preferredImageSlug: entry.assetSlug ?? entry.coingeckoId ?? buildDefaultAssetSlug(entry.canonicalAssetKey),
        preferredImageCoingeckoId: entry.coingeckoId ?? null,
        resolutionSource: 'registry_direct',
        resolutionStage: 'registry_identity',
        imageMissingReason: null,
        fallbackOnly: false,
        manualCurationRecommended: false,
      };
    }

    if (entry?.assetType === 'fiat' || entry?.imagePolicy === 'fiat_initials') {
      return buildFallbackOnlyImageIdentity({
        canonicalAssetKey,
        preferredImageSymbol: entry.canonicalAssetKey,
        reason: 'fiat_or_quote_like_symbol',
        resolutionSource: 'fiat_or_quote_policy',
        manualCurationRecommended: false,
      });
    }

    if (isAmbiguousUltraShortSymbol(canonicalAssetKey)) {
      return buildFallbackOnlyImageIdentity({
        canonicalAssetKey,
        preferredImageSymbol: canonicalAssetKey,
        reason: 'ambiguous_short_symbol',
      });
    }

    if (isKnownQuoteAssetToken(canonicalAssetKey)) {
      return buildFallbackOnlyImageIdentity({
        canonicalAssetKey,
        preferredImageSymbol: canonicalAssetKey,
        reason: 'fiat_or_quote_like_symbol',
        resolutionSource: 'fiat_or_quote_policy',
        manualCurationRecommended: false,
      });
    }

    if (isLikelyBrandedVariant(canonicalAssetKey)) {
      return buildFallbackOnlyImageIdentity({
        canonicalAssetKey,
        preferredImageSymbol: canonicalAssetKey,
        preferredImageSlug: buildDefaultAssetSlug(canonicalAssetKey),
        reason: 'unresolved_branded_variant',
      });
    }

    if (!entry) {
      return buildFallbackOnlyImageIdentity({
        canonicalAssetKey,
        preferredImageSymbol: canonicalAssetKey,
        preferredImageSlug: buildDefaultAssetSlug(canonicalAssetKey),
        reason: 'missing_curated_mapping',
      });
    }

    return {
      canonicalAssetKey,
      preferredImageSymbol: canonicalAssetKey,
      preferredImageSlug: buildDefaultAssetSlug(canonicalAssetKey),
      preferredImageCoingeckoId: null,
      resolutionSource: 'fallback_registry_slug',
      resolutionStage: 'fallback_only',
      imageMissingReason: 'missing_registry_image_metadata',
      fallbackOnly: true,
      manualCurationRecommended: true,
    };
  }

  const shortCandidate = candidateTokens.find((candidate) => isAmbiguousUltraShortSymbol(candidate));
  if (shortCandidate) {
    return buildFallbackOnlyImageIdentity({
      canonicalAssetKey: null,
      preferredImageSymbol: shortCandidate,
      reason: 'ambiguous_short_symbol',
    });
  }

  const fallbackSymbol = candidateTokens[0] ?? null;
  if (fallbackSymbol && isKnownQuoteAssetToken(fallbackSymbol)) {
    return buildFallbackOnlyImageIdentity({
      canonicalAssetKey,
      preferredImageSymbol: fallbackSymbol,
      reason: 'fiat_or_quote_like_symbol',
      resolutionSource: 'fiat_or_quote_policy',
      manualCurationRecommended: false,
    });
  }
  if (fallbackSymbol && isLikelyBrandedVariant(fallbackSymbol)) {
    return buildFallbackOnlyImageIdentity({
      canonicalAssetKey,
      preferredImageSymbol: fallbackSymbol,
      preferredImageSlug: buildDefaultAssetSlug(fallbackSymbol),
      reason: 'unresolved_branded_variant',
    });
  }
  return {
    canonicalAssetKey,
    preferredImageSymbol: fallbackSymbol,
    preferredImageSlug: fallbackSymbol ? buildDefaultAssetSlug(fallbackSymbol) : null,
    preferredImageCoingeckoId: null,
    resolutionSource: 'unresolved',
    resolutionStage: 'fallback_only',
    imageMissingReason: fallbackSymbol ? 'missing_curated_mapping' : 'missing_preferred_slug',
    fallbackOnly: true,
    manualCurationRecommended: Boolean(fallbackSymbol),
  };
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

export function isKnownAssetRegistryKey(candidate?: string | null) {
  if (!candidate) {
    return false;
  }
  const compact = compactAssetToken(candidate);
  return Boolean(ASSET_REGISTRY[compact] || REGISTRY_ALIAS_MAP[compact]);
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
    const derivedAssetSlug = buildDefaultAssetSlug(canonicalAssetKey ?? originalSymbol ?? 'unknown');
    return {
      assetType: 'unknown' as const,
      canonicalName: canonicalAssetKey ?? originalSymbol ?? null,
      fallbackColor: '#64748B',
      fallbackInitials: (canonicalAssetKey ?? originalSymbol ?? '?').slice(0, 4).toUpperCase(),
      assetSlug: derivedAssetSlug,
      imageFallbackKey: buildImageFallbackKey({
        canonicalAssetKey: canonicalAssetKey ?? originalSymbol ?? null,
        assetSlug: derivedAssetSlug,
      }),
      aliases: [] as string[],
      registryKnown: false,
      imagePolicy: 'metadata' as AssetImagePolicy,
      underlyingAssetKey: null,
    };
  }

  const assetSlug = entry.assetSlug ?? entry.coingeckoId ?? buildDefaultAssetSlug(entry.canonicalAssetKey);
  return {
    assetType: entry.assetType,
    canonicalName: entry.canonicalName,
    fallbackColor: entry.brandColor ?? '#64748B',
    fallbackInitials: entry.initials ?? entry.canonicalAssetKey.slice(0, 4),
    assetSlug,
    imageFallbackKey: entry.imageFallbackKey ?? buildImageFallbackKey({
      canonicalAssetKey: entry.canonicalAssetKey,
      assetSlug,
      coingeckoId: entry.coingeckoId ?? null,
    }),
    aliases: [...new Set([entry.canonicalAssetKey, ...(entry.aliases ?? [])])],
    registryKnown: true,
    imagePolicy: entry.imagePolicy ?? 'metadata',
    underlyingAssetKey: entry.underlyingAssetKey ?? null,
  };
}

export function containsNonAsciiAssetText(value?: string | null) {
  return Boolean(value && /[^\x00-\x7F]/.test(value));
}
