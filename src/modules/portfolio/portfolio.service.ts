import { prisma } from '../../config/database';
import { COIN_MAP } from '../../config/constants';
import { getCurrentPrice } from '../tickers/tickers.service';

export async function getPortfolio(userId: string, exchange = 'upbit') {
  const holdings = await prisma.holding.findMany({ where: { userId } });

  const result = await Promise.all(
    holdings.map(async (h) => {
      const coin = COIN_MAP.get(h.coinId);
      const currentPrice = await getCurrentPrice(h.coinId, exchange);
      const evalAmount = currentPrice * h.quantity;
      const pnl = (currentPrice - h.avgPrice) * h.quantity;
      const pnlPercent = h.avgPrice > 0 ? ((currentPrice - h.avgPrice) / h.avgPrice) * 100 : 0;

      return {
        symbol: h.coinId,
        nameKo: coin?.nameKo ?? h.coinId,
        quantity: h.quantity,
        avgPrice: h.avgPrice,
        currentPrice,
        evalAmount,
        pnl,
        pnlPercent: Math.round(pnlPercent * 100) / 100,
      };
    }),
  );

  return result;
}

export async function getPortfolioSummary(userId: string, exchange = 'upbit') {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const portfolio = await getPortfolio(userId, exchange);

  const totalEval = portfolio.reduce((sum, p) => sum + p.evalAmount, 0);
  const totalAsset = user.cash + totalEval;
  const totalCost = portfolio.reduce((sum, p) => sum + p.avgPrice * p.quantity, 0);
  const totalPnl = totalEval - totalCost;
  const totalPnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

  return {
    totalAsset,
    cash: user.cash,
    totalPnl,
    totalPnlPercent: Math.round(totalPnlPercent * 100) / 100,
  };
}
