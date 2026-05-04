import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { deleteFcmToken, upsertFcmToken } from './push-token.service';

const upsertTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['IOS', 'ANDROID', 'WEB']),
  deviceId: z.string().optional(),
  appVersion: z.string().optional(),
  environment: z.enum(['dev', 'prod']).default('prod'),
});

const deleteTokenSchema = z.object({
  token: z.string().min(1),
});

async function requireAuth(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  await app.authenticate(request, reply);
  return !reply.sent;
}

export async function pushRoutes(app: FastifyInstance) {
  app.post('/fcm-token', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const parsed = upsertTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_FCM_TOKEN_REQUEST'));
    }
    return createSuccessResponse(await upsertFcmToken({
      userId: request.user.id,
      ...parsed.data,
    }));
  });

  app.delete('/fcm-token', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const parsed = deleteTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_FCM_TOKEN_REQUEST'));
    }
    return createSuccessResponse(await deleteFcmToken(request.user.id, parsed.data.token));
  });
}
