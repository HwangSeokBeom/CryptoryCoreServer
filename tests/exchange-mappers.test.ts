import { describe, expect, it } from 'vitest';
import { resolvePreferredAssetImage } from '../src/core/exchange/asset.registry';
import { resolveExchangeInterval } from '../src/core/exchange/interval.mapper';
import { fromExchangeSymbol, resolveCanonicalAssetKey, toExchangeSymbol } from '../src/core/exchange/symbol.mapper';

describe('Exchange Mappers', () => {
  it('normalizes symbol formats per exchange', () => {
    expect(toExchangeSymbol('upbit', 'btc')).toBe('KRW-BTC');
    expect(toExchangeSymbol('bithumb', 'btc')).toBe('BTC_KRW');
    expect(toExchangeSymbol('coinone', 'btc')).toBe('BTC');
    expect(toExchangeSymbol('korbit', 'btc')).toBe('btc_krw');
    expect(toExchangeSymbol('binance', 'btc')).toBe('BTCUSDT');

    expect(fromExchangeSymbol('upbit', 'KRW-BTC')).toBe('BTC');
    expect(fromExchangeSymbol('upbit', 'KRW-USDT')).toBe('USDT');
    expect(fromExchangeSymbol('bithumb', 'BTC_KRW')).toBe('BTC');
    expect(fromExchangeSymbol('bithumb', 'USDT_KRW')).toBe('USDT');
    expect(fromExchangeSymbol('coinone', 'btc')).toBe('BTC');
    expect(fromExchangeSymbol('korbit', 'btc_krw')).toBe('BTC');
    expect(fromExchangeSymbol('korbit', 'usdt_krw')).toBe('USDT');
    expect(fromExchangeSymbol('binance', 'btcusdt')).toBe('BTC');
    expect(fromExchangeSymbol('binance', 'ETHUSDC')).toBe('ETH');
    expect(fromExchangeSymbol('binance', 'FDUSDUSDT')).toBe('FDUSD');
    expect(fromExchangeSymbol('bithumb', 'KRW-USDS')).toBe('USDS');
  });

  it('falls back to the next supported interval when needed', () => {
    expect(resolveExchangeInterval('coinone', '10m')).toEqual({
      requestedInterval: '10m',
      normalizedInterval: '10m',
      resolvedInterval: '15m',
      exchangeInterval: '15m',
      fallbackApplied: true,
    });
    expect(resolveExchangeInterval('upbit', '1h')).toEqual({
      requestedInterval: '1h',
      normalizedInterval: '1h',
      resolvedInterval: '1h',
      exchangeInterval: '60',
      fallbackApplied: false,
    });
  });

  it('canonicalizes asset image keys for alias and wrapped variants', () => {
    expect(resolveCanonicalAssetKey({
      exchange: 'binance',
      exchangeSymbol: 'ETHUSDC',
    })).toMatchObject({
      canonicalAssetKey: 'ETH',
      aliasHit: false,
    });

    expect(resolveCanonicalAssetKey({
      exchange: 'binance',
      exchangeSymbol: 'FDUSDUSDT',
    })).toMatchObject({
      canonicalAssetKey: 'FDUSD',
      aliasHit: false,
    });

    expect(resolveCanonicalAssetKey({
      exchange: 'bithumb',
      symbol: 'USDS',
      exchangeSymbol: 'KRW-USDS',
    })).toMatchObject({
      canonicalAssetKey: 'USDS',
      aliasHit: false,
    });

    expect(resolveCanonicalAssetKey({
      exchange: 'binance',
      symbol: '1000SHIB',
      exchangeSymbol: '1000SHIBUSDT',
    })).toMatchObject({
      canonicalAssetKey: 'SHIB',
      aliasHit: true,
    });

    expect(resolveCanonicalAssetKey({
      symbol: 'RNDR',
    })).toMatchObject({
      canonicalAssetKey: 'RENDER',
      aliasHit: true,
    });

    expect(resolveCanonicalAssetKey({
      symbol: 'USDC.E',
    })).toMatchObject({
      canonicalAssetKey: 'USDC',
      aliasHit: true,
    });

    expect(resolveCanonicalAssetKey({
      symbol: 'WBTC',
    })).toMatchObject({
      canonicalAssetKey: 'BTC',
      aliasHit: true,
    });

    expect(resolveCanonicalAssetKey({
      exchange: 'upbit',
      symbol: 'T',
      exchangeSymbol: 'KRW-T',
    })).toMatchObject({
      canonicalAssetKey: 'T',
      aliasHit: true,
      matchedBy: 'exchange_alias',
    });

    expect(resolveCanonicalAssetKey({
      exchange: 'binance',
      symbol: '1000000MOG',
      exchangeSymbol: '1000000MOGUSDT',
    })).toMatchObject({
      canonicalAssetKey: 'MOG',
      aliasHit: true,
    });

    expect(resolveCanonicalAssetKey({
      symbol: 'ETHFI',
    })).toMatchObject({
      canonicalAssetKey: 'ETHFI',
      aliasHit: false,
    });
  });

  it('resolves preferred image identities for numeric and short variants without fuzzy matches', () => {
    expect(resolvePreferredAssetImage({
      exchange: 'binance',
      canonicalAssetKey: 'CAT',
      symbol: '1000CAT',
      rawSymbol: '1000CATUSDT',
    })).toMatchObject({
      preferredImageSymbol: '1000CAT',
      preferredImageSlug: '1000cat',
      preferredImageCoingeckoId: '1000cat',
      resolutionSource: 'exchange_image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'BB',
      symbol: 'BB',
    })).toMatchObject({
      preferredImageSymbol: 'BB',
      preferredImageSlug: 'bouncebit',
      preferredImageCoingeckoId: 'bouncebit',
      resolutionSource: 'ultra_short_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'EUR',
      symbol: 'EUR',
    })).toMatchObject({
      preferredImageSymbol: 'EUR',
      imageMissingReason: 'fiat_or_quote_like_symbol',
      fallbackOnly: true,
      manualCurationRecommended: false,
    });
  });

  it('applies curated image slug mappings for priority manual curation targets', () => {
    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'ACE',
      symbol: 'ACE',
    })).toMatchObject({
      preferredImageSlug: 'endurance',
      preferredImageCoingeckoId: 'endurance',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'AUCTION',
      symbol: 'AUCTION',
    })).toMatchObject({
      preferredImageSlug: 'auction',
      preferredImageCoingeckoId: 'auction',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      exchange: 'upbit',
      canonicalAssetKey: 'CHIP',
      symbol: 'CHIP',
      rawSymbol: 'KRW-CHIP',
    })).toMatchObject({
      preferredImageSymbol: 'CHIP',
      preferredImageSlug: 'usdai',
      preferredImageCoingeckoId: 'usdai',
      resolutionSource: 'registry_direct',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      exchange: 'binance',
      canonicalAssetKey: 'BROCCOLI714',
      symbol: 'BROCCOLI714',
      rawSymbol: 'BROCCOLI714USDT',
    })).toMatchObject({
      preferredImageSymbol: 'BROCCOLI714',
      preferredImageSlug: 'czs-dog',
      preferredImageCoingeckoId: 'czs-dog',
      resolutionSource: 'exchange_image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      exchange: 'binance',
      canonicalAssetKey: 'BFUSD',
      symbol: 'BFUSD',
      rawSymbol: 'BFUSDUSDT',
    })).toMatchObject({
      preferredImageSymbol: 'BFUSD',
      preferredImageSlug: 'bfusd',
      preferredImageCoingeckoId: 'bfusd',
      resolutionSource: 'exchange_image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'CC',
      symbol: 'CC',
    })).toMatchObject({
      preferredImageSymbol: 'CC',
      imageMissingReason: 'ambiguous_short_symbol',
      fallbackOnly: true,
      manualCurationRecommended: true,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'TUSD',
      symbol: 'TUSD',
    })).toMatchObject({
      preferredImageSlug: 'true-usd',
      preferredImageCoingeckoId: 'true-usd',
      resolutionSource: 'registry_direct',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'CHR',
      symbol: 'CHR',
    })).toMatchObject({
      preferredImageSlug: 'chromaway',
      preferredImageCoingeckoId: 'chromaway',
      resolutionSource: 'registry_direct',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      exchange: 'binance',
      canonicalAssetKey: 'ATM',
      symbol: 'ATM',
      rawSymbol: 'ATMUSDT',
    })).toMatchObject({
      preferredImageSlug: 'atletico-madrid',
      preferredImageCoingeckoId: 'atletico-madrid',
      resolutionSource: 'exchange_image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'AVA',
      symbol: 'AVA',
    })).toMatchObject({
      preferredImageSlug: 'concierge-io',
      preferredImageCoingeckoId: 'concierge-io',
      resolutionSource: 'registry_direct',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'FRAX',
      symbol: 'FRAX',
    })).toMatchObject({
      preferredImageSlug: 'frax',
      preferredImageCoingeckoId: 'frax',
      resolutionSource: 'registry_direct',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'HIVE',
      symbol: 'HIVE',
    })).toMatchObject({
      preferredImageSlug: 'hive',
      preferredImageCoingeckoId: 'hive',
      resolutionSource: 'registry_direct',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'HOLO',
      symbol: 'HOLO',
    })).toMatchObject({
      preferredImageSlug: 'holo',
      preferredImageCoingeckoId: 'holo',
      resolutionSource: 'registry_direct',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'SAFE',
      symbol: 'SAFE',
    })).toMatchObject({
      preferredImageSlug: 'safe',
      preferredImageCoingeckoId: 'safe',
      resolutionSource: 'registry_direct',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'MON',
      symbol: 'MON',
    })).toMatchObject({
      preferredImageSlug: 'monad',
      preferredImageCoingeckoId: 'monad',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'ORDER',
      symbol: 'ORDER',
    })).toMatchObject({
      preferredImageSlug: 'orderly-network',
      preferredImageCoingeckoId: 'orderly-network',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'XPLA',
      symbol: 'XPLA',
    })).toMatchObject({
      preferredImageSymbol: 'CONX',
      preferredImageSlug: 'xpla',
      preferredImageCoingeckoId: 'xpla',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'BOBA',
      symbol: 'BOBA',
    })).toMatchObject({
      preferredImageSlug: 'boba-network',
      preferredImageCoingeckoId: 'boba-network',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'DBR',
      symbol: 'DBR',
    })).toMatchObject({
      preferredImageSlug: 'debridge',
      preferredImageCoingeckoId: 'debridge',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'IOTX',
      symbol: 'IOTX',
    })).toMatchObject({
      preferredImageSlug: 'iotex',
      preferredImageCoingeckoId: 'iotex',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'MASK',
      symbol: 'MASK',
    })).toMatchObject({
      preferredImageSlug: 'mask-network',
      preferredImageCoingeckoId: 'mask-network',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'NXPC',
      symbol: 'NXPC',
    })).toMatchObject({
      preferredImageSlug: 'nexpace',
      preferredImageCoingeckoId: 'nexpace',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'SOPH',
      symbol: 'SOPH',
    })).toMatchObject({
      preferredImageSlug: 'sophon',
      preferredImageCoingeckoId: 'sophon',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'TRAC',
      symbol: 'TRAC',
    })).toMatchObject({
      preferredImageSlug: 'origintrail',
      preferredImageCoingeckoId: 'origintrail',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'ZRX',
      symbol: 'ZRX',
    })).toMatchObject({
      preferredImageSlug: '0x',
      preferredImageCoingeckoId: '0x',
      resolutionSource: 'image_alias_override',
      fallbackOnly: false,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'KITE',
      symbol: 'KITE',
    })).toMatchObject({
      preferredImageSymbol: 'KITE',
      imageMissingReason: 'missing_curated_mapping',
      fallbackOnly: true,
      manualCurationRecommended: true,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'BRETT',
      symbol: 'BRETT',
    })).toMatchObject({
      preferredImageSymbol: 'BRETT',
      imageMissingReason: 'missing_curated_mapping',
      fallbackOnly: true,
      manualCurationRecommended: true,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'BASED',
      symbol: 'BASED',
    })).toMatchObject({
      preferredImageSymbol: 'BASED',
      imageMissingReason: 'missing_curated_mapping',
      fallbackOnly: true,
      manualCurationRecommended: true,
    });

    expect(resolvePreferredAssetImage({
      canonicalAssetKey: 'BOB',
      symbol: 'BOB',
    })).toMatchObject({
      preferredImageSymbol: 'BOB',
      imageMissingReason: 'missing_curated_mapping',
      fallbackOnly: true,
      manualCurationRecommended: true,
    });

    expect(resolvePreferredAssetImage({
      exchange: 'binance',
      canonicalAssetKey: 'EPIC',
      symbol: 'EPIC',
      rawSymbol: 'EPICUSDT',
    })).toMatchObject({
      preferredImageSymbol: 'EPIC',
      imageMissingReason: 'missing_curated_mapping',
      fallbackOnly: true,
      manualCurationRecommended: true,
    });
  });
});
