import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../utils/errors';
import type { LoginInputType, RegisterInputType } from './auth.schema';

const EMAIL_AUTH_PROVIDER = 'email';
const EMAIL_ALREADY_EXISTS = 'EMAIL_ALREADY_EXISTS';

const INITIAL_HOLDINGS = [
  { coinId: 'BTC', quantity: 0.15, avgPrice: 138000000 },
  { coinId: 'ETH', quantity: 2.5, avgPrice: 4800000 },
  { coinId: 'XRP', quantity: 10000, avgPrice: 3100 },
  { coinId: 'SOL', quantity: 8, avgPrice: 280000 },
  { coinId: 'DOGE', quantity: 50000, avgPrice: 480 },
];

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function createEmailAlreadyExistsError() {
  return new AppError(
    409,
    '이미 가입된 이메일입니다',
    {
      field: 'email',
      resource: 'user',
    },
    EMAIL_ALREADY_EXISTS,
  );
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function toUserProfile(user: {
  id: string;
  email: string;
  nickname: string;
  authProvider: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    authProvider: user.authProvider,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function registerUser(input: RegisterInputType) {
  const normalizedEmail = normalizeEmail(input.email);
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    throw createEmailAlreadyExistsError();
  }

  const passwordHash = await bcrypt.hash(input.password, 10);

  try {
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: normalizedEmail,
          authProvider: EMAIL_AUTH_PROVIDER,
          providerAccountId: normalizedEmail,
          passwordHash,
          nickname: input.nickname.trim(),
          cash: 15000000,
        },
      });

      for (const holding of INITIAL_HOLDINGS) {
        await tx.holding.create({
          data: {
            userId: newUser.id,
            coinId: holding.coinId,
            quantity: holding.quantity,
            avgPrice: holding.avgPrice,
          },
        });
      }

      return newUser;
    });

    return toUserProfile(user);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw createEmailAlreadyExistsError();
    }
    throw error;
  }
}

export async function loginUser(input: LoginInputType) {
  const normalizedEmail = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user || user.authProvider !== EMAIL_AUTH_PROVIDER) {
    throw new AppError(401, '이메일 또는 비밀번호가 올바르지 않습니다');
  }

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, '이메일 또는 비밀번호가 올바르지 않습니다');
  }

  return toUserProfile(user);
}

export async function getCurrentUserProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      nickname: true,
      authProvider: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    throw new AppError(404, '사용자를 찾을 수 없습니다');
  }

  return toUserProfile(user);
}
