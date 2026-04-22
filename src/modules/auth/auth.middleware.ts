import { FastifyRequest, FastifyReply } from 'fastify';
import { createErrorResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { validateAccessSession } from './auth.service';

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
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
    const message = error instanceof Error ? error.message : '';
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
    const expired = code.includes('EXPIRED') || /expired/i.test(message);
    const reason = expired ? 'access_token_expired' : 'access_token_invalid';
    logger.warn(
      { domain: 'auth', action: 'session_restore_failed', reason, err: error },
      `[AuthDebug] action=session_restore_failed reason=${reason}`,
    );
    reply
      .status(401)
      .send(createErrorResponse(
        expired ? 'access token이 만료되었습니다' : '인증이 필요합니다',
        undefined,
        expired ? 'ACCESS_TOKEN_EXPIRED' : 'ACCESS_TOKEN_INVALID',
      ));
  }
}
