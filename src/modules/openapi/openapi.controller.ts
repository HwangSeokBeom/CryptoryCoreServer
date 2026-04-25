import { FastifyInstance } from 'fastify';
import { env } from '../../config/env';

const authSessionResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    data: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string', format: 'email' },
            nickname: { type: 'string' },
            authProvider: { type: 'string', enum: ['email', 'google', 'apple'] },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'email', 'nickname', 'authProvider', 'createdAt', 'updatedAt'],
        },
        token: { type: 'string', description: 'Legacy alias of accessToken.' },
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        tokenType: { type: 'string', enum: ['Bearer'] },
        expiresIn: { type: 'string', example: '7d' },
        refreshTokenExpiresAt: { type: 'string', format: 'date-time' },
        sessionId: { type: 'string' },
      },
      required: [
        'user',
        'token',
        'accessToken',
        'refreshToken',
        'tokenType',
        'expiresIn',
        'refreshTokenExpiresAt',
        'sessionId',
      ],
    },
  },
  required: ['success', 'data'],
};

const errorResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    error: { type: 'string' },
    code: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
  },
  required: ['success', 'error'],
};

function buildOpenApiDocument() {
  const googleAudience = env.GOOGLE_IOS_CLIENT_ID ?? env.GOOGLE_CLIENT_IDS[0] ?? 'GOOGLE_IOS_CLIENT_ID not configured';
  const appleAudience = env.APPLE_CLIENT_ID ?? env.APPLE_CLIENT_IDS[0] ?? 'APPLE_CLIENT_ID not configured';

  return {
    openapi: '3.0.3',
    info: {
      title: 'Cryptory Core Server API',
      version: '1.0.0',
    },
    servers: [
      { url: 'http://crytory.duckdns.org', description: 'Production' },
      { url: 'http://localhost:3000', description: 'Local development' },
    ],
    tags: [
      { name: 'Auth', description: 'Email, refresh-token, and social login APIs.' },
    ],
    paths: {
      '/api/v1/auth/social/google': {
        post: {
          tags: ['Auth'],
          summary: 'Google social login',
          description:
            `Accepts a Google iOS idToken and returns the same session response as email login. Google audience: ${googleAudience}.`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    idToken: { type: 'string', description: 'Google ID token from iOS Google Sign-In.' },
                    accessToken: { type: 'string', description: 'Optional Google access token; not used for identity verification.' },
                  },
                  required: ['idToken'],
                },
                example: {
                  idToken: 'GOOGLE_ID_TOKEN',
                  accessToken: 'GOOGLE_ACCESS_TOKEN',
                },
              },
            },
          },
          responses: {
            '200': { description: 'Cryptory session issued.', content: { 'application/json': { schema: authSessionResponseSchema } } },
            '400': { description: 'idToken missing.', content: { 'application/json': { schema: errorResponseSchema } } },
            '401': { description: 'Token malformed, expired, unsupported, or signature invalid.', content: { 'application/json': { schema: errorResponseSchema } } },
            '403': { description: 'Audience mismatch or Google email is not verified.', content: { 'application/json': { schema: errorResponseSchema } } },
            '500': { description: 'Server social-login configuration missing.', content: { 'application/json': { schema: errorResponseSchema } } },
          },
        },
      },
      '/api/v1/auth/social/apple': {
        post: {
          tags: ['Auth'],
          summary: 'Apple social login',
          description:
            `Accepts an Apple identityToken and returns the same session response as email login. Apple audience/client_id: ${appleAudience}. iOS must enable Sign in with Apple for Bundle ID com.hwb.Cryptory; otherwise the app can fail before calling this server.`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    identityToken: { type: 'string', description: 'Apple identity token from ASAuthorizationAppleIDCredential.' },
                    authorizationCode: { type: 'string', description: 'Optional Apple authorization code.' },
                    fullName: { type: 'string', description: 'Optional display name supplied on first Apple authorization.' },
                    email: { type: 'string', format: 'email', description: 'Optional first-login email from Apple credential.' },
                  },
                  required: ['identityToken'],
                },
                example: {
                  identityToken: 'APPLE_IDENTITY_TOKEN',
                  authorizationCode: 'APPLE_AUTHORIZATION_CODE',
                  fullName: '사용자 이름',
                  email: 'user@example.com',
                },
              },
            },
          },
          responses: {
            '200': { description: 'Cryptory session issued.', content: { 'application/json': { schema: authSessionResponseSchema } } },
            '400': { description: 'identityToken missing.', content: { 'application/json': { schema: errorResponseSchema } } },
            '401': { description: 'Token malformed, expired, unsupported, or signature invalid.', content: { 'application/json': { schema: errorResponseSchema } } },
            '403': { description: 'Audience mismatch.', content: { 'application/json': { schema: errorResponseSchema } } },
            '500': { description: 'Server social-login configuration missing.', content: { 'application/json': { schema: errorResponseSchema } } },
          },
        },
      },
    },
    components: {
      schemas: {
        AuthSessionResponse: authSessionResponseSchema,
        ErrorResponse: errorResponseSchema,
      },
    },
  };
}

export async function openApiRoutes(app: FastifyInstance) {
  app.get('/api/v1/openapi.json', async () => buildOpenApiDocument());
}
