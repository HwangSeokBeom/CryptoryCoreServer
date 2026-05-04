import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  getRelationship,
  getRelationshipBatch,
  getUserFollowState,
  listFollowers,
  listFollowing,
  setFollowState,
} from './user-relationship.service';

function maskUserId(userId?: string | null) {
  if (!userId) {
    return null;
  }
  return userId.length <= 4 ? '****' : `${userId.slice(0, 2)}***${userId.slice(-2)}`;
}

async function requireAuth(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  await app.authenticate(request, reply);
  return !reply.sent;
}

function logUserFollow(params: {
  userId?: string | null;
  targetUserId: string;
  action: 'follow' | 'unfollow' | 'state';
  status: number;
}) {
  logger.info(
    {
      domain: 'user-follow',
      userIdMasked: maskUserId(params.userId),
      targetUserIdMasked: maskUserId(params.targetUserId),
      action: params.action,
      status: params.status,
    },
    `[UserFollow] userIdMasked=${maskUserId(params.userId)} targetUserIdMasked=${maskUserId(params.targetUserId)} action=${params.action} status=${params.status}`,
  );
}

export async function userRoutes(app: FastifyInstance) {
  app.post('/:userId/follow', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const { userId: targetUserId } = request.params as { userId: string };
    if (targetUserId === request.user.id) {
      return reply.status(400).send(createErrorResponse('자기 자신은 팔로우할 수 없습니다', undefined, 'CANNOT_FOLLOW_SELF'));
    }
    const data = await setFollowState({ followerUserId: request.user.id, followingUserId: targetUserId, follow: true });
    logUserFollow({ userId: request.user.id, targetUserId, action: 'follow', status: reply.statusCode });
    return createSuccessResponse(data);
  });

  app.delete('/:userId/follow', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const { userId: targetUserId } = request.params as { userId: string };
    const data = await setFollowState({ followerUserId: request.user.id, followingUserId: targetUserId, follow: false });
    logUserFollow({ userId: request.user.id, targetUserId, action: 'unfollow', status: reply.statusCode });
    return createSuccessResponse(data);
  });

  app.get('/:userId/follow-state', async (request, reply) => {
    const { userId: targetUserId } = request.params as { userId: string };
    const data = await getUserFollowState({ userId: request.user?.id ?? null, targetUserId });
    logUserFollow({ userId: request.user?.id ?? null, targetUserId, action: 'state', status: reply.statusCode });
    return createSuccessResponse(data);
  });

  app.get('/:userId/relationship', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const { userId: targetUserId } = request.params as { userId: string };
    const data = await getRelationship({ viewerId: request.user.id, targetUserId });
    return createSuccessResponse(data);
  });

  app.get('/me/following', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const items = await listFollowing(request.user.id);
    return createSuccessResponse({ items });
  });

  app.get('/:userId/followers', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const { userId } = request.params as { userId: string };
    const items = await listFollowers({ viewerId: request.user.id, userId });
    return createSuccessResponse({ items });
  });

  app.post('/relationships/batch', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const parsed = z.object({
      userIds: z.array(z.string().min(1).max(128)).min(1).max(100),
    }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_RELATIONSHIP_BATCH_REQUEST'));
    }

    const relationships = await getRelationshipBatch({
      viewerId: request.user.id,
      userIds: parsed.data.userIds,
    });
    return createSuccessResponse({
      items: parsed.data.userIds.map((userId) => relationships.get(userId) ?? {
        userId,
        following: false,
        followedBy: false,
        blocked: false,
        blockedBy: false,
        me: request.user.id === userId,
      }),
    });
  });
}
