import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildApp } from '../src/app';
import { registerUser } from '../src/modules/auth/auth.service';
import { AppError } from '../src/utils/errors';

vi.mock('../src/modules/auth/auth.service', () => ({
  registerUser: vi.fn(),
  loginUser: vi.fn(),
  getCurrentUserProfile: vi.fn(),
}));

const registerUserMock = vi.mocked(registerUser);

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
    expect(app.hasRoute({ method: 'POST', url: '/auth/register' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/auth/register' })).toBe(true);
    await app.close();
  });

  it('POST /api/v1/auth/register - creates a session for valid input', async () => {
    registerUserMock.mockResolvedValueOnce(authUser);
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
});
