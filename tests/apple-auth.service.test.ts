import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, txMock, bcryptMock, verifyAppleIdentityTokenMock } = vi.hoisted(() => ({
  prismaMock: {
    authIdentity: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  txMock: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    authIdentity: {
      create: vi.fn(),
    },
    holding: {
      create: vi.fn(),
    },
  },
  bcryptMock: {
    hash: vi.fn(),
    compare: vi.fn(),
  },
  verifyAppleIdentityTokenMock: vi.fn(),
}));

vi.mock('../src/config/database', () => ({
  prisma: prismaMock,
}));

vi.mock('bcrypt', () => ({
  default: bcryptMock,
}));

vi.mock('../src/modules/auth/social-token.verifier', () => ({
  verifyAppleIdentityToken: verifyAppleIdentityTokenMock,
}));

import { loginWithApple } from '../src/modules/auth/auth.service';

describe('loginWithApple', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.authIdentity.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    bcryptMock.hash.mockResolvedValue('hashed-random-password');
    txMock.user.findUnique.mockResolvedValue(null);
    txMock.user.create.mockImplementation(async ({ data }: { data: { email: string; authProvider: string; nickname: string } }) => ({
      id: 'user-apple-1',
      email: data.email,
      authProvider: data.authProvider,
      nickname: data.nickname,
      createdAt: new Date('2026-04-28T00:00:00.000Z'),
      updatedAt: new Date('2026-04-28T00:00:00.000Z'),
    }));
    txMock.holding.create.mockResolvedValue(undefined);
  });

  it('creates a new Apple user by sub when email and fullName are absent', async () => {
    verifyAppleIdentityTokenMock.mockResolvedValueOnce({
      provider: 'apple',
      sub: 'apple-review-sub-1',
      aud: 'com.hwb.Cryptory',
      emailVerified: false,
    });

    const user = await loginWithApple({
      identityToken: 'header.payload.signature.long-enough',
    });

    expect(user.authProvider).toBe('apple');
    expect(user.nickname).toBe('Apple 사용자');
    expect(user.email).toMatch(/^apple_[a-f0-9]{32}@apple\.local$/);
    expect(txMock.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        authProvider: 'apple',
        providerAccountId: 'apple-review-sub-1',
        email: expect.stringMatching(/^apple_[a-f0-9]{32}@apple\.local$/),
        authIdentities: {
          create: expect.objectContaining({
            provider: 'apple',
            providerAccountId: 'apple-review-sub-1',
            email: undefined,
          }),
        },
      }),
    }));
    expect(txMock.holding.create).toHaveBeenCalledTimes(5);
  });

  it('accepts Apple Private Relay email as the user email', async () => {
    verifyAppleIdentityTokenMock.mockResolvedValueOnce({
      provider: 'apple',
      sub: 'apple-review-sub-2',
      aud: 'com.hwb.Cryptory',
      email: 'ABC123@privaterelay.appleid.com',
      emailVerified: true,
    });

    const user = await loginWithApple({
      identityToken: 'header.payload.signature.long-enough',
      fullName: '',
      email: undefined,
    });

    expect(user.email).toBe('abc123@privaterelay.appleid.com');
    expect(txMock.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: 'abc123@privaterelay.appleid.com',
        authIdentities: {
          create: expect.objectContaining({
            email: 'abc123@privaterelay.appleid.com',
            emailVerified: true,
          }),
        },
      }),
    }));
  });

  it('does not use Apple email as the primary account lookup when the email already exists', async () => {
    verifyAppleIdentityTokenMock.mockResolvedValueOnce({
      provider: 'apple',
      sub: 'apple-review-sub-duplicate-email',
      aud: 'com.hwb.Cryptory',
      email: 'existing@example.com',
      emailVerified: true,
    });
    txMock.user.findUnique.mockResolvedValueOnce({ id: 'email-owner' });

    const user = await loginWithApple({
      identityToken: 'header.payload.signature.long-enough',
    });

    expect(user.email).toMatch(/^apple_[a-f0-9]{32}@apple\.local$/);
    expect(txMock.authIdentity.create).not.toHaveBeenCalled();
    expect(txMock.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: expect.stringMatching(/^apple_[a-f0-9]{32}@apple\.local$/),
        providerAccountId: 'apple-review-sub-duplicate-email',
        authIdentities: {
          create: expect.objectContaining({
            provider: 'apple',
            providerAccountId: 'apple-review-sub-duplicate-email',
            email: 'existing@example.com',
          }),
        },
      }),
    }));
  });

  it('logs in an existing Apple identity by sub even when email is absent on re-login', async () => {
    verifyAppleIdentityTokenMock.mockResolvedValueOnce({
      provider: 'apple',
      sub: 'apple-review-sub-3',
      aud: 'com.hwb.Cryptory',
      emailVerified: false,
    });
    prismaMock.authIdentity.findUnique.mockResolvedValueOnce({
      id: 'identity-1',
      email: 'first-login@privaterelay.appleid.com',
      user: {
        id: 'user-apple-3',
        email: 'first-login@privaterelay.appleid.com',
        authProvider: 'apple',
        nickname: 'Apple 사용자',
        createdAt: new Date('2026-04-28T00:00:00.000Z'),
        updatedAt: new Date('2026-04-28T00:00:00.000Z'),
      },
    });

    const user = await loginWithApple({
      identityToken: 'header.payload.signature.long-enough',
    });

    expect(user.id).toBe('user-apple-3');
    expect(prismaMock.authIdentity.update).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
