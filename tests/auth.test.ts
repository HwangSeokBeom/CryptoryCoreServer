import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildApp } from '../src/app';
import {
  createSessionForUser,
  loginWithApple,
  loginWithGoogle,
  refreshSession,
  registerUser,
  revokeSessionByRefreshToken,
} from '../src/modules/auth/auth.service';
import { AppError } from '../src/utils/errors';

vi.mock('../src/modules/auth/auth.service', () => ({
  registerUser: vi.fn(),
  loginUser: vi.fn(),
  getCurrentUserProfile: vi.fn(),
  createSessionForUser: vi.fn(),
  refreshSession: vi.fn(),
  revokeAllUserSessions: vi.fn(),
  revokeSessionById: vi.fn(),
  revokeSessionByRefreshToken: vi.fn(),
  getSessionSnapshot: vi.fn(),
  loginWithGoogle: vi.fn(),
  loginWithApple: vi.fn(),
  deleteUserAccount: vi.fn(),
  validateAccessSession: vi.fn(),
}));

const registerUserMock = vi.mocked(registerUser);
const createSessionForUserMock = vi.mocked(createSessionForUser);
const refreshSessionMock = vi.mocked(refreshSession);
const loginWithGoogleMock = vi.mocked(loginWithGoogle);
const loginWithAppleMock = vi.mocked(loginWithApple);
const revokeSessionByRefreshTokenMock = vi.mocked(revokeSessionByRefreshToken);

