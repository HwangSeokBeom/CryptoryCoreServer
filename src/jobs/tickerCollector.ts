import cron from 'node-cron';
import { env } from '../config/env';
import { exchangeProviderRegistry } from '../core/exchange/registry.bootstrap';
import { assetMetadataService } from '../domains/assets/asset-metadata.service';
import { startChartLiveService, stopChartLiveService } from '../domains/charts/chart.service';
import { startMarketSnapshotCache, stopMarketSnapshotCache } from '../domains/market-data/market-data.service';
import { marketStreamingOrchestrator } from '../domains/market-data/market-streaming.orchestrator';
import { logger } from '../utils/logger';

let rateTask: cron.ScheduledTask | null = null;
let collectorStartTimer: NodeJS.Timeout | null = null;
let collectorStarted = false;

export function startTickerCollector() {
  if (collectorStarted) {
    logger.warn({ domain: 'market-streaming' }, 'Ticker collector start skipped because it is already running');
    return;
  }

  if (!env.MARKET_COLLECTOR_ENABLED) {
    logger.info(
      { domain: 'startup-jobs', job: 'marketCollector', reason: 'disabled_by_env' },
      '[StartupJobs] skipped job=marketCollector reason=disabled_by_env',
    );
    return;
  }

  collectorStarted = true;
  const startupDelayMs = 15_000;
  logger.info(
    {
      domain: 'market-collector',
      job: 'marketCollector',
      startupDelayMs,
      tradeCollectorEnabled: env.MARKET_TRADE_COLLECTOR_ENABLED,
      startupWarmupEnabled: env.MARKET_STARTUP_WARMUP_ENABLED,
    },
    `[MarketCollector] scheduled startupDelayMs=${startupDelayMs} tradeCollectorEnabled=${env.MARKET_TRADE_COLLECTOR_ENABLED}`,
  );
  if (!env.MARKET_TRADE_COLLECTOR_ENABLED) {
    logger.info(
      { domain: 'startup-jobs', job: 'marketTradeCollector', reason: 'disabled_by_env' },
      '[StartupJobs] skipped job=marketTradeCollector reason=disabled_by_env',
    );
  }
  if (!env.MARKET_STARTUP_WARMUP_ENABLED) {
    logger.info(
      { domain: 'startup-jobs', job: 'marketStartupWarmup', reason: 'disabled_by_env' },
      '[StartupJobs] skipped job=marketStartupWarmup reason=disabled_by_env',
    );
  }

  collectorStartTimer = setTimeout(() => {
    collectorStartTimer = null;
    void marketStreamingOrchestrator.start({ includeTrades: env.MARKET_TRADE_COLLECTOR_ENABLED });
    void startMarketSnapshotCache();
    startChartLiveService();
    assetMetadataService.start();
    logger.info(
      { domain: 'market-collector', tradeCollectorEnabled: env.MARKET_TRADE_COLLECTOR_ENABLED },
      '[MarketCollector] started',
    );
  }, startupDelayMs);
  collectorStartTimer.unref?.();

  rateTask = cron.schedule('0 * * * *', async () => {
    try {
      await exchangeProviderRegistry.getFxRateProvider().getUsdKrwRate();
    } catch (err) {
      logger.error({ err }, 'USD/KRW rate refresh failed');
    }
  });

  // Lightweight FX refresh is independent from exchange trade/candle hydration.
  exchangeProviderRegistry.getFxRateProvider().getUsdKrwRate().catch(() => {});
}

export async function stopTickerCollector() {
  if (!collectorStarted) {
    return;
  }

  collectorStarted = false;
  if (collectorStartTimer) {
    clearTimeout(collectorStartTimer);
    collectorStartTimer = null;
  }
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
