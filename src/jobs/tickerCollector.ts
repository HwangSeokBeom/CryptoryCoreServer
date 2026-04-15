import cron from 'node-cron';
import { exchangeProviderRegistry } from '../core/exchange/registry.bootstrap';
import { marketStreamingOrchestrator } from '../domains/market-data/market-streaming.orchestrator';
import { logger } from '../utils/logger';

let rateTask: cron.ScheduledTask | null = null;

export function startTickerCollector() {
  void marketStreamingOrchestrator.start();

  rateTask = cron.schedule('0 * * * *', async () => {
    try {
      await exchangeProviderRegistry.getFxRateProvider().getUsdKrwRate();
    } catch (err) {
      logger.error({ err }, 'USD/KRW rate refresh failed');
    }
  });

  // Initial rate fetch
  exchangeProviderRegistry.getFxRateProvider().getUsdKrwRate().catch(() => {});

  logger.info({ domain: 'market-streaming' }, 'Public market orchestrator started');
}

export function stopTickerCollector() {
  void marketStreamingOrchestrator.stop();
  rateTask?.stop();
  logger.info({ domain: 'market-streaming' }, 'Public market orchestrator stopped');
}
