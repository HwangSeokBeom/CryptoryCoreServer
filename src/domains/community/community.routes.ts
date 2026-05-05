import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { blockUser, listBlockedUsers, unblockUser } from '../users/user-relationship.service';
import { createCommunityReport } from './community.service';

const reportSchema = z.object({
  targetType: z.enum(['post', 'comment', 'user', 'news']),
  targetId: z.string().min(1).max(256),
  reason: z.enum(['spam', 'harassment', 'sexual', 'scam', 'privacy', 'other']),
  description: z.string().max(1000).optional(),
});

const blockSchema = z.object({
  blockedUserId: z.string().min(1).max(128),
});

async function requireAuth(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  await app.authenticate(request, reply);
  return !reply.sent;
}

export async function communityRoutes(app: FastifyInstance) {
  app.post('/reports', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const parsed = reportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_REPORT_REQUEST'));
    }

    const data = await createCommunityReport({
      reporterUserId: request.user.id,
      ...parsed.data,
    });
    logger.info(
      {
        domain: 'community-report',
        targetType: parsed.data.targetType,
        targetId: parsed.data.targetId,
        reason: parsed.data.reason,
        status: data.status,
        duplicate: data.duplicate,
      },
      `[CommunityReport] targetType=${parsed.data.targetType} targetId=${parsed.data.targetId} reason=${parsed.data.reason} status=${data.status} duplicate=${data.duplicate}`,
    );
    return createSuccessResponse(data);
  });

  app.post('/blocks', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const parsed = blockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_BLOCK_REQUEST'));
    }
    const data = await blockUser({
      blockerUserId: request.user.id,
      blockedUserId: parsed.data.blockedUserId,
    });
    return createSuccessResponse(data);
  });

  app.get('/blocks', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const items = await listBlockedUsers(request.user.id);
    return createSuccessResponse({ items });
  });

  app.delete('/blocks/:blockedUserId', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const { blockedUserId } = request.params as { blockedUserId: string };
    const data = await unblockUser({
      blockerUserId: request.user.id,
      blockedUserId,
    });
    return createSuccessResponse(data);
  });
}
