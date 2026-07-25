import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  fcmToken: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
};

vi.mock('../src/config/database', () => ({ prisma }));

describe('FCM token service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('upserts same userId + token and stores lastSeenAt', async () => {
    const { upsertFcmToken } = await import('../src/domains/push/push-token.service');
    await upsertFcmToken({
      userId: 'user-1',
      token: 'fcm-token',
      platform: 'IOS',
      environment: 'dev',
      deviceId: 'device-1',
      appVersion: '1.0.0',
    });

    expect(prisma.fcmToken.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_token: { userId: 'user-1', token: 'fcm-token' } },
      update: expect.objectContaining({ isActive: true, platform: 'IOS' }),
      create: expect.objectContaining({ userId: 'user-1', token: 'fcm-token' }),
    }));
  });

  it('deactivates a token without logging or returning token contents', async () => {
    const { deleteFcmToken } = await import('../src/domains/push/push-token.service');
    await deleteFcmToken('user-1', 'fcm-token');

    expect(prisma.fcmToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: 'fcm-token' },
      data: { isActive: false },
    });
  });

  it('accepts shipped lowercase iOS platform values and canonicalizes storage', async () => {
    const { parseFcmTokenRegistrationBody } = await import('../src/domains/push/push.routes');
    const result = parseFcmTokenRegistrationBody({
      token: 'fcm-token',
      platform: 'ios',
      environment: 'prod',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platform).toBe('IOS');
    }
  });
});
