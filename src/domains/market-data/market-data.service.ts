import { COIN_MAP } from '../../config/constants';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import type { CanonicalCandle, CanonicalOrderbookSnapshot, CanonicalTickerSnapshot, CanonicalTrade, ExchangeId } from '../../core/exchange/exchange.types';

export async function listMarkets(exchange?: ExchangeId) {
  const providers = exchange
    ? [exchangeProviderRegistry.getMarketDataProvider(exchange)]
    : exchangeProviderRegistry.listMarketDataProviders();

  const results = await Promise.all(
    providers.map(async (provider) => {
      const markets = await provider.listMarkets();
      return markets.map((item) => ({
        exchange: provider.exchange,
        exchangeName: provider.metadata.displayName,
        symbol: item.symbol,
        market: item.market,
        rawSymbol: item.rawSymbol,
        quoteCurrency: provider.metadata.quoteCurrency,
        nameKo: COIN_MAP.get(item.symbol)?.nameKo,
        nameEn: COIN_MAP.get(item.symbol)?.nameEn,
      }));
    }),
  );

  return results.flat();
}

export async function getTickers(params: { exchange?: ExchangeId; symbol?: string }) {
  const providers = params.exchange
    ? [exchangeProviderRegistry.getMarketDataProvider(params.exchange)]
    : exchangeProviderRegistry.listMarketDataProviders();
  const symbols = params.symbol ? [params.symbol] : undefined;
  const results = await Promise.all(providers.map((provider) => provider.getTickerSnapshot(symbols)));
  return results.flat();
}

export async function getOrderbook(exchange: ExchangeId, symbol: string): Promise<CanonicalOrderbookSnapshot> {
  return exchangeProviderRegistry.getMarketDataProvider(exchange).getOrderbookSnapshot(symbol);
}

export async function getTrades(exchange: ExchangeId, symbol: string, limit?: number): Promise<CanonicalTrade[]> {
  return exchangeProviderRegistry.getMarketDataProvider(exchange).getRecentTrades(symbol, limit);
}

export async function getCandles(
  exchange: ExchangeId,
  symbol: string,
  interval: string,
  limit?: number,
): Promise<CanonicalCandle[]> {
  return exchangeProviderRegistry.getMarketDataProvider(exchange).getCandles(symbol, interval, limit);
}

export async function getReferenceTicker(symbol: string) {
  return exchangeProviderRegistry.getReferencePriceSource().getReferenceTicker(symbol);
}
