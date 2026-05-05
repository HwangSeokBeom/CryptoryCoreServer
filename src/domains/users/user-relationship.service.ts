import { prisma } from '../../config/database';
import { AppError, isDatabaseSchemaMismatchError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export type UserRelationship = {
  userId: string;
  following: boolean;
  followedBy: boolean;
  blocked: boolean;
  blockedBy: boolean;
  me: boolean;
};

const followsByUserId = new Map<string, Set<string>>();
const blocksByUserId = new Map<string, Set<string>>();

function setMember(map: Map<string, Set<string>>, key: string, value: string, enabled: boolean) {
  const set = map.get(key) ?? new Set<string>();
  if (enabled) {
    set.add(value);
  } else {
    set.delete(value);
  }
  map.set(key, set);
}

function hasMember(map: Map<string, Set<string>>, key?: string | null, value?: string | null) {
  return Boolean(key && value && map.get(key)?.has(value));
}

function maskUserId(userId?: string | null) {
  if (!userId) {
    return null;
  }
  return userId.length <= 4 ? '****' : `${userId.slice(0, 2)}***${userId.slice(-2)}`;
}

function logRelationshipFallback(action: string, error: unknown) {
  if (useMemoryOnly()) {
    return;
  }
  if (isDatabaseSchemaMismatchError(error)) {
    return;
  }
  logger.warn(
    { domain: 'user-relationship', action, status: 'db_fallback', err: error },
    `[UserRelationship] action=${action} status=db_fallback`,
  );
}

function useMemoryOnly() {
  return process.env.NODE_ENV === 'test';
}

export function getRelationshipSync(viewerId: string | null | undefined, targetUserId: string): UserRelationship {
  const me = Boolean(viewerId && viewerId === targetUserId);
  return {
    userId: targetUserId,
    following: !me && hasMember(followsByUserId, viewerId, targetUserId),
    followedBy: !me && hasMember(followsByUserId, targetUserId, viewerId),
    blocked: !me && hasMember(blocksByUserId, viewerId, targetUserId),
    blockedBy: !me && hasMember(blocksByUserId, targetUserId, viewerId),
    me,
  };
}

export function getBlockedUserIdsSync(viewerId?: string | null) {
  return viewerId ? [...(blocksByUserId.get(viewerId) ?? [])] : [];
}

async function readRelationshipsFromDb(viewerId: string, targetUserIds: string[]) {
  const uniqueTargetIds = [...new Set(targetUserIds.filter(Boolean))];
  if (uniqueTargetIds.length === 0) {
    return new Map<string, UserRelationship>();
  }

  const [following, followedBy, blocked, blockedBy] = await Promise.all([
    prisma.userFollow.findMany({
      where: { followerUserId: viewerId, followingUserId: { in: uniqueTargetIds } },
      select: { followingUserId: true },
    }),
    prisma.userFollow.findMany({
      where: { followerUserId: { in: uniqueTargetIds }, followingUserId: viewerId },
      select: { followerUserId: true },
    }),
    prisma.userBlock.findMany({
      where: { blockerUserId: viewerId, blockedUserId: { in: uniqueTargetIds } },
      select: { blockedUserId: true },
    }),
    prisma.userBlock.findMany({
      where: { blockerUserId: { in: uniqueTargetIds }, blockedUserId: viewerId },
      select: { blockerUserId: true },
    }),
  ]);

  for (const row of following) setMember(followsByUserId, viewerId, row.followingUserId, true);
  for (const row of followedBy) setMember(followsByUserId, row.followerUserId, viewerId, true);
  for (const row of blocked) setMember(blocksByUserId, viewerId, row.blockedUserId, true);
  for (const row of blockedBy) setMember(blocksByUserId, row.blockerUserId, viewerId, true);

  return new Map(uniqueTargetIds.map((targetUserId) => [targetUserId, getRelationshipSync(viewerId, targetUserId)]));
}

export async function getRelationshipBatch(params: {
  viewerId?: string | null;
  userIds: string[];
}) {
  const uniqueUserIds = [...new Set(params.userIds.filter(Boolean))];
  if (!params.viewerId) {
    return new Map(uniqueUserIds.map((userId) => [userId, getRelationshipSync(null, userId)]));
  }

  try {
    if (useMemoryOnly()) {
      throw new Error('test memory relationship store');
    }
    return await readRelationshipsFromDb(params.viewerId, uniqueUserIds);
  } catch (error) {
    logRelationshipFallback('batch_read', error);
    return new Map(uniqueUserIds.map((userId) => [userId, getRelationshipSync(params.viewerId, userId)]));
  }
}

export async function getRelationship(params: { viewerId: string; targetUserId: string }) {
  const relationships = await getRelationshipBatch({
    viewerId: params.viewerId,
    userIds: [params.targetUserId],
  });
  return relationships.get(params.targetUserId) ?? getRelationshipSync(params.viewerId, params.targetUserId);
}

export async function listBlockedUsers(userId: string) {
  try {
    if (useMemoryOnly()) {
      throw new Error('test memory relationship store');
    }
    const rows = await prisma.userBlock.findMany({
      where: { blockerUserId: userId },
      orderBy: { createdAt: 'desc' },
      select: { blockedUserId: true, createdAt: true },
    });
    for (const row of rows) {
      setMember(blocksByUserId, userId, row.blockedUserId, true);
    }
    return rows.map((row) => ({
      blockedUserId: row.blockedUserId,
      blocked: true,
      createdAt: row.createdAt.toISOString(),
    }));
  } catch (error) {
    logRelationshipFallback('block_list', error);
    return getBlockedUserIdsSync(userId).map((blockedUserId) => ({
      blockedUserId,
      blocked: true,
      createdAt: new Date().toISOString(),
    }));
  }
}

export async function blockUser(params: { blockerUserId: string; blockedUserId: string }) {
  if (params.blockerUserId === params.blockedUserId) {
    throw new AppError(400, '자기 자신은 차단할 수 없습니다', undefined, 'CANNOT_BLOCK_SELF');
  }

  setMember(blocksByUserId, params.blockerUserId, params.blockedUserId, true);
  setMember(followsByUserId, params.blockerUserId, params.blockedUserId, false);
  setMember(followsByUserId, params.blockedUserId, params.blockerUserId, false);

  try {
    if (useMemoryOnly()) {
      throw new Error('test memory relationship store');
    }
    await prisma.$transaction([
      prisma.userBlock.upsert({
        where: {
          blockerUserId_blockedUserId: {
            blockerUserId: params.blockerUserId,
            blockedUserId: params.blockedUserId,
          },
        },
        create: params,
        update: {},
      }),
      prisma.userFollow.deleteMany({
        where: {
          OR: [
            { followerUserId: params.blockerUserId, followingUserId: params.blockedUserId },
            { followerUserId: params.blockedUserId, followingUserId: params.blockerUserId },
          ],
        },
      }),
    ]);
  } catch (error) {
    logRelationshipFallback('block', error);
  }

  logger.info(
    {
      domain: 'user-block',
      blockerUserIdMasked: maskUserId(params.blockerUserId),
      blockedUserIdMasked: maskUserId(params.blockedUserId),
      status: 'blocked',
    },
    `[UserBlock] blockerUserIdMasked=${maskUserId(params.blockerUserId)} blockedUserIdMasked=${maskUserId(params.blockedUserId)} status=blocked`,
  );
  return {
    blockedUserId: params.blockedUserId,
    blocked: true,
  };
}

export async function unblockUser(params: { blockerUserId: string; blockedUserId: string }) {
  setMember(blocksByUserId, params.blockerUserId, params.blockedUserId, false);
  try {
    if (useMemoryOnly()) {
      throw new Error('test memory relationship store');
    }
    await prisma.userBlock.deleteMany({
      where: {
        blockerUserId: params.blockerUserId,
        blockedUserId: params.blockedUserId,
      },
    });
  } catch (error) {
    logRelationshipFallback('unblock', error);
  }
  return {
    blockedUserId: params.blockedUserId,
    blocked: false,
  };
}

export async function setFollowState(params: { followerUserId: string; followingUserId: string; follow: boolean }) {
  if (params.followerUserId === params.followingUserId && params.follow) {
    throw new AppError(400, '자기 자신은 팔로우할 수 없습니다', undefined, 'CANNOT_FOLLOW_SELF');
  }

  const relationship = await getRelationship({
    viewerId: params.followerUserId,
    targetUserId: params.followingUserId,
  });
  if (params.follow && (relationship.blocked || relationship.blockedBy)) {
    throw new AppError(403, '차단 관계에서는 팔로우할 수 없습니다', undefined, 'FOLLOW_BLOCKED_USER_FORBIDDEN');
  }

  setMember(followsByUserId, params.followerUserId, params.followingUserId, params.follow);

  try {
    if (useMemoryOnly()) {
      throw new Error('test memory relationship store');
    }
    if (params.follow) {
      await prisma.userFollow.upsert({
        where: {
          followerUserId_followingUserId: {
            followerUserId: params.followerUserId,
            followingUserId: params.followingUserId,
          },
        },
        create: {
          followerUserId: params.followerUserId,
          followingUserId: params.followingUserId,
        },
        update: {},
      });
    } else {
      await prisma.userFollow.deleteMany({
        where: {
          followerUserId: params.followerUserId,
          followingUserId: params.followingUserId,
        },
      });
    }
  } catch (error) {
    logRelationshipFallback(params.follow ? 'follow' : 'unfollow', error);
  }

  return getUserFollowState({
    userId: params.followerUserId,
    targetUserId: params.followingUserId,
  });
}

export async function getUserFollowState(params: { userId?: string | null; targetUserId: string }) {
  let followerCount = 0;
  try {
    if (useMemoryOnly()) {
      throw new Error('test memory relationship store');
    }
    followerCount = await prisma.userFollow.count({
      where: { followingUserId: params.targetUserId },
    });
  } catch (error) {
    logRelationshipFallback('follower_count', error);
    for (const targets of followsByUserId.values()) {
      if (targets.has(params.targetUserId)) {
        followerCount += 1;
      }
    }
  }

  const relationship = params.userId
    ? await getRelationship({ viewerId: params.userId, targetUserId: params.targetUserId })
    : getRelationshipSync(null, params.targetUserId);

  return {
    targetUserId: params.targetUserId,
    userId: params.targetUserId,
    isFollowing: relationship.following,
    following: relationship.following,
    followedBy: relationship.followedBy,
    blocked: relationship.blocked,
    blockedBy: relationship.blockedBy,
    me: relationship.me,
    followerCount,
    updatedAt: new Date().toISOString(),
  };
}

export async function listFollowing(userId: string) {
  try {
    if (useMemoryOnly()) {
      throw new Error('test memory relationship store');
    }
    const rows = await prisma.userFollow.findMany({
      where: { followerUserId: userId },
      orderBy: { createdAt: 'desc' },
      select: { followingUserId: true, createdAt: true },
    });
    return rows.map((row) => ({
      userId: row.followingUserId,
      followedAt: row.createdAt.toISOString(),
      relationship: getRelationshipSync(userId, row.followingUserId),
    }));
  } catch (error) {
    logRelationshipFallback('following_list', error);
    return [...(followsByUserId.get(userId) ?? [])].map((targetUserId) => ({
      userId: targetUserId,
      followedAt: new Date().toISOString(),
      relationship: getRelationshipSync(userId, targetUserId),
    }));
  }
}

export async function listFollowers(params: { viewerId: string; userId: string }) {
  try {
    if (useMemoryOnly()) {
      throw new Error('test memory relationship store');
    }
    const rows = await prisma.userFollow.findMany({
      where: { followingUserId: params.userId },
      orderBy: { createdAt: 'desc' },
      select: { followerUserId: true, createdAt: true },
    });
    const relationships = await getRelationshipBatch({
      viewerId: params.viewerId,
      userIds: rows.map((row) => row.followerUserId),
    });
    return rows.map((row) => ({
      userId: row.followerUserId,
      followedAt: row.createdAt.toISOString(),
      relationship: relationships.get(row.followerUserId) ?? getRelationshipSync(params.viewerId, row.followerUserId),
    }));
  } catch (error) {
    logRelationshipFallback('followers_list', error);
    const rows: Array<{ userId: string; followedAt: string; relationship: UserRelationship }> = [];
    for (const [followerUserId, targets] of followsByUserId.entries()) {
      if (targets.has(params.userId)) {
        rows.push({
          userId: followerUserId,
          followedAt: new Date().toISOString(),
          relationship: getRelationshipSync(params.viewerId, followerUserId),
        });
      }
    }
    return rows;
  }
}
