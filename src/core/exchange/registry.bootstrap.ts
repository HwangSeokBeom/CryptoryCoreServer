import { ExchangeProviderRegistry } from './provider.registry';
import { BinanceProvider } from '../../providers/exchanges/binance.provider';
import { BithumbProvider } from '../../providers/exchanges/bithumb.provider';
import { CoinoneProvider } from '../../providers/exchanges/coinone.provider';
import { KorbitProvider } from '../../providers/exchanges/korbit.provider';
import { UpbitProvider } from '../../providers/exchanges/upbit.provider';
import { ExchangeRateHostProvider } from '../../providers/fx/exchange-rate-host.provider';

const registry = new ExchangeProviderRegistry();

const upbitProvider = new UpbitProvider();
const bithumbProvider = new BithumbProvider();
const coinoneProvider = new CoinoneProvider();
const korbitProvider = new KorbitProvider();
const binanceProvider = new BinanceProvider();
const fxProvider = new ExchangeRateHostProvider();

registry
  .registerMarketDataProvider(upbitProvider)
  .registerStreamingProvider(upbitProvider)
  .registerTradingProvider(upbitProvider)
  .registerPortfolioProvider(upbitProvider)
  .registerMarketDataProvider(bithumbProvider)
  .registerStreamingProvider(bithumbProvider)
  .registerMarketDataProvider(coinoneProvider)
  .registerStreamingProvider(coinoneProvider)
  .registerMarketDataProvider(korbitProvider)
  .registerStreamingProvider(korbitProvider)
  .registerMarketDataProvider(binanceProvider)
  .registerStreamingProvider(binanceProvider)
  .registerReferencePriceSource(binanceProvider)
  .registerFxRateProvider(fxProvider);

export const exchangeProviderRegistry = registry;
