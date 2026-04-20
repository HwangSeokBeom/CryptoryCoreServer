import { ExchangeAuthError } from '../../core/exchange/errors';
import type {
  Balance,
  CanonicalOrderStatus,
  CanonicalOrderType,
  ExchangeId,
  PortfolioPosition,
  PortfolioSnapshot,
  UserExchangeCredentials,
} from '../../core/exchange/exchange.types';
import type { ProviderContext } from '../../core/exchange/provider.interfaces';

export function safeNumber(value: unknown) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;

  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortAsks(levels: Array<{ price: number; quantity: number }>, depth = 15) {
  return levels
    .filter((entry) => entry.price > 0 && entry.quantity >= 0)
    .sort((left, right) => left.price - right.price)
    .slice(0, depth);
}

export function sortBids(levels: Array<{ price: number; quantity: number }>, depth = 15) {
  return levels
    .filter((entry) => entry.price > 0 && entry.quantity >= 0)
    .sort((left, right) => right.price - left.price)
    .slice(0, depth);
}

export function safeString(value: unknown) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

type TimestampAssumption = 'UTC' | 'KST';

export type TimestampNormalizationResult = {
  raw: unknown;
  timestamp: number | null;
  reason: string | null;
};

const MIN_PLAUSIBLE_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_PLAUSIBLE_TIMESTAMP_MS = Date.UTC(2101, 0, 1);

function isPlausibleTimestamp(timestamp: number) {
  return Number.isFinite(timestamp)
    && timestamp >= MIN_PLAUSIBLE_TIMESTAMP_MS
    && timestamp < MAX_PLAUSIBLE_TIMESTAMP_MS;
}

function normalizeNumericTimestamp(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const candidates = [
    value >= 1_000_000_000_000_000 ? Math.trunc(value / 1_000) : null,
    value >= 1_000_000_000_000 ? Math.trunc(value) : null,
    value >= 1_000_000_000 ? Math.trunc(value * 1_000) : null,
  ].filter((candidate): candidate is number => candidate !== null);

  return candidates.find((candidate) => isPlausibleTimestamp(candidate)) ?? null;
}

function parseTimestampWithAssumption(value: string, assumption: TimestampAssumption) {
  const hasExplicitTimezone = /[zZ]|[+-]\d{2}:\d{2}$/.test(value);
  if (hasExplicitTimezone) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) || !isPlausibleTimestamp(parsed) ? null : parsed;
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/,
  );
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) || !isPlausibleTimestamp(parsed) ? null : parsed;
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText = '0',
    fractionalText = '0',
  ] = match;
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = Number.parseInt(secondText, 10);
  const millisecond = Number.parseInt(fractionalText.padEnd(3, '0').slice(0, 3), 10);
  const offsetMinutes = assumption === 'KST' ? 9 * 60 : 0;
  const parsed = Date.UTC(year, month - 1, day, hour, minute - offsetMinutes, second, millisecond);
  return isPlausibleTimestamp(parsed) ? parsed : null;
}

export function normalizeExchangeTimestamp(
  value: unknown,
  options?: {
    assumeTimezone?: TimestampAssumption;
    rejectDateOnly?: boolean;
  },
): TimestampNormalizationResult {
  if (value === null || value === undefined) {
    return { raw: value, timestamp: null, reason: 'missing' };
  }

  if (typeof value === 'number') {
    const normalized = normalizeNumericTimestamp(value);
    return {
      raw: value,
      timestamp: normalized,
      reason: normalized === null ? 'invalid_numeric_timestamp' : null,
    };
  }

  if (value instanceof Date) {
    const timestamp = value.getTime();
    return {
      raw: value.toISOString(),
      timestamp: isPlausibleTimestamp(timestamp) ? timestamp : null,
      reason: isPlausibleTimestamp(timestamp) ? null : 'invalid_date_object',
    };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return { raw: value, timestamp: null, reason: 'empty_string' };
    }

    if ((options?.rejectDateOnly ?? true) && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return { raw: trimmed, timestamp: null, reason: 'date_only_string_blocked' };
    }

    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return normalizeExchangeTimestamp(Number.parseFloat(trimmed), options);
    }

    const normalized = parseTimestampWithAssumption(trimmed, options?.assumeTimezone ?? 'UTC');
    return {
      raw: trimmed,
      timestamp: normalized,
      reason: normalized === null ? 'unparseable_timestamp_string' : null,
    };
  }

  return {
    raw: value,
    timestamp: null,
    reason: 'unsupported_timestamp_type',
  };
}

export function normalizeExchangeTimestampFromCandidates(
  candidates: unknown[],
  options?: {
    assumeTimezone?: TimestampAssumption;
    rejectDateOnly?: boolean;
  },
): TimestampNormalizationResult {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') {
      continue;
    }

    const normalized = normalizeExchangeTimestamp(candidate, options);
    if (normalized.timestamp !== null) {
      return normalized;
    }
  }

  const raw = candidates.find((candidate) => candidate !== null && candidate !== undefined && candidate !== '') ?? null;
  const fallback = raw !== null
    ? normalizeExchangeTimestamp(raw, options)
    : { raw, timestamp: null, reason: 'missing' as const };
  return {
    raw,
    timestamp: null,
    reason: fallback.reason ?? 'missing',
  };
}

