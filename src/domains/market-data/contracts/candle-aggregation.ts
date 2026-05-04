import type { ContractTimeframe, MarketCandle } from './market-data.types';

const TIMEFRAME_MS: Record<ContractTimeframe, number> = {
  '1M': 60_000,
  '5M': 5 * 60_000,
  '15M': 15 * 60_000,
  '1H': 60 * 60_000,
  '4H': 4 * 60 * 60_000,
  '1D': 24 * 60 * 60_000,
  '1W': 7 * 24 * 60 * 60_000,
};

export function timeframeToMilliseconds(timeframe: ContractTimeframe) {
  return TIMEFRAME_MS[timeframe];
}

export function floorTimestampToBucket(timestampMs: number, timeframe: ContractTimeframe) {
  const bucketMs = timeframeToMilliseconds(timeframe);
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

export function aggregateCandles(candles: MarketCandle[], timeframe: ContractTimeframe, limit: number): MarketCandle[] {
  const buckets = new Map<number, MarketCandle>();
  const ordered = [...candles].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

  for (const candle of ordered) {
    const bucketStart = floorTimestampToBucket(Date.parse(candle.timestamp), timeframe);
    const existing = buckets.get(bucketStart);
    if (!existing) {
      buckets.set(bucketStart, {
        timestamp: new Date(bucketStart).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        quoteVolume: candle.quoteVolume,
      });
      continue;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
    existing.quoteVolume += candle.quoteVolume;
  }

  return Array.from(buckets.values())
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-limit);
}

export function evaluateAlertCondition(params: {
  condition: 'ABOVE' | 'BELOW';
  currentPrice: number;
  targetPrice: number;
}) {
  return params.condition === 'ABOVE'
    ? params.currentPrice >= params.targetPrice
    : params.currentPrice <= params.targetPrice;
}

export function isRepeatAlertInCooldown(params: {
  repeatMode: 'ONCE' | 'REPEAT';
  lastTriggeredAt?: Date | string | null;
  now?: Date;
  cooldownSeconds: number;
}) {
  if (params.repeatMode !== 'REPEAT' || !params.lastTriggeredAt) {
    return false;
  }
  const now = params.now?.getTime() ?? Date.now();
  const previous = params.lastTriggeredAt instanceof Date
    ? params.lastTriggeredAt.getTime()
    : Date.parse(params.lastTriggeredAt);
  return Number.isFinite(previous) && now - previous < params.cooldownSeconds * 1000;
}
