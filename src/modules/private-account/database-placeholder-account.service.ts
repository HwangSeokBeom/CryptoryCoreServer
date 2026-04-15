import { prisma } from '../../config/database';
import { getCurrentPrice } from '../tickers/tickers.service';

function mapOrder(order: {
  id: string;
  coinId: string;
  exchange: string;
  side: string;
  type: string;
  price: number;
  quantity: number;
  total: number;
  status: string;
  createdAt: Date;
}) {
  return {
    id: order.id,
    symbol: order.coinId,
    exchange: order.exchange,
    side: order.side,
    type: order.type,
    price: order.price,
    quantity: order.quantity,
    total: order.total,
    status: order.status,
    createdAt: order.createdAt,
  };
}

export async function getPlaceholderBalances(userId: string, exchange = 'upbit') {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const holdings = await prisma.holding.findMany({ where: { userId } });

  const assetBalances = await Promise.all(
    holdings.map(async (holding) => {
      const price = await getCurrentPrice(holding.coinId, exchange);
      return {
        asset: holding.coinId,
        free: holding.quantity,
        locked: 0,
        avgPrice: holding.avgPrice,
        currentPrice: price,
        evalAmount: price * holding.quantity,
      };
    }),
  );

  return {
    exchange,
    cash: {
      asset: 'KRW',
      free: user.cash,
      locked: 0,
    },
    assets: assetBalances,
  };
}

export async function getPlaceholderHoldings(userId: string, exchange = 'upbit') {
  const holdings = await prisma.holding.findMany({ where: { userId } });

  return Promise.all(
    holdings.map(async (holding) => {
      const currentPrice = await getCurrentPrice(holding.coinId, exchange);
      const evalAmount = currentPrice * holding.quantity;
      const pnl = (currentPrice - holding.avgPrice) * holding.quantity;
      const pnlPercent =
        holding.avgPrice > 0
          ? Math.round((((currentPrice - holding.avgPrice) / holding.avgPrice) * 100) * 100) / 100
          : 0;

      return {
        symbol: holding.coinId,
        quantity: holding.quantity,
        avgPrice: holding.avgPrice,
        currentPrice,
        evalAmount,
        pnl,
        pnlPercent,
      };
    }),
  );
}

export async function getPlaceholderPortfolio(userId: string, exchange = 'upbit') {
  return getPlaceholderHoldings(userId, exchange);
}

export async function getPlaceholderPortfolioSummary(userId: string, exchange = 'upbit') {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const holdings = await getPlaceholderHoldings(userId, exchange);

  const totalEval = holdings.reduce((sum, item) => sum + item.evalAmount, 0);
  const totalAsset = user.cash + totalEval;
  const totalCost = holdings.reduce((sum, item) => sum + item.avgPrice * item.quantity, 0);
  const totalPnl = totalEval - totalCost;

  return {
    totalAsset,
    cash: user.cash,
    totalPnl,
    totalPnlPercent: totalCost > 0 ? Math.round((totalPnl / totalCost) * 10000) / 100 : 0,
  };
}

export async function getPlaceholderOrders(userId: string, exchange?: string, limit = 50) {
  const orders = await prisma.order.findMany({
    where: {
      userId,
      ...(exchange ? { exchange } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return orders.map((order) => mapOrder(order));
}

export async function getPlaceholderOpenOrders(userId: string, exchange?: string) {
  const orders = await prisma.order.findMany({
    where: {
      userId,
      ...(exchange ? { exchange } : {}),
      status: { in: ['open', 'pending', 'partial'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  return orders.map((order) => mapOrder(order));
}

export async function getPlaceholderFills(userId: string, exchange?: string, limit = 50) {
  const orders = await prisma.order.findMany({
    where: {
      userId,
      ...(exchange ? { exchange } : {}),
      status: 'filled',
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return orders.map((order) => ({
    fillId: order.id,
    orderId: order.id,
    symbol: order.coinId,
    exchange: order.exchange,
    side: order.side,
    price: order.price,
    quantity: order.quantity,
    total: order.total,
    filledAt: order.createdAt,
  }));
}
