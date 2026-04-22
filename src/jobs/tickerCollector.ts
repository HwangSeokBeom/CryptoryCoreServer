import cron from 'node-cron';
import { exchangeProviderRegistry } from '../core/exchange/registry.bootstrap';
import { assetMetadataService } from '../domains/assets/asset-metadata.service';
import { startChartLiveService, stopChartLiveService } from '../domains/charts/chart.service';
import { startMarketSnapshotCache, stopMarketSnapshotCache } from '../domains/market-data/market-data.service';
import { marketStreamingOrchestrator } from '../domains/market-data/market-streaming.orchestrator';
import { logger } from '../utils/logger';

let rateTask: cron.ScheduledTask | null = null;
let collectorStarted = false;

export function startTickerCollector() {
  if (collectorStarted) {
    logger.warn({ domain: 'market-streaming' }, 'Ticker collector start skipped because it is already running');
    return;
  }

  collectorStarted = true;
  void marketStreamingOrchestrator.start();
  void startMarketSnapshotCache();
  startChartLiveService();
  assetMetadataService.start();

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

export async function stopTickerCollector() {
  if (!collectorStarted) {
    return;
  }

  collectorStarted = false;
  await Promise.allSettled([
    marketStreamingOrchestrator.stop(),
    stopMarketSnapshotCache(),
  ]);
  stopChartLiveService();
  assetMetadataService.stop();
  rateTask?.stop();
  const destroyTask = (rateTask as cron.ScheduledTask & { destroy?: () => void } | null)?.destroy;
  destroyTask?.call(rateTask);
  rateTask = null;
  logger.info({ domain: 'market-streaming' }, 'Public market orchestrator stopped');
}
