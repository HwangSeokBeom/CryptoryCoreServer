import bcrypt from 'bcrypt';
import { prisma } from '../../config/database';
import { AppError } from '../../utils/errors';
import type { RegisterInputType, LoginInputType } from './auth.schema';

const INITIAL_HOLDINGS = [
  { coinId: 'BTC', quantity: 0.15, avgPrice: 138000000 },
  { coinId: 'ETH', quantity: 2.5, avgPrice: 4800000 },
  { coinId: 'XRP', quantity: 10000, avgPrice: 3100 },
  { coinId: 'SOL', quantity: 8, avgPrice: 280000 },
  { coinId: 'DOGE', quantity: 50000, avgPrice: 480 },
];

export async function registerUser(input: RegisterInputType) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw new AppError(409, '이미 가입된 이메일입니다');

  const passwordHash = await bcrypt.hash(input.password, 10);

  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        nickname: input.nickname,
        cash: 15000000,
      },
    });

    for (const h of INITIAL_HOLDINGS) {
      await tx.holding.create({
        data: {
          userId: newUser.id,
          coinId: h.coinId,
          quantity: h.quantity,
          avgPrice: h.avgPrice,
        },
      });
    }

    return newUser;
  });

  return { id: user.id, email: user.email, nickname: user.nickname, cash: user.cash };
}

export async function loginUser(input: LoginInputType) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) throw new AppError(401, '이메일 또는 비밀번호가 올바르지 않습니다');

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) throw new AppError(401, '이메일 또는 비밀번호가 올바르지 않습니다');

  return { id: user.id, email: user.email, nickname: user.nickname, cash: user.cash };
}
