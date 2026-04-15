import { prisma } from '../../config/database';

export async function getAllCoins() {
  const coins = await prisma.coin.findMany({
    where: { isActive: true },
    select: { symbol: true, nameKo: true, nameEn: true, basePrice: true },
  });
  return coins;
}
