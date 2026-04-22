import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/auth/auth.service', () => ({
  registerUser: vi.fn(),
  loginUser: vi.fn(),
  createSessionForUser: vi.fn(),
  refreshSession: vi.fn(),
  revokeAllUserSessions: vi.fn(),
  revokeSessionById: vi.fn(),
  revokeSessionByRefreshToken: vi.fn(),
  getSessionSnapshot: vi.fn(),
  loginWithGoogle: vi.fn(),
  loginWithApple: vi.fn(),
  deleteUserAccount: vi.fn(),
  validateAccessSession: vi.fn(async () => true),
  getCurrentUserProfile: vi.fn(async () => ({
    id: 'user-1',
    email: 'user@example.com',
    nickname: 'tester',
    authProvider: 'email',
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
  })),
}));

async function createAppWithToken() {
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const token = app.jwt.sign({ id: 'user-1', email: 'user@example.com', authProvider: 'email' });
  return { app, token };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Auth me and exchange metadata contracts', () => {
  it('GET /api/v1/auth/me returns authenticated user profile', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.email).toBe('user@example.com');
    expect(body.data.authProvider).toBe('email');
    await app.close();
  });

  it('GET /exchange-metadata returns exchange guides with credential fields', async () => {
    const { app } = await createAppWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/exchange-metadata',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.some((item: any) => item.exchange === 'upbit')).toBe(true);
    expect(body.data[0].credentialFields.length).toBeGreaterThan(0);
    await app.close();
  });
});