export function toIsoTimestamp(timestamp: number | null | undefined) {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

export function toTimestamp(value: unknown) {
  if (typeof value === 'number') {
    if (value > 1_000_000_000_000) return value;
    if (value > 1_000_000_000) return value * 1000;
    return value;
  }

  if (typeof value === 'string') {
    const numeric = Number.parseFloat(value);
    if (Number.isFinite(numeric)) {
      return toTimestamp(numeric);
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return Date.now();
}

const INTERVAL_MS_MAP: Record<string, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

export function intervalToMilliseconds(interval: string) {
  return INTERVAL_MS_MAP[interval] ?? null;
}

export function toHistoricalCandleWindow(params: {
  interval: string;
  timestamp: unknown;
  index: number;
  total: number;
  now?: number;
}) {
  const intervalMs = intervalToMilliseconds(params.interval) ?? 60_000;
  const rawTimestamp = toTimestamp(params.timestamp);
  const usableTimestamp = rawTimestamp >= 946_684_800_000 ? rawTimestamp : null;

  if (usableTimestamp !== null) {
    const openTime = Math.floor(usableTimestamp / intervalMs) * intervalMs;
    return {
      openTime,
      closeTime: openTime + intervalMs,
      intervalMs,
    };
  }

  const bucketStart = Math.floor((params.now ?? Date.now()) / intervalMs) * intervalMs;
  const openTime = bucketStart - Math.max(params.total - params.index, 1) * intervalMs;
  return {
    openTime,
    closeTime: openTime + intervalMs,
    intervalMs,
  };
}

export function requireCredentials(exchange: ExchangeId, context: ProviderContext): UserExchangeCredentials {
  if (!context.credentials) {
    throw new ExchangeAuthError(exchange, `${exchange} credentials are required`);
  }

  return context.credentials;
}

export function normalizeOrderType(value: unknown): CanonicalOrderType {
  const normalized = safeString(value).toLowerCase();
  if (normalized === 'limit') return 'limit';
  if (normalized === 'stop_limit' || normalized === 'stop-limit' || normalized === 'stoplimit') return 'stop_limit';
  if (normalized === 'market' || normalized === 'price') return 'market';
  return 'limit';
}

export function normalizeOrderStatus(params: {
  state: unknown;
  quantity: number;
  filledQuantity: number;
  remainingQuantity?: number;
  openStates?: string[];
  cancelledStates?: string[];
  filledStates?: string[];
  rejectedStates?: string[];
}) : CanonicalOrderStatus {
  const state = safeString(params.state).toLowerCase();
  const remainingQuantity =
    params.remainingQuantity !== undefined
      ? params.remainingQuantity
      : Math.max(params.quantity - params.filledQuantity, 0);
  const openStates = params.openStates ?? ['wait', 'watch', 'open', 'live', 'unfilled', 'pending'];
  const cancelledStates = params.cancelledStates ?? ['cancel', 'cancelled', 'canceled', 'partially_canceled', 'partiallyfilledcanceled', 'partially_filled_canceled'];
  const filledStates = params.filledStates ?? ['done', 'filled', 'trade_done'];
  const rejectedStates = params.rejectedStates ?? ['rejected', 'expired', 'cancel_post_only', 'canceled_no_order', 'canceled_limit_price_exceed', 'canceled_under_product_unit'];

  if (rejectedStates.includes(state)) return 'rejected';
  if (filledStates.includes(state)) return 'filled';
  if (cancelledStates.includes(state)) return 'cancelled';
  if (params.filledQuantity > 0 && remainingQuantity > 0) return 'partial';
  if (params.filledQuantity > 0 && remainingQuantity <= 0) return 'filled';
  if (openStates.includes(state)) return 'open';
  return 'pending';
}

export async function buildPortfolioSnapshot(params: {
  exchange: ExchangeId;
  balances: Balance[];
  resolvePrices: (symbols: string[]) => Promise<Map<string, number>>;
}) : Promise<PortfolioSnapshot> {
  const now = Date.now();
  const positionSymbols = params.balances
    .filter((balance) => balance.asset !== 'KRW' && balance.free + balance.locked > 0)
    .map((balance) => balance.asset);
  const priceMap = await params.resolvePrices(positionSymbols);

  const positions: PortfolioPosition[] = params.balances
    .filter((balance) => balance.asset !== 'KRW' && balance.free + balance.locked > 0)
    .map((balance) => {
      const quantity = balance.free + balance.locked;
      const averageBuyPrice = balance.averageBuyPrice ?? 0;
      const currentPrice = priceMap.get(balance.asset) ?? 0;
      const marketValue = quantity * currentPrice;
      const totalCost = quantity * averageBuyPrice;
      const pnlValue = marketValue - totalCost;

      return {
        exchange: params.exchange,
        symbol: balance.asset,
        quantity,
        free: balance.free,
        locked: balance.locked,
        averageBuyPrice,
        currentPrice,
        marketValue,
        pnlValue,
        pnlPercent: totalCost > 0 ? (pnlValue / totalCost) * 100 : 0,
        timestamp: now,
      };
    });

  const cashValue = params.balances
    .filter((balance) => balance.asset === 'KRW')
    .reduce((sum, balance) => sum + balance.free + balance.locked, 0);
  const totalAssetValue = cashValue + positions.reduce((sum, position) => sum + position.marketValue, 0);
  const totalCost = positions.reduce((sum, position) => sum + position.averageBuyPrice * position.quantity, 0);
  const totalPnlValue = positions.reduce((sum, position) => sum + position.pnlValue, 0);

  return {
    exchange: params.exchange,
    balances: params.balances,
    positions,
    totalAssetValue,
    totalPnlValue,
    totalPnlPercent: totalCost > 0 ? (totalPnlValue / totalCost) * 100 : 0,
    timestamp: now,
  };
}
