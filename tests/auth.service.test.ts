import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { prismaMock, bcryptMock, txMock } = vi.hoisted(() => ({
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
      create: vi.fn(),
    },
    $queryRaw: vi.fn(),
    holding: {
      create: vi.fn(),
    },
  },
}));

vi.mock('../src/config/database', () => ({
  prisma: prismaMock,
}));

vi.mock('bcrypt', () => ({
  default: bcryptMock,
}));

import { registerUser } from '../src/modules/auth/auth.service';

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
});
