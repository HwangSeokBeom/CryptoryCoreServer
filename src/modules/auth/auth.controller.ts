import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodIssue } from 'zod';
import {
  AppleLoginInput,
  AuthSessionResponse,
  GoogleLoginInput,
  LoginInput,
  LogoutInput,
  RefreshTokenInput,
  RegisterInput,
} from './auth.schema';
import {
  createSessionForUser,
  deleteUserAccount,
  getCurrentUserProfile,
  getSessionSnapshot,
  loginUser,
  loginWithApple,
  loginWithGoogle,
  refreshSession,
  registerUser,
  revokeAllUserSessions,
  revokeSessionById,
  revokeSessionByRefreshToken,
} from './auth.service';
import { createSuccessResponse, createErrorResponse, AppError } from '../../utils/errors';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

const registerRoutes = ['/api/v1/auth/register', '/auth/register'] as const;
const refreshRoutes = ['/api/v1/auth/refresh', '/auth/refresh'] as const;
const logoutRoutes = ['/api/v1/auth/logout', '/auth/logout'] as const;

const validationMessages: Record<string, string> = {
  INVALID_EMAIL_FORMAT: '이메일 형식이 올바르지 않습니다.',
  INVALID_PASSWORD_LENGTH: '비밀번호는 8자 이상 72자 이하로 입력해야 합니다.',
  INVALID_REQUEST: '요청 값을 확인해주세요.',
};
const AUTH_REGISTER_FAILED = 'AUTH_REGISTER_FAILED';

function normalizeValidationCode(issue: ZodIssue) {
  return Object.prototype.hasOwnProperty.call(validationMessages, issue.message) ? issue.message : 'INVALID_REQUEST';
}

function formatValidationIssues(issues: ZodIssue[]) {
  return issues.map((issue) => {
    const code = normalizeValidationCode(issue);
    return {
      field: issue.path.join('.') || 'body',
      code,
      message: validationMessages[code],
    };
  });
}

function createValidationError(issues: ZodIssue[]) {
  const details = { issues: formatValidationIssues(issues) };
  const firstIssue = details.issues[0] ?? {
    field: 'body',
    code: 'INVALID_REQUEST',
    message: validationMessages.INVALID_REQUEST,
  };

  return {
    code: firstIssue.code,
    message: firstIssue.message,
    details,
  };
}

function getRequestMetadata(request: FastifyRequest) {
  return {
    userAgent: request.headers['user-agent'],
    ipAddress: request.ip,
  };
}

function getSessionIdFromRequest(request: FastifyRequest) {
  const user = request.user as { sid?: string; sessionId?: string } | undefined;
  return user?.sid ?? user?.sessionId;
}

function issueAuthToken(
  app: FastifyInstance,
  user: { id: string; email: string; authProvider: string },
  sessionId: string,
) {
  return app.jwt.sign(
    {
      id: user.id,
      email: user.email,
      authProvider: user.authProvider,
      sid: sessionId,
    },
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
  );
}

async function createAuthSessionResponse(
  app: FastifyInstance,
  request: FastifyRequest,
  user: { id: string; email: string; authProvider: string; nickname: string; createdAt: string; updatedAt: string },
) {
  const session = await createSessionForUser(user.id, getRequestMetadata(request));
  const accessToken = issueAuthToken(app, user, session.sessionId);
  return AuthSessionResponse.parse({
    user,
    token: accessToken,
    accessToken,
    refreshToken: session.refreshToken,
    tokenType: 'Bearer',
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString(),
    sessionId: session.sessionId,
  });
}

function createAuthSessionResponseFromRefresh(
  app: FastifyInstance,
  payload: {
    user: { id: string; email: string; authProvider: string; nickname: string; createdAt: string; updatedAt: string };
    sessionId: string;
    refreshToken: string;
    refreshTokenExpiresAt: Date;
  },
) {
  const accessToken = issueAuthToken(app, payload.user, payload.sessionId);
  return AuthSessionResponse.parse({
    user: payload.user,
    token: accessToken,
    accessToken,
    refreshToken: payload.refreshToken,
    tokenType: 'Bearer',
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    refreshTokenExpiresAt: payload.refreshTokenExpiresAt.toISOString(),
    sessionId: payload.sessionId,
  });
}

async function handleRegister(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  logger.info({ domain: 'auth', route: request.url }, 'Auth register request received');

  const parsed = RegisterInput.safeParse(request.body);
  if (!parsed.success) {
    const validationError = createValidationError(parsed.error.errors);
    logger.warn(
      {
        domain: 'auth',
        route: request.url,
        code: validationError.code,
        issues: validationError.details.issues.map((issue) => ({ field: issue.field, code: issue.code })),
      },
      'Auth register validation failed',
    );
    return reply
      .status(400)
      .send(createErrorResponse(validationError.message, validationError.details, validationError.code));
  }

  logger.info({ domain: 'auth', route: request.url }, 'Auth register dto validated');

  try {
    const user = await registerUser(parsed.data);
    logger.info({ domain: 'auth', route: request.url, userId: user.id }, 'Auth register user create succeeded');

    let data;
    try {
      data = await createAuthSessionResponse(app, request, user);
      logger.info(
        { domain: 'auth', route: request.url, userId: user.id, sessionId: data.sessionId },
        'Auth register session issue succeeded',
      );
    } catch (err) {
      logger.error({ domain: 'auth', route: request.url, userId: user.id, err }, 'Auth register session issue failed');
      return reply
        .status(500)
        .send(createErrorResponse('회원가입 처리 중 오류가 발생했습니다.', undefined, AUTH_REGISTER_FAILED));
    }

    logger.info({ domain: 'auth', route: request.url, userId: user.id }, 'Auth register success response sent');
    return reply.status(200).send(createSuccessResponse(data));
  } catch (err) {
    if (err instanceof AppError) {
      const message = err.code === 'EMAIL_ALREADY_EXISTS'
        ? 'Auth register duplicate email'
        : 'Auth register failed with handled error';
      logger.warn(
        { domain: 'auth', route: request.url, statusCode: err.statusCode, code: err.code },
        message,
      );
      return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
    }
    logger.error({ domain: 'auth', route: request.url, err }, 'Auth register failed with unhandled error');
    return reply
      .status(500)
      .send(createErrorResponse('회원가입 처리 중 오류가 발생했습니다.', undefined, AUTH_REGISTER_FAILED));
  }
}

