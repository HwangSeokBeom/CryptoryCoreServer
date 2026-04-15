import { prisma } from '../../config/database';
import { AppError } from '../../utils/errors';

export async function addFavorite(userId: string, coinId: string) {
  const existing = await prisma.favorite.findUnique({
    where: { userId_coinId: { userId, coinId } },
  });
  if (existing) throw new AppError(409, '이미 관심종목에 추가되었습니다');

  await prisma.favorite.create({ data: { userId, coinId } });
}

export async function removeFavorite(userId: string, coinId: string) {
  const existing = await prisma.favorite.findUnique({
    where: { userId_coinId: { userId, coinId } },
  });
  if (!existing) throw new AppError(404, '관심종목에 없는 코인입니다');

  await prisma.favorite.delete({ where: { id: existing.id } });
}

export async function getFavorites(userId: string) {
  const favorites = await prisma.favorite.findMany({
    where: { userId },
    select: { coinId: true },
  });
  return favorites.map((f) => ({ symbol: f.coinId }));
}
