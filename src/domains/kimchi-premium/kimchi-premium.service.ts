import { COIN_MAP } from '../../config/constants';
import { env } from '../../config/env';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import type { ExchangeId, KimchiPremiumEntry } from '../../core/exchange/exchange.types';

const DOMESTIC_EXCHANGES: ExchangeId[] = ['upbit', 'bithumb', 'coinone', 'korbit'];

export async function getKimchiPremium(symbols: string[]): Promise<KimchiPremiumEntry[]> {
  const fxRate = await exchangeProviderRegistry.getFxRateProvider().getUsdKrwRate();
  const referenceSource = exchangeProviderRegistry.getReferencePriceSource();
  const now = Date.now();

  const results = await Promise.all(
    symbols.map(async (inputSymbol) => {
      const symbol = inputSymbol.trim().toUpperCase();
      const coin = COIN_MAP.get(symbol);
      if (!coin) return null;

      const referenceTicker = await referenceSource.getReferenceTicker(symbol);
      if (!referenceTicker) return null;

      const binanceKrwPrice = referenceTicker.price * fxRate.rate;
      const domesticTickers = await Promise.all(
        DOMESTIC_EXCHANGES.map(async (exchange) => {
          const [ticker] = await exchangeProviderRegistry.getMarketDataProvider(exchange).getTickerSnapshot([symbol]);
          if (!ticker) return null;
          return {
            exchange,
            market: ticker.market,
            priceKrw: ticker.price,
            premiumPercent: binanceKrwPrice > 0 ? ((ticker.price - binanceKrwPrice) / binanceKrwPrice) * 100 : 0,
            timestamp: ticker.timestamp,
          };
        }),
      );

      const timestamps = [
        referenceTicker.timestamp,
        fxRate.timestamp,
        ...domesticTickers.filter((item): item is NonNullable<typeof item> => item !== null).map((item) => item.timestamp),
      ];
      const newest = Math.max(...timestamps);
      const oldest = Math.min(...timestamps);
      const stale = timestamps.some((timestamp) => now - timestamp > env.FX_STALE_THRESHOLD_MS);

      return {
        symbol,
        nameKo: coin.nameKo,
        nameEn: coin.nameEn,
        binanceUsdtPrice: referenceTicker.price,
        usdKrwRate: fxRate.rate,
        binanceKrwPrice,
        domestic: domesticTickers.filter((item): item is NonNullable<typeof item> => item !== null),
        stale,
        timestampSkewMs: newest - oldest,
      };
    }),
  );

  return results.filter((item): item is KimchiPremiumEntry => item !== null);
}
