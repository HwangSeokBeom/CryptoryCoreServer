import { FastifyInstance } from 'fastify';
import { CreateOrderInput } from './orders.schema';
import { createOrder, getOrderHistory } from './orders.service';
import { authenticate } from '../auth/auth.middleware';
import { createSuccessResponse, createErrorResponse, AppError } from '../../utils/errors';

export async function ordersRoutes(app: FastifyInstance) {
  app.post('/api/v1/orders', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = CreateOrderInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    const { id: userId } = request.user as { id: string };

    try {
      const result = await createOrder(userId, parsed.data);
      return createSuccessResponse(result);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  app.get('/api/v1/orders/history', { preHandler: [authenticate] }, async (request) => {
    const { id: userId } = request.user as { id: string };
    const { limit } = request.query as { limit?: string };
    const orders = await getOrderHistory(userId, limit ? parseInt(limit, 10) : 50);
    return createSuccessResponse(orders);
  });
}