const authUser = {
  id: 'user-1',
  email: 'new@example.com',
  nickname: 'tester',
  authProvider: 'email',
  createdAt: '2026-04-21T00:00:00.000Z',
  updatedAt: '2026-04-21T00:00:00.000Z',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('Auth API', () => {
  it('registers POST /auth/register and the legacy /api/v1/auth/register route', async () => {
    const app = await buildApp();
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/auth/register');
    expect(routes).toContain('/api/v1/auth/register');
    expect(routes).toContain('/api/v1/auth/refresh');
    expect(routes).toContain('/api/v1/auth/social/google');
    expect(routes).toContain('/api/v1/auth/social/apple');
    expect(routes).toContain('/api/v1/auth/logout');
    expect(routes).toContain('/api/v1/auth/session');
    expect(routes).toContain('/api/v1/auth/account');
    expect(routes).toContain('/api/v1/app/config');
    expect(routes).toContain('/api/v1/openapi.json');
    expect(app.hasRoute({ method: 'POST', url: '/auth/register' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/auth/register' })).toBe(true);
    await app.close();
  });

  it('POST /api/v1/auth/register - creates a session for valid input', async () => {
    registerUserMock.mockResolvedValueOnce(authUser);
    createSessionForUserMock.mockResolvedValueOnce({
      sessionId: 'session-1',
      refreshToken: 'session-1.refresh-token-secret',
      refreshTokenExpiresAt: new Date('2026-05-21T00:00:00.000Z'),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'New@Example.com', password: 'password123', nickname: 'tester' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user).toEqual(authUser);
    expect(typeof body.data.token).toBe('string');
    expect(body.data.token.length).toBeGreaterThan(0);
    expect(body.data.accessToken).toBe(body.data.token);
    expect(body.data.refreshToken).toBe('session-1.refresh-token-secret');
    expect(body.data.sessionId).toBe('session-1');
    await app.close();
  });

  it('POST /api/v1/auth/register - returns AUTH_REGISTER_FAILED only for unexpected errors', async () => {
    registerUserMock.mockRejectedValueOnce(new Error('unexpected register failure'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'new@example.com', password: 'password123', nickname: 'tester' },
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('AUTH_REGISTER_FAILED');
    await app.close();
  });

  it('POST /auth/register - returns 409 for duplicate email', async () => {
    registerUserMock.mockRejectedValueOnce(
      new AppError(409, '이미 가입된 이메일입니다', { field: 'email', resource: 'user' }, 'EMAIL_ALREADY_EXISTS'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'new@example.com', password: 'password123', nickname: 'tester' },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('EMAIL_ALREADY_EXISTS');
    expect(body.details.field).toBe('email');
    await app.close();
  });

  it('POST /api/v1/auth/register - validates input', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'invalid', password: '12', nickname: '' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('INVALID_EMAIL_FORMAT');
    expect(registerUserMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /auth/register - returns 400 for short password', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'new@example.com', password: 'short', nickname: 'tester' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('INVALID_PASSWORD_LENGTH');
    expect(registerUserMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /auth/register - returns 400 for missing required fields', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'new@example.com' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.details.issues.some((issue: any) => issue.field === 'password')).toBe(true);
    expect(registerUserMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/auth/login - validates input', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'bad', password: '' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    await app.close();
  });

  it('POST /api/v1/auth/refresh - rotates refresh token and returns a new access token', async () => {
    refreshSessionMock.mockResolvedValueOnce({
      user: authUser,
      sessionId: 'session-1',
      refreshToken: 'session-1.rotated-refresh-token-secret',
      refreshTokenExpiresAt: new Date('2026-05-21T00:00:00.000Z'),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: 'session-1.original-refresh-token-secret' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user).toEqual(authUser);
    expect(body.data.accessToken).toBe(body.data.token);
    expect(body.data.refreshToken).toBe('session-1.rotated-refresh-token-secret');
    expect(refreshSessionMock).toHaveBeenCalledWith(
      'session-1.original-refresh-token-secret',
      expect.objectContaining({ ipAddress: expect.any(String) }),
    );
    await app.close();
  });

  it('POST /api/v1/auth/social/google - exchanges a verified provider user for a Cryptory session', async () => {
    loginWithGoogleMock.mockResolvedValueOnce({ ...authUser, authProvider: 'google' });
    createSessionForUserMock.mockResolvedValueOnce({
      sessionId: 'session-google',
      refreshToken: 'session-google.refresh-token-secret',
      refreshTokenExpiresAt: new Date('2026-05-21T00:00:00.000Z'),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/social/google',
      payload: { idToken: 'header.payload.signature.long-enough' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user.authProvider).toBe('google');
    expect(body.data.refreshToken).toBe('session-google.refresh-token-secret');
    await app.close();
  });

  it('POST /api/v1/auth/social/google - returns 400 when idToken is missing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/social/google',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('GOOGLE_ID_TOKEN_REQUIRED');
    expect(loginWithGoogleMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/auth/social/google - returns 401 for invalid provider token', async () => {
    loginWithGoogleMock.mockRejectedValueOnce(
      new AppError(401, '소셜 로그인 토큰 서명이 올바르지 않습니다', undefined, 'SOCIAL_TOKEN_INVALID_SIGNATURE'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/social/google',
      payload: { idToken: 'header.payload.signature.long-enough' },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('SOCIAL_TOKEN_INVALID_SIGNATURE');
    await app.close();
  });

  it('POST /api/v1/auth/social/google - returns 403 for audience mismatch', async () => {
    loginWithGoogleMock.mockRejectedValueOnce(
      new AppError(403, '소셜 로그인 토큰 대상 앱이 올바르지 않습니다', undefined, 'SOCIAL_TOKEN_INVALID_AUDIENCE'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/social/google',
      payload: { idToken: 'header.payload.signature.long-enough' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('SOCIAL_TOKEN_INVALID_AUDIENCE');
    await app.close();
  });

  it('POST /api/v1/auth/social/apple - exchanges a verified provider user for a Cryptory session', async () => {
    loginWithAppleMock.mockResolvedValueOnce({ ...authUser, authProvider: 'apple' });
    createSessionForUserMock.mockResolvedValueOnce({
      sessionId: 'session-apple',
      refreshToken: 'session-apple.refresh-token-secret',
      refreshTokenExpiresAt: new Date('2026-05-21T00:00:00.000Z'),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/social/apple',
      payload: {
        identityToken: 'header.payload.signature.long-enough',
        authorizationCode: 'auth-code',
        fullName: 'Apple User',
        email: 'apple@example.com',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user.authProvider).toBe('apple');
    expect(body.data.accessToken).toBe(body.data.token);
    expect(body.data.refreshToken).toBe('session-apple.refresh-token-secret');
    await app.close();
  });

  it('POST /api/v1/auth/social/apple - accepts absent optional Apple profile fields', async () => {
    loginWithAppleMock.mockResolvedValueOnce({
      ...authUser,
      email: 'apple_placeholder@example.com',
      nickname: 'Apple 사용자',
      authProvider: 'apple',
    });
    createSessionForUserMock.mockResolvedValueOnce({
      sessionId: 'session-apple-empty-profile',
      refreshToken: 'session-apple-empty-profile.refresh-token-secret',
      refreshTokenExpiresAt: new Date('2026-05-21T00:00:00.000Z'),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/social/apple',
      payload: {
        identityToken: 'header.payload.signature.long-enough',
        authorizationCode: '',
        fullName: null,
        email: '',
        givenName: '',
        familyName: null,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(loginWithAppleMock).toHaveBeenCalledWith(expect.objectContaining({
      identityToken: 'header.payload.signature.long-enough',
      authorizationCode: undefined,
      fullName: undefined,
      email: undefined,
      givenName: undefined,
      familyName: undefined,
    }));
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user.authProvider).toBe('apple');
    await app.close();
  });

  it('POST /api/v1/auth/social/apple - returns 400 when identityToken is missing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/social/apple',
      payload: { authorizationCode: 'auth-code' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('APPLE_IDENTITY_TOKEN_REQUIRED');
    expect(loginWithAppleMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/auth/social/apple - returns 401 for invalid provider token', async () => {
    loginWithAppleMock.mockRejectedValueOnce(
      new AppError(401, '소셜 로그인 토큰 서명이 올바르지 않습니다', undefined, 'SOCIAL_TOKEN_INVALID_SIGNATURE'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/social/apple',
      payload: { identityToken: 'header.payload.signature.long-enough' },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('SOCIAL_TOKEN_INVALID_SIGNATURE');
    await app.close();
  });

  it('POST /api/v1/auth/social/apple - returns 403 for audience mismatch', async () => {
    loginWithAppleMock.mockRejectedValueOnce(
      new AppError(403, '소셜 로그인 토큰 대상 앱이 올바르지 않습니다', undefined, 'SOCIAL_TOKEN_INVALID_AUDIENCE'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/social/apple',
      payload: { identityToken: 'header.payload.signature.long-enough' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('SOCIAL_TOKEN_INVALID_AUDIENCE');
    await app.close();
  });

  it('GET /api/v1/openapi.json - documents social login contracts', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/openapi.json',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.openapi).toBe('3.0.3');
    expect(body.paths['/api/v1/auth/social/google'].post.requestBody.content['application/json'].schema.required).toContain('idToken');
    expect(body.paths['/api/v1/auth/social/apple'].post.requestBody.content['application/json'].schema.required).toContain('identityToken');
    await app.close();
  });

  it('POST /api/v1/auth/logout - revokes a refresh token without requiring a valid access token', async () => {
    revokeSessionByRefreshTokenMock.mockResolvedValueOnce(1);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: 'session-1.refresh-token-secret' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.revokedSessionCount).toBe(1);
    expect(revokeSessionByRefreshTokenMock).toHaveBeenCalledWith('session-1.refresh-token-secret');
    await app.close();
  });
});
