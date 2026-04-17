import { COIN_MAP } from '../../config/constants';
import { env } from '../../config/env';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import type { ExchangeId, KimchiPremiumEntry } from '../../core/exchange/exchange.types';
import { AppError } from '../../utils/errors';

const DOMESTIC_EXCHANGES: ExchangeId[] = ['upbit', 'bithumb', 'coinone', 'korbit'];

export async function getKimchiPremium(symbols: string[]): Promise<KimchiPremiumEntry[]> {
  const fxRate = await exchangeProviderRegistry.getFxRateProvider().getUsdKrwRate();
  const referenceSource = exchangeProviderRegistry.getReferencePriceSource();
  const now = Date.now();

  const results = await Promise.all(
    symbols.map(async (inputSymbol) => {
      const symbol = inputSymbol.trim().toUpperCase();
      const coin = COIN_MAP.get(symbol);
      if (!coin) {
        throw new AppError(400, `unsupported symbol: ${symbol}`);
      }

      const referenceTicker = await referenceSource.getReferenceTicker(symbol);
      if (!referenceTicker) {
        throw new AppError(404, `reference price unavailable for ${symbol}`);
      }

      const binanceKrwPrice = referenceTicker.price * fxRate.rate;
      const referenceStaleAgeMs = Math.max(now - referenceTicker.timestamp, 0);
      const fxStaleAgeMs = Math.max(now - fxRate.timestamp, 0);
      const domesticTickers = await Promise.all(
        DOMESTIC_EXCHANGES.map(async (exchange) => {
          const [ticker] = await exchangeProviderRegistry.getMarketDataProvider(exchange).getTickerSnapshot([symbol]);
          if (!ticker) return null;
          const staleAgeMs = Math.max(now - ticker.timestamp, 0);
          return {
            exchange,
            market: ticker.market,
            priceKrw: ticker.price,
            premiumPercent: binanceKrwPrice > 0 ? ((ticker.price - binanceKrwPrice) / binanceKrwPrice) * 100 : 0,
            timestamp: ticker.timestamp,
            sourceExchange: exchange,
            sourceTimestamp: ticker.timestamp,
            stale: staleAgeMs > env.MARKET_DATA_STALE_THRESHOLD_MS,
            staleAgeMs,
            krwConvertedReference: binanceKrwPrice,
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
      const stale = timestamps.some((timestamp) => now - timestamp > env.MARKET_DATA_STALE_THRESHOLD_MS)
        || newest - oldest > env.FX_TIMESTAMP_SKEW_THRESHOLD_MS;

      return {
        symbol,
        nameKo: coin.nameKo,
        nameEn: coin.nameEn,
        referenceExchange: referenceTicker.exchange,
        referenceMarket: referenceTicker.market,
        referenceTimestamp: referenceTicker.timestamp,
        referenceStale: referenceStaleAgeMs > env.MARKET_DATA_STALE_THRESHOLD_MS,
        referenceStaleAgeMs,
        binanceUsdtPrice: referenceTicker.price,
        usdKrwRate: fxRate.rate,
        binanceKrwPrice,
        krwConvertedReference: binanceKrwPrice,
        fxProvider: fxRate.provider,
        fxTimestamp: fxRate.timestamp,
        fxStale: fxStaleAgeMs > env.FX_STALE_THRESHOLD_MS,
        fxStaleAgeMs,
        domestic: domesticTickers.filter((item): item is NonNullable<typeof item> => item !== null),
        stale,
        timestampSkewMs: newest - oldest,
      };
    }),
  );

  return results.filter((item): item is KimchiPremiumEntry => item !== null);
}
