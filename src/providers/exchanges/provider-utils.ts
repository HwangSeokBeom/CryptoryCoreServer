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
