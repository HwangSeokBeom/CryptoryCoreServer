import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { translateBatch, translateText } from './translation.service';

const translateSchema = z.object({
  text: z.string(),
  sourceLanguage: z.string().min(2).max(16).default('en'),
  targetLanguage: z.string().min(2).max(16).default('ko'),
  context: z.enum(['coin_description', 'news_title', 'news_summary', 'general']).default('general'),
  symbol: z.string().optional(),
});

const batchTranslateSchema = z.object({
  targetLanguage: z.enum(['ko']),
  items: z.array(z.object({
    id: z.string().min(1).max(128),
    text: z.string().max(4000),
    sourceLanguage: z.string().min(2).max(16).default('en'),
  })).min(1).max(20),
});

export async function translationRoutes(app: FastifyInstance) {
  app.post('/', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null | undefined;
    if (Array.isArray(body?.items)) {
      const parsedBatch = batchTranslateSchema.safeParse(body);
      if (!parsedBatch.success) {
        return reply.status(400).send(createErrorResponse(parsedBatch.error.errors[0].message, undefined, 'INVALID_TRANSLATION_BATCH_REQUEST'));
      }

      const data = await translateBatch(parsedBatch.data);
      return createSuccessResponse(data);
    }

    const parsed = translateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_TRANSLATION_REQUEST'));
    }

    const data = await translateText(parsed.data);
    return createSuccessResponse(data);
  });
}
