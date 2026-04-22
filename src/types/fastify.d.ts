import 'fastify';
import '@fastify/jwt';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      id: string;
      email: string;
      authProvider?: string;
      sid?: string;
      sessionId?: string;
    };
    user: {
      id: string;
      email: string;
      authProvider?: string;
      sid?: string;
      sessionId?: string;
    };
  }
}