export async function authRoutes(app: FastifyInstance) {
  for (const route of registerRoutes) {
    app.post(route, async (request, reply) => handleRegister(app, request, reply));
  }

  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = LoginInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      const user = await loginUser(parsed.data);
      const data = await createAuthSessionResponse(app, request, user);
      logger.info(
        { domain: 'auth', action: 'login_success', userId: user.id, authProvider: user.authProvider, sessionId: data.sessionId },
        `[AuthDebug] action=login_success userId=${user.id} authProvider=${user.authProvider} sessionId=${data.sessionId}`,
      );
      return createSuccessResponse(data);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  app.post('/api/v1/auth/social/google', async (request, reply) => {
    const parsed = GoogleLoginInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      const user = await loginWithGoogle(parsed.data);
      const data = await createAuthSessionResponse(app, request, user);
      logger.info(
        { domain: 'auth', action: 'login_success', userId: user.id, authProvider: user.authProvider, sessionId: data.sessionId },
        `[AuthDebug] action=login_success userId=${user.id} authProvider=${user.authProvider} sessionId=${data.sessionId}`,
      );
      return createSuccessResponse(data);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  app.post('/api/v1/auth/social/apple', async (request, reply) => {
    const parsed = AppleLoginInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      const user = await loginWithApple(parsed.data);
      const data = await createAuthSessionResponse(app, request, user);
      logger.info(
        { domain: 'auth', action: 'login_success', userId: user.id, authProvider: user.authProvider, sessionId: data.sessionId },
        `[AuthDebug] action=login_success userId=${user.id} authProvider=${user.authProvider} sessionId=${data.sessionId}`,
      );
      return createSuccessResponse(data);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  for (const route of refreshRoutes) {
    app.post(route, async (request, reply) => {
      const parsed = RefreshTokenInput.safeParse(request.body);
      if (!parsed.success) {
        logger.warn(
          { domain: 'auth', action: 'refresh_failed', reason: 'validation' },
          '[AuthDebug] action=refresh_failed reason=validation',
        );
        return reply.status(400).send(createErrorResponse('refreshToken이 필요합니다', undefined, 'REFRESH_TOKEN_REQUIRED'));
      }

      try {
        const refreshed = await refreshSession(parsed.data.refreshToken, getRequestMetadata(request));
        return createSuccessResponse(createAuthSessionResponseFromRefresh(app, refreshed));
      } catch (err) {
        if (err instanceof AppError) {
          return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
        }
        throw err;
      }
    });
  }

  for (const route of logoutRoutes) {
    app.post(route, async (request, reply) => {
      const parsed = LogoutInput.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
      }

      try {
        const authorization = request.headers.authorization;
        if (authorization) {
          await request.jwtVerify();
        }
      } catch {
        logger.warn(
          { domain: 'auth', action: 'logout', reason: 'access_token_unusable' },
          '[AccountLifecycleDebug] action=logout reason=access_token_unusable',
        );
      }

      const user = request.user as { id?: string } | undefined;
      const sessionId = getSessionIdFromRequest(request);
      const logoutAll = parsed.data?.logoutAll === true;
      if (logoutAll && !user?.id) {
        return reply.status(401).send(createErrorResponse('전체 로그아웃에는 인증이 필요합니다', undefined, 'AUTH_REQUIRED'));
      }

      const revokedCount = logoutAll
        ? await revokeAllUserSessions(user!.id!)
        : parsed.data?.refreshToken
          ? await revokeSessionByRefreshToken(parsed.data.refreshToken)
          : sessionId && user?.id
            ? await revokeSessionById(user.id, sessionId)
            : 0;

      logger.info(
        { domain: 'auth', action: 'logout', userId: user?.id, sessionCount: revokedCount },
        `[AccountLifecycleDebug] action=logout userId=${user?.id ?? 'unknown'} sessionCount=${revokedCount}`,
      );

      return createSuccessResponse({
        loggedOut: true,
        revokedSessionCount: revokedCount,
      });
    });
  }

  app.get('/api/v1/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      return createSuccessResponse(await getCurrentUserProfile(request.user.id));
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  app.get('/api/v1/auth/session', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      return createSuccessResponse(await getSessionSnapshot(request.user.id, getSessionIdFromRequest(request)));
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  app.delete('/api/v1/auth/account', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      return createSuccessResponse(await deleteUserAccount(request.user.id));
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });
}
