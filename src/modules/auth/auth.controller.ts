import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodIssue } from 'zod';
import { AuthSessionResponse, RegisterInput, LoginInput } from './auth.schema';
import { getCurrentUserProfile, loginUser, registerUser } from './auth.service';
import { createSuccessResponse, createErrorResponse, AppError } from '../../utils/errors';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

const registerRoutes = ['/api/v1/auth/register', '/auth/register'] as const;

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

function issueAuthToken(app: FastifyInstance, user: { id: string; email: string; authProvider: string }) {
  return app.jwt.sign(
    {
      id: user.id,
      email: user.email,
      authProvider: user.authProvider,
    },
    { expiresIn: env.JWT_EXPIRES_IN },
  );
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

    let token: string;
    try {
      token = issueAuthToken(app, user);
      logger.info({ domain: 'auth', route: request.url, userId: user.id }, 'Auth register token issue succeeded');
    } catch (err) {
      logger.error({ domain: 'auth', route: request.url, userId: user.id, err }, 'Auth register token issue failed');
      return reply
        .status(500)
        .send(createErrorResponse('회원가입 처리 중 오류가 발생했습니다.', undefined, AUTH_REGISTER_FAILED));
    }

    let data;
    try {
      data = AuthSessionResponse.parse({ user, token });
      logger.info({ domain: 'auth', route: request.url, userId: user.id }, 'Auth register response serialized');
    } catch (err) {
      logger.error(
        { domain: 'auth', route: request.url, userId: user.id, err },
        'Auth register response serialization failed',
      );
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
      const token = issueAuthToken(app, user);
      return createSuccessResponse({ user, token });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

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
}
