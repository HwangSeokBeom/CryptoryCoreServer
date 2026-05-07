import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { prismaMock, bcryptMock, txMock, anonymizeCommunityDataForDeletedUserMock, removeUserRelationshipStateMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  bcryptMock: {
    hash: vi.fn(),
    compare: vi.fn(),
  },
  txMock: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
    holding: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    authSession: {
      deleteMany: vi.fn(),
    },
    authIdentity: {
      deleteMany: vi.fn(),
    },
    alertDeliveryLog: {
      deleteMany: vi.fn(),
    },
    priceAlert: {
      deleteMany: vi.fn(),
    },
    fcmToken: {
      deleteMany: vi.fn(),
    },
    communityReport: {
      deleteMany: vi.fn(),
    },
    userBlock: {
      deleteMany: vi.fn(),
    },
    userFollow: {
      deleteMany: vi.fn(),
    },
    orderRequest: {
      deleteMany: vi.fn(),
    },
    exchangeConnectionVerification: {
      deleteMany: vi.fn(),
    },
    exchangeConnection: {
      deleteMany: vi.fn(),
    },
    order: {
      deleteMany: vi.fn(),
    },
    favorite: {
      deleteMany: vi.fn(),
    },
  },
  anonymizeCommunityDataForDeletedUserMock: vi.fn(),
  removeUserRelationshipStateMock: vi.fn(),
}));

vi.mock('../src/config/database', () => ({
  prisma: prismaMock,
}));

vi.mock('bcrypt', () => ({
  default: bcryptMock,
}));

vi.mock('../src/domains/coins/coin-community.service', () => ({
  anonymizeCommunityDataForDeletedUser: anonymizeCommunityDataForDeletedUserMock,
}));

vi.mock('../src/domains/users/user-relationship.service', () => ({
  removeUserRelationshipState: removeUserRelationshipStateMock,
}));

import { deleteUserAccount, registerUser } from '../src/modules/auth/auth.service';

describe('registerUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.$queryRaw.mockResolvedValue([
      { column_name: 'authProvider' },
      { column_name: 'providerAccountId' },
    ]);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    bcryptMock.hash.mockResolvedValue('hashed-password');
    txMock.holding.create.mockResolvedValue(undefined);
    txMock.user.findUnique.mockResolvedValue({ id: 'user-1' });
    txMock.user.deleteMany.mockResolvedValue({ count: 1 });
    txMock.authSession.deleteMany.mockResolvedValue({ count: 1 });
    txMock.authIdentity.deleteMany.mockResolvedValue({ count: 1 });
    txMock.alertDeliveryLog.deleteMany.mockResolvedValue({ count: 1 });
    txMock.priceAlert.deleteMany.mockResolvedValue({ count: 1 });
    txMock.fcmToken.deleteMany.mockResolvedValue({ count: 1 });
    txMock.communityReport.deleteMany.mockResolvedValue({ count: 1 });
    txMock.userBlock.deleteMany.mockResolvedValue({ count: 1 });
    txMock.userFollow.deleteMany.mockResolvedValue({ count: 1 });
    txMock.orderRequest.deleteMany.mockResolvedValue({ count: 1 });
    txMock.exchangeConnectionVerification.deleteMany.mockResolvedValue({ count: 1 });
    txMock.exchangeConnection.deleteMany.mockResolvedValue({ count: 1 });
    txMock.order.deleteMany.mockResolvedValue({ count: 1 });
    txMock.holding.deleteMany.mockResolvedValue({ count: 1 });
    txMock.favorite.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('falls back to a legacy insert when auth columns are missing from the database', async () => {
    txMock.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('missing auth column', {
        code: 'P2022',
        clientVersion: '5.22.0',
        meta: { column: 'authProvider' },
      }),
    );
    txMock.$queryRaw.mockResolvedValueOnce([
      {
        id: 'user-1',
        email: 'legacy@example.com',
        nickname: 'tester',
        createdAt: new Date('2026-04-21T00:00:00.000Z'),
        updatedAt: new Date('2026-04-21T00:00:00.000Z'),
      },
    ]);

    const user = await registerUser({
      email: 'legacy@example.com',
      nickname: 'tester',
      password: 'password123',
    });

    expect(txMock.user.create).toHaveBeenCalledTimes(1);
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(txMock.holding.create).toHaveBeenCalledTimes(5);
    expect(user).toEqual({
      id: 'user-1',
      email: 'legacy@example.com',
      nickname: 'tester',
      authProvider: 'email',
      createdAt: '2026-04-21T00:00:00.000Z',
      updatedAt: '2026-04-21T00:00:00.000Z',
    });
  });

  it('maps a legacy insert unique violation to EMAIL_ALREADY_EXISTS', async () => {
    txMock.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('missing auth column', {
        code: 'P2022',
        clientVersion: '5.22.0',
        meta: { column: 'authProvider' },
      }),
    );
    txMock.$queryRaw.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate email', {
        code: 'P2010',
        clientVersion: '5.22.0',
        meta: { code: '23505' },
      }),
    );

    await expect(
      registerUser({
        email: 'duplicate@example.com',
        nickname: 'tester',
        password: 'password123',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'EMAIL_ALREADY_EXISTS',
    });
  });

  it('deletes account-scoped private data, tokens, alerts, relationships, and user row in one transaction', async () => {
    const result = await deleteUserAccount('user-1');

    expect(result).toEqual({ deleted: true });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.authSession.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.authIdentity.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.alertDeliveryLog.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.priceAlert.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.fcmToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.orderRequest.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.exchangeConnectionVerification.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.exchangeConnection.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.order.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.holding.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.favorite.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(txMock.communityReport.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { reporterUserId: 'user-1' },
          { targetType: 'user', targetId: 'user-1' },
        ],
      },
    });
    expect(txMock.userBlock.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerUserId: 'user-1' },
          { blockedUserId: 'user-1' },
        ],
      },
    });
    expect(txMock.userFollow.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { followerUserId: 'user-1' },
          { followingUserId: 'user-1' },
        ],
      },
    });
    expect(txMock.user.deleteMany).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(anonymizeCommunityDataForDeletedUserMock).toHaveBeenCalledWith('user-1');
    expect(removeUserRelationshipStateMock).toHaveBeenCalledWith('user-1');
  });

  it('returns USER_NOT_FOUND when an authenticated token no longer maps to a user row', async () => {
    txMock.user.findUnique.mockResolvedValueOnce(null);

    await expect(deleteUserAccount('missing-user')).rejects.toMatchObject({
      statusCode: 404,
      code: 'USER_NOT_FOUND',
    });
    expect(txMock.authSession.deleteMany).not.toHaveBeenCalled();
    expect(anonymizeCommunityDataForDeletedUserMock).not.toHaveBeenCalled();
  });
});
