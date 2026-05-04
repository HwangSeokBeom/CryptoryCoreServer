import { FastifyRequest, FastifyReply } from 'fastify';
import { createErrorResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { validateAccessSession } from './auth.service';

function getAuthorizationHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function classifyAccessTokenFailure(error: unknown, authorization: string | undefined) {
  const hasAuthorization = Boolean(authorization?.trim());
  const tokenLength = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim().length ?? 0;
  if (!hasAuthorization) {
    return {
      code: 'ACCESS_TOKEN_REQUIRED',
      message: '인증이 필요합니다',
      hasAuthorization,
      tokenLength,
    };
  }

  const message = error instanceof Error ? error.message : '';
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const expired = code.includes('EXPIRED') || /expired/i.test(message);
  return {
    code: expired ? 'ACCESS_TOKEN_EXPIRED' : 'ACCESS_TOKEN_INVALID',
    message: expired ? 'access token이 만료되었습니다' : '인증이 필요합니다',
    hasAuthorization,
    tokenLength,
  };
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authorization = getAuthorizationHeader(request.headers.authorization);
  try {
    if (!authorization?.trim()) {
      throw new Error('missing authorization header');
    }
    await request.jwtVerify();
    const user = request.user as { id: string; sid?: string; sessionId?: string };
    const sessionId = user.sid ?? user.sessionId;
    if (sessionId && typeof validateAccessSession === 'function') {
      const active = await validateAccessSession(user.id, sessionId);
      if (!active) {
        return reply.status(401).send(createErrorResponse('세션이 만료되었거나 폐기되었습니다', undefined, 'SESSION_INVALID'));
      }
    }
  } catch (error) {
    const failure = classifyAccessTokenFailure(error, authorization);
    logger.warn(
      {
        domain: 'auth',
        action: 'session_restore_failed',
        hasAuthorization: failure.hasAuthorization,
        tokenLength: failure.tokenLength,
        authFailureCode: failure.code,
      },
      `[AuthDebug] action=session_restore_failed hasAuthorization=${failure.hasAuthorization} tokenLength=${failure.tokenLength} authFailureCode=${failure.code}`,
    );
    reply
      .status(401)
      .send(createErrorResponse(
        failure.message,
        {
          hasAuthorization: failure.hasAuthorization,
          tokenLength: failure.tokenLength,
        },
        failure.code,
      ));
  }
}
