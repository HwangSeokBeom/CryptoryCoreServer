import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { hashFcmToken } from './fcm.service';

export type UpsertFcmTokenInput = {
  userId: string;
  token: string;
  platform: 'IOS' | 'ANDROID' | 'WEB';
  deviceId?: string | null;
  appVersion?: string | null;
  environment: 'dev' | 'prod';
};

export async function upsertFcmToken(input: UpsertFcmTokenInput) {
  const tokenHash = hashFcmToken(input.token);
  await prisma.fcmToken.upsert({
    where: {
      userId_token: {
        userId: input.userId,
        token: input.token,
      },
    },
    update: {
      platform: input.platform,
      deviceId: input.deviceId ?? null,
      appVersion: input.appVersion ?? null,
      environment: input.environment,
      isActive: true,
      lastSeenAt: new Date(),
    },
    create: {
      userId: input.userId,
      token: input.token,
      platform: input.platform,
      deviceId: input.deviceId ?? null,
      appVersion: input.appVersion ?? null,
      environment: input.environment,
      isActive: true,
      lastSeenAt: new Date(),
    },
  });
  logger.info(
    { domain: 'push-token', userId: input.userId, tokenHash, platform: input.platform },
    `[PushToken] upsert userId=${input.userId} tokenHash=${tokenHash} platform=${input.platform}`,
  );
  return { registered: true };
}

export async function deleteFcmToken(userId: string, token: string) {
  const tokenHash = hashFcmToken(token);
  await prisma.fcmToken.updateMany({
    where: { userId, token },
    data: { isActive: false },
  });
  logger.info(
    { domain: 'push-token', userId, tokenHash },
    `[PushToken] deactivate userId=${userId} tokenHash=${tokenHash}`,
  );
  return { deleted: true };
}
