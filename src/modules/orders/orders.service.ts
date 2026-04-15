import { prisma } from '../../config/database';
import { AppError } from '../../utils/errors';
import { getCurrentPrice } from '../tickers/tickers.service';
import type { CreateOrderInputType } from './orders.schema';

export async function createOrder(userId: string, input: CreateOrderInputType) {
  if (input.quantity <= 0) {
    throw new AppError(400, '수량을 입력해주세요');
  }

  // For market orders, use current price
  let price = input.price;
  if (input.type === 'market' || !price) {
    price = await getCurrentPrice(input.symbol, input.exchange);
    if (!price || price <= 0) {
      throw new AppError(400, '현재가를 조회할 수 없습니다');
    }
  }

  const total = price * input.quantity;

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });

    if (input.side === 'buy') {
      if (total > user.cash) {
        throw new AppError(400, '잔고가 부족합니다');
      }

      // Deduct cash
      await tx.user.update({
        where: { id: userId },
        data: { cash: user.cash - total },
      });

      // Update or create holding
      const existing = await tx.holding.findUnique({
        where: { userId_coinId: { userId, coinId: input.symbol } },
      });

      let updatedHolding;
      if (existing) {
        const newQty = existing.quantity + input.quantity;
        const newAvg =
          (existing.avgPrice * existing.quantity + price * input.quantity) / newQty;
        updatedHolding = await tx.holding.update({
          where: { id: existing.id },
          data: { quantity: newQty, avgPrice: newAvg },
        });
      } else {
        updatedHolding = await tx.holding.create({
          data: {
            userId,
            coinId: input.symbol,
            quantity: input.quantity,
            avgPrice: price,
          },
        });
      }

      const order = await tx.order.create({
        data: {
          userId,
          coinId: input.symbol,
          exchange: input.exchange,
          side: input.side,
          type: input.type,
          price,
          quantity: input.quantity,
          total,
          status: 'filled',
        },
      });

      return {
        order: {
          id: order.id,
          symbol: order.coinId,
          exchange: order.exchange,
          side: order.side,
          type: order.type,
          price: order.price,
          quantity: order.quantity,
          total: order.total,
          createdAt: order.createdAt,
        },
        updatedCash: user.cash - total,
        updatedHolding: {
          symbol: updatedHolding.coinId,
          quantity: updatedHolding.quantity,
          avgPrice: updatedHolding.avgPrice,
        },
      };
    } else {
      // sell
      const holding = await tx.holding.findUnique({
        where: { userId_coinId: { userId, coinId: input.symbol } },
      });

      if (!holding || holding.quantity < input.quantity) {
        throw new AppError(400, '보유 수량이 부족합니다');
      }

      // Add cash
      await tx.user.update({
        where: { id: userId },
        data: { cash: user.cash + total },
      });

      const newQty = holding.quantity - input.quantity;
      let updatedHolding = null;

      if (newQty <= 0) {
        await tx.holding.delete({ where: { id: holding.id } });
      } else {
        const h = await tx.holding.update({
          where: { id: holding.id },
          data: { quantity: newQty },
        });
        updatedHolding = {
          symbol: h.coinId,
          quantity: h.quantity,
          avgPrice: h.avgPrice,
        };
      }

      const order = await tx.order.create({
        data: {
          userId,
          coinId: input.symbol,
          exchange: input.exchange,
          side: input.side,
          type: input.type,
          price,
          quantity: input.quantity,
          total,
          status: 'filled',
        },
      });

      return {
        order: {
          id: order.id,
          symbol: order.coinId,
          exchange: order.exchange,
          side: order.side,
          type: order.type,
          price: order.price,
          quantity: order.quantity,
          total: order.total,
          createdAt: order.createdAt,
        },
        updatedCash: user.cash + total,
        updatedHolding,
      };
    }
  });

  return result;
}

export async function getOrderHistory(userId: string, limit: number) {
  const orders = await prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      coinId: true,
      exchange: true,
      side: true,
      type: true,
      price: true,
      quantity: true,
      total: true,
      status: true,
      createdAt: true,
    },
  });

  return orders.map((o) => ({
    id: o.id,
    symbol: o.coinId,
    exchange: o.exchange,
    side: o.side,
    type: o.type,
    price: o.price,
    quantity: o.quantity,
    total: o.total,
    status: o.status,
    createdAt: o.createdAt,
  }));
}
