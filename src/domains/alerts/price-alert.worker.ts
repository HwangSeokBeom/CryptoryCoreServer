import { env } from '../../config/env';
import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import {
  getCurrentPriceSnapshots,
} from '../market-data/contracts/market-data-contract.service';
import type { ContractExchange, ContractQuoteCurrency } from '../market-data/contracts/market-data.types';
import { shouldTriggerPriceAlert, triggerPriceAlert } from './price-alert.service';

let timer: NodeJS.Timeout | null = null;
let running = false;

function marketKey(alert: { exchange: string; symbol: string; quoteCurrency: string }) {
  return `${alert.exchange}:${alert.quoteCurrency}:${alert.symbol}`;
}

export async function runPriceAlertWorkerTick() {
  if (running) {
    return;
  }
  running = true;
  try {
    const alerts = await prisma.priceAlert.findMany({ where: { isActive: true } });
    const groups = new Map<string, {
      exchange: ContractExchange;
      symbol: string;
      quoteCurrency: ContractQuoteCurrency;
    }>();

    for (const alert of alerts) {
      groups.set(marketKey(alert), {
        exchange: alert.exchange as ContractExchange,
        symbol: alert.symbol,
        quoteCurrency: alert.quoteCurrency as ContractQuoteCurrency,
      });
    }

    logger.info(
      { domain: 'price-alert-worker', activeAlerts: alerts.length, marketGroups: groups.size },
      `[PriceAlertWorker] tick activeAlerts=${alerts.length} marketGroups=${groups.size}`,
    );

    if (groups.size === 0) {
      return;
    }

    const prices = await getCurrentPriceSnapshots(Array.from(groups.values()));
    const priceByKey = new Map(prices.map((price) => [
      `${price.exchange}:${price.quoteCurrency}:${price.symbol}`,
      price.currentPrice,
    ]));

    for (const alert of alerts) {
      const currentPrice = priceByKey.get(marketKey(alert));
      if (currentPrice === undefined) {
        continue;
      }
      if (!shouldTriggerPriceAlert(alert, currentPrice)) {
        continue;
      }
      logger.info(
        {
          domain: 'price-alert-worker',
          alertId: alert.id,
          symbol: alert.symbol,
          current: currentPrice,
          target: alert.targetPrice,
        },
        `[PriceAlertWorker] triggered alertId=${alert.id} symbol=${alert.symbol} current=${currentPrice} target=${alert.targetPrice}`,
      );
      await triggerPriceAlert(alert, currentPrice);
    }
  } catch (error) {
    logger.error({ domain: 'price-alert-worker', err: error }, 'Price alert worker tick failed');
  } finally {
    running = false;
  }
}

export function startPriceAlertWorker() {
  if (!env.PRICE_ALERT_WORKER_ENABLED || timer) {
    return;
  }
  timer = setInterval(() => {
    void runPriceAlertWorkerTick();
  }, env.PRICE_ALERT_POLL_INTERVAL_MS);
  timer.unref();
  void runPriceAlertWorkerTick();
}

export function stopPriceAlertWorker() {
  if (!timer) {
    return;
  }
  clearInterval(timer);
  timer = null;
}
