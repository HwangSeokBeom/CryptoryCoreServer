import { FastifyInstance } from 'fastify';
import { RegisterInput, LoginInput } from './auth.schema';
import { registerUser, loginUser } from './auth.service';
import { createSuccessResponse, createErrorResponse, AppError } from '../../utils/errors';

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/register', async (request, reply) => {
    const parsed = RegisterInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      const user = await registerUser(parsed.data);
      const token = app.jwt.sign({ id: user.id, email: user.email }, { expiresIn: '7d' });
      return createSuccessResponse({ user, token });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message));
      }
      throw err;
    }
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = LoginInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      const user = await loginUser(parsed.data);
      const token = app.jwt.sign({ id: user.id, email: user.email }, { expiresIn: '7d' });
      return createSuccessResponse({ user, token });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message));
      }
      throw err;
    }
  });
}
