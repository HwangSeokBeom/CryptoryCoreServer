import bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { anonymizeCommunityDataForDeletedUser } from '../../domains/coins/coin-community.service';
import { removeUserRelationshipState } from '../../domains/users/user-relationship.service';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { AppleLoginInputType, GoogleLoginInputType, LoginInputType, RegisterInputType } from './auth.schema';
import { verifyAppleIdentityToken, verifyGoogleIdToken, type VerifiedSocialToken } from './social-token.verifier';

const EMAIL_AUTH_PROVIDER = 'email';
const GOOGLE_AUTH_PROVIDER = 'google';
const APPLE_AUTH_PROVIDER = 'apple';
const EMAIL_ALREADY_EXISTS = 'EMAIL_ALREADY_EXISTS';
const AUTH_REGISTER_FAILED = 'AUTH_REGISTER_FAILED';
const REFRESH_TOKEN_INVALID = 'REFRESH_TOKEN_INVALID';
const USER_NOT_FOUND = 'USER_NOT_FOUND';

const userProfileSelect = {
  id: true,
  email: true,
  authProvider: true,
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

function createSocialPlaceholderEmail(provider: string, providerAccountId: string) {
  const digest = createHash('sha256').update(`${provider}:${providerAccountId}`).digest('hex').slice(0, 32);
  return `${provider}_${digest}@apple.local`;
}

function isPrivateRelayEmail(email: string | undefined) {
  return Boolean(email?.toLowerCase().endsWith('@privaterelay.appleid.com'));
}

function maskUserId(userId?: string | null) {
  if (!userId) {
    return null;
  }
  return userId.length <= 4 ? '****' : `${userId.slice(0, 2)}***${userId.slice(-2)}`;
}

function parseDurationMs(input: string) {
  const match = input.trim().match(/^(\d+)(ms|s|m|h|d)?$/i);
  if (!match) {
    return 30 * 24 * 60 * 60 * 1000;
  }

  const value = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  switch (unit) {
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'm':
      return value * 60 * 1000;
    case 's':
      return value * 1000;
    default:
      return value;
  }
}

function createRefreshToken(sessionId: string) {
  return `${sessionId}.${randomBytes(32).toString('base64url')}`;
}

function hashRefreshToken(refreshToken: string) {
  return createHash('sha256').update(refreshToken).digest('hex');
}

function safeCompareHash(left: string, right: string) {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function extractSessionId(refreshToken: string) {
  const [sessionId, secret] = refreshToken.split('.');
  if (!sessionId || !secret) {
    return null;
  }
  return sessionId;
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

function getPrismaWriteFailureDetails(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return undefined;
  }

  return {
    prismaCode: error.code,
    dbColumn: typeof error.meta?.column === 'string' ? error.meta.column : undefined,
    dbTarget: Array.isArray(error.meta?.target) ? error.meta.target.join(',') : error.meta?.target,
    dbErrorCode: error.meta?.code,
  };
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
  authProvider?: string;
  nickname: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    authProvider: user.authProvider ?? EMAIL_AUTH_PROVIDER,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

async function createInitialHoldings(tx: Prisma.TransactionClient, userId: string) {
  for (const holding of INITIAL_HOLDINGS) {
    await tx.holding.create({
      data: {
        userId,
        coinId: holding.coinId,
        quantity: holding.quantity,
        avgPrice: holding.avgPrice,
      },
    });
  }
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

    await createInitialHoldings(tx, newUser.id);

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

export async function createSessionForUser(
  userId: string,
  metadata?: { userAgent?: string; ipAddress?: string },
) {
  const sessionId = randomUUID();
  const refreshToken = createRefreshToken(sessionId);
  const expiresAt = new Date(Date.now() + parseDurationMs(env.JWT_REFRESH_EXPIRES_IN));

  const session = await prisma.authSession.create({
    data: {
      id: sessionId,
      userId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      userAgent: metadata?.userAgent,
      ipAddress: metadata?.ipAddress,
      expiresAt,
    },
    select: {
      id: true,
      expiresAt: true,
    },
  });

  return {
    sessionId: session.id,
    refreshToken,
    refreshTokenExpiresAt: session.expiresAt,
  };
}

export async function refreshSession(refreshToken: string, metadata?: { userAgent?: string; ipAddress?: string }) {
  const sessionId = extractSessionId(refreshToken);
  if (!sessionId) {
    logger.warn(
      { domain: 'auth', action: 'refresh_failed', reason: 'malformed' },
      '[AuthDebug] action=refresh_failed reason=malformed',
    );
    throw new AppError(401, 'refresh token이 올바르지 않습니다', undefined, REFRESH_TOKEN_INVALID);
  }

  const session = await prisma.authSession.findUnique({
    where: { id: sessionId },
    include: {
      user: {
        select: userProfileSelect,
      },
    },
  });

  if (!session) {
    logger.warn(
      { domain: 'auth', action: 'refresh_failed', reason: 'session_not_found', sessionId },
      '[AuthDebug] action=refresh_failed reason=session_not_found',
    );
    throw new AppError(401, '세션을 찾을 수 없습니다', undefined, REFRESH_TOKEN_INVALID);
  }

  if (session.revokedAt) {
    logger.warn(
      { domain: 'auth', action: 'refresh_failed', reason: 'revoked', sessionId },
      '[AuthDebug] action=refresh_failed reason=revoked',
    );
    throw new AppError(401, '폐기된 refresh token입니다', undefined, 'REFRESH_TOKEN_REVOKED');
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    logger.warn(
      { domain: 'auth', action: 'refresh_failed', reason: 'expired', sessionId },
      '[AuthDebug] action=refresh_failed reason=expired',
    );
    throw new AppError(401, 'refresh token이 만료되었습니다', undefined, 'REFRESH_TOKEN_EXPIRED');
  }

  if (!safeCompareHash(hashRefreshToken(refreshToken), session.refreshTokenHash)) {
    logger.warn(
      { domain: 'auth', action: 'refresh_failed', reason: 'hash_mismatch', sessionId },
      '[AuthDebug] action=refresh_failed reason=hash_mismatch',
    );
    throw new AppError(401, 'refresh token이 올바르지 않습니다', undefined, REFRESH_TOKEN_INVALID);
  }

  const rotatedRefreshToken = createRefreshToken(session.id);
  const updated = await prisma.authSession.update({
    where: { id: session.id },
    data: {
      refreshTokenHash: hashRefreshToken(rotatedRefreshToken),
      userAgent: metadata?.userAgent ?? session.userAgent,
      ipAddress: metadata?.ipAddress ?? session.ipAddress,
      lastUsedAt: new Date(),
    },
    select: {
      id: true,
      expiresAt: true,
    },
  });

  logger.info(
    { domain: 'auth', action: 'refresh_success', userId: session.userId, sessionId: session.id },
    `[AuthDebug] action=refresh_success userId=${session.userId} sessionId=${session.id}`,
  );

  return {
    user: toUserProfile(session.user),
    sessionId: updated.id,
    refreshToken: rotatedRefreshToken,
    refreshTokenExpiresAt: updated.expiresAt,
  };
}

export async function validateAccessSession(userId: string, sessionId?: string) {
  if (!sessionId) {
    return true;
  }

  const session = await prisma.authSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (!session) {
    logger.warn(
      { domain: 'auth', action: 'session_restore_failed', reason: 'session_not_found', userId, sessionId },
      '[AuthDebug] action=session_restore_failed reason=session_not_found',
    );
    return false;
  }

  const active = session.userId === userId && !session.revokedAt && session.expiresAt.getTime() > Date.now();
  if (!active) {
    const reason = session.userId !== userId ? 'user_mismatch' : session.revokedAt ? 'revoked' : 'expired';
    logger.warn(
      { domain: 'auth', action: 'session_restore_failed', reason, userId, sessionId },
      `[AuthDebug] action=session_restore_failed reason=${reason}`,
    );
  }
  return active;
}

export async function getSessionSnapshot(userId: string, sessionId?: string) {
  const user = await getCurrentUserProfile(userId);
  if (!sessionId) {
    return {
      user,
      session: null,
      restore: {
        state: 'access_token_only',
        refreshAvailable: false,
      },
    };
  }

  const session = await prisma.authSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    logger.warn(
      {
        domain: 'auth',
        action: 'session_restore_failed',
        reason: !session ? 'session_not_found' : session.revokedAt ? 'revoked' : 'expired',
        userId,
        sessionId,
      },
      `[AuthDebug] action=session_restore_failed reason=${!session ? 'session_not_found' : session.revokedAt ? 'revoked' : 'expired'}`,
    );
    throw new AppError(401, '세션을 복구할 수 없습니다', undefined, 'SESSION_INVALID');
  }

  return {
    user,
    session: {
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      createdAt: session.createdAt.toISOString(),
    },
    restore: {
      state: 'authenticated',
      refreshAvailable: true,
    },
  };
}

export async function revokeSessionByRefreshToken(refreshToken: string) {
  const sessionId = extractSessionId(refreshToken);
  if (!sessionId) {
    return 0;
  }

  const result = await prisma.authSession.updateMany({
    where: {
      id: sessionId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
  return result.count;
}

export async function revokeSessionById(userId: string, sessionId: string) {
  const result = await prisma.authSession.updateMany({
    where: {
      id: sessionId,
      userId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
  return result.count;
}

export async function revokeAllUserSessions(userId: string) {
  const result = await prisma.authSession.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
  return result.count;
}

function normalizeSocialNickname(params: {
  provider: string;
  email?: string;
  tokenName?: string;
  requestedName?: string;
}) {
  const fallback = params.provider === APPLE_AUTH_PROVIDER ? 'Apple 사용자' : `${params.provider} user`;
  const raw = params.requestedName
    ?? params.tokenName
    ?? params.email?.split('@')[0]
    ?? fallback;
  const normalized = raw.trim().replace(/\s+/g, ' ');
  return (normalized || fallback).slice(0, 20);
}

async function findOrCreateSocialUser(params: {
  provider: typeof GOOGLE_AUTH_PROVIDER | typeof APPLE_AUTH_PROVIDER;
  token: VerifiedSocialToken;
  requestedName?: string;
}) {
  const providerAccountId = params.token.sub;
  const tokenEmail = params.token.email ? normalizeEmail(params.token.email) : undefined;
  const isApple = params.provider === APPLE_AUTH_PROVIDER;

  logger.info(
    {
      domain: 'auth',
      provider: params.provider,
      action: 'social_lookup_started',
      aud: params.token.aud,
      hasSub: Boolean(providerAccountId),
      hasEmail: Boolean(tokenEmail),
      isPrivateRelay: isPrivateRelayEmail(tokenEmail),
    },
    `[SocialAuthDebug] provider=${params.provider} action=social_lookup_started hasEmail=${Boolean(tokenEmail)}`,
  );

  const existingIdentity = await prisma.authIdentity.findUnique({
    where: {
      provider_providerAccountId: {
        provider: params.provider,
        providerAccountId,
      },
    },
    include: {
      user: {
        select: userProfileSelect,
      },
    },
  });

  if (existingIdentity) {
    logger.info(
      {
        domain: 'auth',
        provider: params.provider,
        action: 'social_existing_identity_found',
        userId: existingIdentity.user.id,
        hasEmail: Boolean(tokenEmail),
        isPrivateRelay: isPrivateRelayEmail(tokenEmail),
      },
      `[SocialAuthDebug] provider=${params.provider} action=social_existing_identity_found userId=${existingIdentity.user.id}`,
    );
    if (tokenEmail && tokenEmail !== existingIdentity.email) {
      await prisma.authIdentity.update({
        where: { id: existingIdentity.id },
        data: {
          email: tokenEmail,
          emailVerified: params.token.emailVerified,
        },
      });
    }
    return toUserProfile(existingIdentity.user);
  }

  const legacyProviderUser = await prisma.user.findUnique({
    where: {
      authProvider_providerAccountId: {
        authProvider: params.provider,
        providerAccountId,
      },
    },
    select: userProfileSelect,
  });

  if (legacyProviderUser) {
    logger.info(
      {
        domain: 'auth',
        provider: params.provider,
        action: 'social_legacy_user_found',
        userId: legacyProviderUser.id,
        hasEmail: Boolean(tokenEmail),
      },
      `[SocialAuthDebug] provider=${params.provider} action=social_legacy_user_found userId=${legacyProviderUser.id}`,
    );
    await prisma.authIdentity.create({
      data: {
        userId: legacyProviderUser.id,
        provider: params.provider,
        providerAccountId,
        email: tokenEmail,
        emailVerified: params.token.emailVerified,
      },
    });
    return toUserProfile(legacyProviderUser);
  }

  const requestedUserEmail = tokenEmail ?? (isApple ? createSocialPlaceholderEmail(params.provider, providerAccountId) : undefined);
  if (!requestedUserEmail) {
    throw new AppError(400, '소셜 로그인 계정 식별을 위해 이메일이 필요합니다', { provider: params.provider }, 'SOCIAL_EMAIL_REQUIRED');
  }
  const passwordHash = await bcrypt.hash(randomUUID(), 10);
  const nickname = normalizeSocialNickname({
    provider: params.provider,
    email: tokenEmail,
    tokenName: params.token.name,
    requestedName: params.requestedName,
  });

  try {
    const user = await prisma.$transaction(async (tx) => {
      let userEmail = requestedUserEmail;
      const existingUser = isApple
        ? null
        : await tx.user.findUnique({
            where: { email: requestedUserEmail },
            select: userProfileSelect,
          });

      if (existingUser) {
        logger.info(
          {
            domain: 'auth',
            provider: params.provider,
            action: 'social_existing_email_user_found',
            userId: existingUser.id,
            hasEmail: Boolean(tokenEmail),
            isPlaceholderEmail: !tokenEmail,
          },
          `[SocialAuthDebug] provider=${params.provider} action=social_existing_email_user_found userId=${existingUser.id}`,
        );
        await tx.authIdentity.create({
          data: {
            userId: existingUser.id,
            provider: params.provider,
            providerAccountId,
            email: tokenEmail,
            emailVerified: params.token.emailVerified,
          },
        });
        return existingUser;
      }

      if (isApple && tokenEmail) {
        const emailOwner = await tx.user.findUnique({
          where: { email: tokenEmail },
          select: { id: true },
        });
        if (emailOwner) {
          userEmail = createSocialPlaceholderEmail(params.provider, providerAccountId);
          logger.info(
            {
              domain: 'auth',
              provider: params.provider,
              action: 'social_email_collision_placeholder_selected',
              hasEmail: true,
              isPrivateRelay: isPrivateRelayEmail(tokenEmail),
            },
            '[SocialAuthDebug] provider=apple action=social_email_collision_placeholder_selected',
          );
        }
      }

      logger.info(
        {
          domain: 'auth',
          provider: params.provider,
          action: 'social_new_user_create_started',
          hasEmail: Boolean(tokenEmail),
          isPlaceholderEmail: !tokenEmail,
          isPrivateRelay: isPrivateRelayEmail(tokenEmail),
        },
        `[SocialAuthDebug] provider=${params.provider} action=social_new_user_create_started hasEmail=${Boolean(tokenEmail)}`,
      );
      const newUser = await tx.user.create({
        data: {
          email: userEmail,
          authProvider: params.provider,
          providerAccountId,
          passwordHash,
          nickname,
          cash: 15000000,
          authIdentities: {
            create: {
              provider: params.provider,
              providerAccountId,
              email: tokenEmail,
              emailVerified: params.token.emailVerified,
            },
          },
        },
        select: userProfileSelect,
      });

      await createInitialHoldings(tx, newUser.id);
      return newUser;
    });

    logger.info(
      {
        domain: 'auth',
        provider: params.provider,
        action: 'social_user_ready',
        userId: user.id,
        hasEmail: Boolean(tokenEmail),
        isPlaceholderEmail: user.email.endsWith('@apple.local'),
        isPrivateRelay: isPrivateRelayEmail(tokenEmail),
      },
      `[SocialAuthDebug] provider=${params.provider} action=social_user_ready userId=${user.id}`,
    );
    return toUserProfile(user);
  } catch (error) {
    logger.error(
      {
        domain: 'auth',
        provider: params.provider,
        action: 'social_new_user_create_failed',
        hasEmail: Boolean(tokenEmail),
        isPlaceholderEmail: !tokenEmail,
        isPrivateRelay: isPrivateRelayEmail(tokenEmail),
        ...getPrismaWriteFailureDetails(error),
        err: error,
      },
      `[SocialAuthDebug] provider=${params.provider} action=social_new_user_create_failed`,
    );
    if (isUniqueConstraintError(error)) {
      const identity = await prisma.authIdentity.findUnique({
        where: {
          provider_providerAccountId: {
            provider: params.provider,
            providerAccountId,
          },
        },
        include: {
          user: {
            select: userProfileSelect,
          },
        },
      });
      if (identity) {
        return toUserProfile(identity.user);
      }
    }
    throw error;
  }
}

export async function loginWithGoogle(input: GoogleLoginInputType) {
  const token = await verifyGoogleIdToken(input.idToken ?? input.credential ?? '');
  return findOrCreateSocialUser({
    provider: GOOGLE_AUTH_PROVIDER,
    token,
  });
}

export async function loginWithApple(input: AppleLoginInputType) {
  const token = await verifyAppleIdentityToken(input.identityToken ?? input.idToken ?? '');
  const fullName = input.fullName ?? [input.givenName, input.familyName].filter(Boolean).join(' ');
  return findOrCreateSocialUser({
    provider: APPLE_AUTH_PROVIDER,
    token,
    requestedName: fullName || undefined,
  });
}

export async function deleteUserAccount(userId: string) {
  const deleted = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      throw new AppError(404, 'User not found.', undefined, USER_NOT_FOUND);
    }

    const sessions = await tx.authSession.deleteMany({ where: { userId } });
    await tx.authIdentity.deleteMany({ where: { userId } });

    await tx.alertDeliveryLog.deleteMany({ where: { userId } });
    await tx.priceAlert.deleteMany({ where: { userId } });
    await tx.fcmToken.deleteMany({ where: { userId } });

    await tx.communityReport.deleteMany({
      where: {
        OR: [
          { reporterUserId: userId },
          { targetType: 'user', targetId: userId },
        ],
      },
    });
    await tx.userBlock.deleteMany({
      where: {
        OR: [
          { blockerUserId: userId },
          { blockedUserId: userId },
        ],
      },
    });
    await tx.userFollow.deleteMany({
      where: {
        OR: [
          { followerUserId: userId },
          { followingUserId: userId },
        ],
      },
    });

    await tx.orderRequest.deleteMany({ where: { userId } });
    await tx.exchangeConnectionVerification.deleteMany({ where: { userId } });
    await tx.exchangeConnection.deleteMany({ where: { userId } });
    await tx.order.deleteMany({ where: { userId } });
    await tx.holding.deleteMany({ where: { userId } });
    await tx.favorite.deleteMany({ where: { userId } });
    await tx.user.deleteMany({ where: { id: userId } });

    return {
      sessions: sessions.count,
    };
  });

  anonymizeCommunityDataForDeletedUser(userId);
  removeUserRelationshipState(userId);

  logger.info(
    { domain: 'auth', action: 'delete_account', userIdMasked: maskUserId(userId), sessionCount: deleted.sessions },
    `[AccountLifecycleDebug] action=delete_account userIdMasked=${maskUserId(userId)} sessionCount=${deleted.sessions}`,
  );

  return {
    deleted: true,
  };
}
