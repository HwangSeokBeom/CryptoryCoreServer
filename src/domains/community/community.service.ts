import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { AppError, isDatabaseSchemaMismatchError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { communityCommentExists, communityPostExists } from '../coins/coin-community.service';
import { getNewsById } from '../news/news.service';

export type CommunityReportTargetType = 'post' | 'comment' | 'user' | 'news';
export type CommunityReportReason = 'spam' | 'harassment' | 'sexual' | 'scam' | 'privacy' | 'other';

type StoredReport = {
  id: string;
  reporterUserId: string;
  targetType: CommunityReportTargetType;
  targetId: string;
  reason: CommunityReportReason;
  description: string | null;
  status: 'received';
  createdAt: string;
  updatedAt: string;
};

const reportsByDuplicateKey = new Map<string, StoredReport>();

function duplicateKey(params: { reporterUserId: string; targetType: string; targetId: string }) {
  return `${params.reporterUserId}:${params.targetType}:${params.targetId}`;
}

function sanitizeDescription(value?: string | null) {
  return value
    ?.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

async function userExists(userId: string) {
  if (process.env.NODE_ENV === 'test') {
    return true;
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    return Boolean(user);
  } catch (error) {
    if (process.env.NODE_ENV !== 'test' && !isDatabaseSchemaMismatchError(error)) {
      logger.warn(
        { domain: 'community-report', action: 'user_exists_fallback', err: error },
        '[CommunityReport] action=user_exists status=db_fallback',
      );
    }
    return true;
  }
}

async function assertTargetExists(params: {
  reporterUserId: string;
  targetType: CommunityReportTargetType;
  targetId: string;
}) {
  if (params.targetType === 'user') {
    if (params.reporterUserId === params.targetId) {
      throw new AppError(400, '자기 자신은 신고할 수 없습니다', undefined, 'CANNOT_REPORT_SELF');
    }
    if (!(await userExists(params.targetId))) {
      throw new AppError(404, 'report target not found', undefined, 'REPORT_TARGET_NOT_FOUND');
    }
    return;
  }
  if (params.targetType === 'post' && !communityPostExists(params.targetId)) {
    throw new AppError(404, 'report target not found', undefined, 'REPORT_TARGET_NOT_FOUND');
  }
  if (params.targetType === 'comment' && !communityCommentExists(params.targetId)) {
    throw new AppError(404, 'report target not found', undefined, 'REPORT_TARGET_NOT_FOUND');
  }
  if (params.targetType === 'news' && !getNewsById(params.targetId)) {
    throw new AppError(404, 'report target not found', undefined, 'REPORT_TARGET_NOT_FOUND');
  }
}

export async function createCommunityReport(params: {
  reporterUserId: string;
  targetType: CommunityReportTargetType;
  targetId: string;
  reason: CommunityReportReason;
  description?: string | null;
}) {
  await assertTargetExists(params);
  const description = sanitizeDescription(params.description);
  const key = duplicateKey(params);
  const existingMemory = reportsByDuplicateKey.get(key);
  if (existingMemory) {
    return {
      reportId: existingMemory.id,
      status: existingMemory.status,
      duplicate: true,
    };
  }

  try {
    if (process.env.NODE_ENV === 'test') {
      throw new Error('test memory report store');
    }
    const row = await prisma.communityReport.upsert({
      where: {
        reporterUserId_targetType_targetId: {
          reporterUserId: params.reporterUserId,
          targetType: params.targetType,
          targetId: params.targetId,
        },
      },
      create: {
        reporterUserId: params.reporterUserId,
        targetType: params.targetType,
        targetId: params.targetId,
        reason: params.reason,
        description,
        status: 'received',
      },
      update: {},
    });
    reportsByDuplicateKey.set(key, {
      id: row.id,
      reporterUserId: row.reporterUserId,
      targetType: row.targetType as CommunityReportTargetType,
      targetId: row.targetId,
      reason: row.reason as CommunityReportReason,
      description: row.description,
      status: 'received',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
    return {
      reportId: row.id,
      status: row.status,
      duplicate: false,
    };
  } catch (error) {
    if (process.env.NODE_ENV !== 'test' && !isDatabaseSchemaMismatchError(error)) {
      logger.warn(
        { domain: 'community-report', action: 'create_db_fallback', err: error },
        '[CommunityReport] action=create status=db_fallback',
      );
    }
    const now = new Date().toISOString();
    const stored: StoredReport = {
      id: randomUUID(),
      reporterUserId: params.reporterUserId,
      targetType: params.targetType,
      targetId: params.targetId,
      reason: params.reason,
      description,
      status: 'received',
      createdAt: now,
      updatedAt: now,
    };
    reportsByDuplicateKey.set(key, stored);
    return {
      reportId: stored.id,
      status: stored.status,
      duplicate: false,
    };
  }
}
