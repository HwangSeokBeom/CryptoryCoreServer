import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { LoginInputType, RegisterInputType } from './auth.schema';

const EMAIL_AUTH_PROVIDER = 'email';
const EMAIL_ALREADY_EXISTS = 'EMAIL_ALREADY_EXISTS';
const AUTH_REGISTER_FAILED = 'AUTH_REGISTER_FAILED';

const userProfileSelect = {
  id: true,
  email: true,
  nickname: true,
  createdAt: true,
  updatedAt: true,
} as const;

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
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  if (error.code === 'P2002') {
    return true;
  }
  return error.code === 'P2010' && error.meta?.code === '23505';
}

function isMissingLegacyAuthColumnError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2022') {
    return false;
  }

  return error.meta?.column === 'authProvider' || error.meta?.column === 'providerAccountId';
}

function toUserProfile(user: {
  id: string;
  email: string;
  nickname: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    authProvider: EMAIL_AUTH_PROVIDER,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

async function createUserWithLegacySchemaFallback(
  tx: Prisma.TransactionClient,
  params: { email: string; passwordHash: string; nickname: string },
) {
  const [newUser] = await tx.$queryRaw<Array<{
    id: string;
    email: string;
    nickname: string;
    createdAt: Date;
    updatedAt: Date;
  }>>`
    INSERT INTO "User" ("id", "email", "passwordHash", "nickname", "cash", "updatedAt")
    VALUES (${randomUUID()}, ${params.email}, ${params.passwordHash}, ${params.nickname}, ${15000000}, NOW())
    RETURNING "id", "email", "nickname", "createdAt", "updatedAt"
  `;

  if (!newUser) {
    throw new AppError(500, '회원가입 처리 중 오류가 발생했습니다', undefined, AUTH_REGISTER_FAILED);
  }

  return newUser;
}

async function shouldUseLegacyAuthWritePath() {
  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT "column_name"
    FROM "information_schema"."columns"
    WHERE "table_name" = 'User'
      AND "column_name" IN ('authProvider', 'providerAccountId')
  `;

  const availableColumns = new Set(columns.map((column) => column.column_name));
  return !(availableColumns.has('authProvider') && availableColumns.has('providerAccountId'));
}

export async function registerUser(input: RegisterInputType) {
  const normalizedEmail = normalizeEmail(input.email);
  logger.info({ domain: 'auth', email: normalizedEmail }, 'Auth register service started');

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (existing) {
    logger.info({ domain: 'auth', email: normalizedEmail }, 'Auth register duplicate email');
    throw createEmailAlreadyExistsError();
  }

  let passwordHash: string;
  try {
    passwordHash = await bcrypt.hash(input.password, 10);
    logger.info({ domain: 'auth', email: normalizedEmail }, 'Auth register password hashed');
  } catch (error) {
    logger.error({ domain: 'auth', email: normalizedEmail, err: error }, 'Auth register password hashing failed');
    throw error;
  }

  const nickname = input.nickname.trim();
  const createUserWithHoldings = async (mode: 'current' | 'legacy') => prisma.$transaction(async (tx) => {
    const newUser =
      mode === 'legacy'
        ? await createUserWithLegacySchemaFallback(tx, {
            email: normalizedEmail,
            passwordHash,
            nickname,
          })
        : await tx.user.create({
            data: {
              email: normalizedEmail,
              authProvider: EMAIL_AUTH_PROVIDER,
              providerAccountId: normalizedEmail,
              passwordHash,
              nickname,
              cash: 15000000,
            },
            select: userProfileSelect,
          });

    logger.info({ domain: 'auth', userId: newUser.id, email: normalizedEmail }, 'Auth register user created');

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

  try {
    const user = await createUserWithHoldings((await shouldUseLegacyAuthWritePath()) ? 'legacy' : 'current');

    logger.info({ domain: 'auth', userId: user.id, email: normalizedEmail }, 'Auth register service completed');
    return toUserProfile(user);
  } catch (error) {
    if (isMissingLegacyAuthColumnError(error)) {
      logger.warn(
        { domain: 'auth', email: normalizedEmail, err: error },
        'Auth register detected legacy user schema, retrying with compatibility insert',
      );

      try {
        const user = await createUserWithHoldings('legacy');
        logger.info({ domain: 'auth', userId: user.id, email: normalizedEmail }, 'Auth register service completed');
        return toUserProfile(user);
      } catch (retryError) {
        if (isUniqueConstraintError(retryError)) {
          logger.info({ domain: 'auth', email: normalizedEmail }, 'Auth register duplicate email');
          throw createEmailAlreadyExistsError();
        }
        logger.error(
          { domain: 'auth', email: normalizedEmail, err: retryError },
          'Auth register failed with unhandled error',
        );
        throw retryError;
      }
    }
    if (isUniqueConstraintError(error)) {
      logger.info({ domain: 'auth', email: normalizedEmail }, 'Auth register duplicate email');
      throw createEmailAlreadyExistsError();
    }
    logger.error({ domain: 'auth', email: normalizedEmail, err: error }, 'Auth register failed with unhandled error');
    throw error;
  }
}

export async function loginUser(input: LoginInputType) {
  const normalizedEmail = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      ...userProfileSelect,
      passwordHash: true,
    },
  });
  if (!user) {
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
    select: userProfileSelect,
  });

  if (!user) {
    throw new AppError(404, '사용자를 찾을 수 없습니다');
  }

  return toUserProfile(user);
}
