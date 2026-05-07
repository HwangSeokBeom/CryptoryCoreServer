import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import type { UserRelationship } from '../users/user-relationship.service';
import { getBlockedUserIdsSync, getRelationshipSync } from '../users/user-relationship.service';
import { normalizeCoinSymbol } from './coin-symbol';

export type CommunitySort = 'latest' | 'oldest' | 'popular';
export type CommunityOrderBy = 'createdAt' | 'likeCount' | 'commentCount';
export type SortDirection = 'asc' | 'desc';
export type CommunityFilter = 'all' | 'holder' | 'profit' | 'activity';
export type VoteDirection = 'bullish' | 'bearish';

export type CommunityAuthor = {
  id: string | null;
  nickname: string | null;
  displayName: string;
  emailMasked: string | null;
  isPrivateRelay: boolean;
  avatarUrl: string | null;
  isFollowing: boolean;
  followable: boolean;
  isMe: boolean;
};

export type CoinCommunityItem = {
  id: string;
  author: CommunityAuthor;
  authorRelationship: UserRelationship;
  authorName: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  content: string;
  symbol: string;
  tags: string[];
  likeCount: number;
  replyCount: number;
  commentCount: number;
  isLiked: boolean;
  isFollowing: boolean;
  badge: string | null;
  myReaction: string | null;
  reportable: boolean;
  blockable: boolean;
};

export type CommunityComment = {
  id: string;
  postId: string;
  itemId: string;
  content: string;
  author: CommunityAuthor;
  authorRelationship: UserRelationship;
  createdAt: string;
  updatedAt: string;
  reportable?: boolean;
  blockable?: boolean;
};

export type CoinCommunityPoll = {
  bullishCount: number;
  bearishCount: number;
  participantCount: number;
  myVote: VoteDirection | null;
};

export type CoinCommunityListResponse = {
  symbol: string;
  vote: CoinCommunityPoll;
  items: CoinCommunityItem[];
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
  };
  summary: {
    itemCount: number;
    participantCount: number;
  };
  nextCursor: string | null;
  sort: {
    orderBy: CommunityOrderBy;
    direction: SortDirection;
  };
};

export type SentimentScope = 'coin' | 'market';

export type SentimentResponse = {
  scope: SentimentScope;
  symbol?: string;
  date: string;
  totalParticipants: number;
  bullishCount: number;
  bearishCount: number;
  bullishRatio: number;
  bearishRatio: number;
  ratioScale: 'percent';
  myVote: VoteDirection | null;
  updatedAt: string;
};

type StoredCommunityItem = CoinCommunityItem & {
  authorId: string;
  authorEmail?: string | null;
};

export const MAX_COMMUNITY_CONTENT_LENGTH = 1000;

// TODO: Replace this in-memory store with a persistent community repository.
const postsBySymbol = new Map<string, StoredCommunityItem[]>();
const votesBySymbol = new Map<string, Map<string, VoteDirection>>();
const sentimentVotesByScope = new Map<string, Map<string, VoteDirection>>();
const sentimentUpdatedAtByScope = new Map<string, string>();
const likesByItemId = new Map<string, Set<string>>();
const commentsByItemId = new Map<string, CommunityComment[]>();

const deletedCommunityAuthor: CommunityAuthor = {
  id: null,
  nickname: null,
  displayName: '탈퇴한 사용자',
  emailMasked: null,
  isPrivateRelay: false,
  avatarUrl: null,
  isFollowing: false,
  followable: false,
  isMe: false,
};

function parseLimit(limit?: number) {
  if (!Number.isFinite(limit) || !limit) {
    return 20;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 50);
}

function normalizeContent(content: unknown) {
  if (typeof content !== 'string') {
    return null;
  }
  return content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

export function validateCommunityContent(content: unknown) {
  const normalized = normalizeContent(content);
  if (!normalized) {
    return {
      ok: false as const,
      message: 'content is required',
    };
  }
  if (normalized.length > MAX_COMMUNITY_CONTENT_LENGTH) {
    return {
      ok: false as const,
      message: `content must be ${MAX_COMMUNITY_CONTENT_LENGTH} characters or fewer`,
    };
  }
  return {
    ok: true as const,
    content: normalized,
  };
}

function getPoll(symbol: string, userId?: string | null): CoinCommunityPoll {
  const votes = votesBySymbol.get(symbol) ?? new Map<string, VoteDirection>();
  let bullishCount = 0;
  let bearishCount = 0;
  for (const direction of votes.values()) {
    if (direction === 'bullish') {
      bullishCount += 1;
    } else {
      bearishCount += 1;
    }
  }

  return {
    bullishCount,
    bearishCount,
    participantCount: bullishCount + bearishCount,
    myVote: userId ? votes.get(userId) ?? null : null,
  };
}

function currentUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function sentimentKey(params: { scope: SentimentScope; symbol?: string | null; date?: string }) {
  const date = params.date ?? currentUtcDate();
  return params.scope === 'coin'
    ? `coin:${normalizeCoinSymbol(params.symbol ?? '')}:${date}`
    : `market:${date}`;
}

function toPercent(count: number, total: number) {
  return total > 0 ? Math.round((count / total) * 10000) / 100 : 0;
}

function buildSentimentResponse(params: {
  scope: SentimentScope;
  symbol?: string | null;
  userId?: string | null;
  date?: string;
}): SentimentResponse {
  const date = params.date ?? currentUtcDate();
  const symbol = params.scope === 'coin' ? normalizeCoinSymbol(params.symbol ?? '') : undefined;
  const key = sentimentKey({ scope: params.scope, symbol, date });
  const votes = sentimentVotesByScope.get(key) ?? new Map<string, VoteDirection>();
  let bullishCount = 0;
  let bearishCount = 0;
  for (const vote of votes.values()) {
    if (vote === 'bullish') {
      bullishCount += 1;
    } else {
      bearishCount += 1;
    }
  }
  const totalParticipants = votes.size;
  return {
    scope: params.scope,
    ...(symbol ? { symbol } : {}),
    date,
    totalParticipants,
    bullishCount,
    bearishCount,
    bullishRatio: toPercent(bullishCount, totalParticipants),
    bearishRatio: toPercent(bearishCount, totalParticipants),
    ratioScale: 'percent',
    myVote: params.userId ? votes.get(params.userId) ?? null : null,
    updatedAt: sentimentUpdatedAtByScope.get(key) ?? new Date(`${date}T00:00:00.000Z`).toISOString(),
  };
}

function upsertSentimentVote(params: {
  scope: SentimentScope;
  symbol?: string | null;
  userId: string;
  vote: VoteDirection;
  date?: string;
}) {
  const date = params.date ?? currentUtcDate();
  const symbol = params.scope === 'coin' ? normalizeCoinSymbol(params.symbol ?? '') : undefined;
  const key = sentimentKey({ scope: params.scope, symbol, date });
  const votes = sentimentVotesByScope.get(key) ?? new Map<string, VoteDirection>();
  votes.set(params.userId, params.vote);
  sentimentVotesByScope.set(key, votes);
  sentimentUpdatedAtByScope.set(key, new Date().toISOString());
  return buildSentimentResponse({
    scope: params.scope,
    symbol,
    userId: params.userId,
    date,
  });
}

function participantCountForPosts(symbol: string) {
  const authorIds = new Set((postsBySymbol.get(symbol) ?? []).map((item) => item.authorId).filter(Boolean));
  return authorIds.size;
}

function maskEmail(email?: string | null) {
  if (!email?.trim() || !email.includes('@')) {
    return null;
  }
  const [localPart, domain] = email.trim().split('@');
  const prefix = localPart.slice(0, Math.min(2, localPart.length));
  return `${prefix}${localPart.length > 2 ? '***' : '*'}@${domain}`;
}

function isPrivateRelayEmail(value?: string | null) {
  return Boolean(value?.trim().toLowerCase().endsWith('@privaterelay.appleid.com'));
}

function deriveDisplayName(params: {
  profileDisplayName?: string | null;
  nickname?: string | null;
  name?: string | null;
  email?: string | null;
  userId?: string | null;
}) {
  const candidates = [
    { source: 'profile.displayName', value: params.profileDisplayName },
    { source: 'nickname', value: params.nickname },
    { source: 'name', value: params.name },
  ];
  for (const candidate of candidates) {
    const trimmed = candidate.value?.trim();
    if (trimmed && !trimmed.includes('@')) {
      logger.info(
        {
          domain: 'coin-community',
          userIdMasked: maskUserId(params.userId),
          source: candidate.source,
          isPrivateRelay: false,
          displayNameGenerated: true,
        },
        `[AuthorDisplayName] userIdMasked=${maskUserId(params.userId) ?? ''} source=${candidate.source} isPrivateRelay=false displayNameGenerated=true`,
      );
      return { displayName: trimmed, source: candidate.source };
    }
  }
  const email = params.email?.trim() ?? null;
  const privateRelay = isPrivateRelayEmail(email);
  if (privateRelay) {
    logger.info(
      {
        domain: 'coin-community',
        userIdMasked: maskUserId(params.userId),
        source: 'apple_private_relay_email',
        isPrivateRelay: true,
        displayNameGenerated: true,
      },
      `[AuthorDisplayName] userIdMasked=${maskUserId(params.userId) ?? ''} source=apple_private_relay_email isPrivateRelay=true displayNameGenerated=true`,
    );
    return { displayName: 'Apple 사용자', source: 'apple_private_relay_email' };
  }
  if (email?.includes('@')) {
    logger.info(
      {
        domain: 'coin-community',
        userIdMasked: maskUserId(params.userId),
        source: 'masked_email',
        isPrivateRelay: false,
        displayNameGenerated: true,
      },
      `[AuthorDisplayName] userIdMasked=${maskUserId(params.userId) ?? ''} source=masked_email isPrivateRelay=false displayNameGenerated=true`,
    );
    return { displayName: maskEmail(email) ?? '사용자', source: 'masked_email' };
  }
  logger.info(
    {
      domain: 'coin-community',
      userIdMasked: maskUserId(params.userId),
      source: 'fallback',
      isPrivateRelay: false,
      displayNameGenerated: true,
    },
    `[AuthorDisplayName] userIdMasked=${maskUserId(params.userId) ?? ''} source=fallback isPrivateRelay=false displayNameGenerated=true`,
  );
  return { displayName: '사용자', source: 'fallback' };
}

function normalizeNickname(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.includes('@')) {
    return trimmed;
  }
  return null;
}

function isFollowingAuthor(viewerId: string | null | undefined, authorId?: string | null) {
  return Boolean(authorId && getRelationshipSync(viewerId, authorId).following);
}

function maskUserId(userId?: string | null) {
  if (!userId) {
    return null;
  }
  return userId.length <= 4 ? '****' : `${userId.slice(0, 2)}***${userId.slice(-2)}`;
}

function projectAuthor(params: {
  authorId?: string | null;
  profileDisplayName?: string | null;
  nickname?: string | null;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  viewerId?: string | null;
}): CommunityAuthor {
  const authorId = params.authorId ? String(params.authorId) : null;
  const nickname = normalizeNickname(params.nickname);
  const generated = deriveDisplayName({
    profileDisplayName: params.profileDisplayName,
    nickname,
    name: params.name,
    email: params.email,
    userId: authorId,
  });
  const followable = Boolean(authorId);
  const isMe = Boolean(authorId && params.viewerId && authorId === params.viewerId);
  return {
    id: authorId,
    nickname,
    displayName: generated.displayName,
    emailMasked: maskEmail(params.email),
    isPrivateRelay: isPrivateRelayEmail(params.email),
    avatarUrl: params.avatarUrl ?? null,
    isFollowing: isFollowingAuthor(params.viewerId, authorId),
    followable,
    isMe,
  };
}

function findCommunityItem(symbolInput: string, itemId: string) {
  const symbol = normalizeCoinSymbol(symbolInput);
  const item = (postsBySymbol.get(symbol) ?? []).find((candidate) => candidate.id === itemId);
  return item ? { symbol, item } : null;
}

function getLikeCount(itemId: string) {
  return likesByItemId.get(itemId)?.size ?? 0;
}

function getCommentCount(itemId: string) {
  return commentsByItemId.get(itemId)?.length ?? 0;
}

function resolveCommunitySort(params: {
  sort?: CommunitySort;
  orderBy?: CommunityOrderBy;
  direction?: SortDirection;
}) {
  if (params.sort === 'popular') {
    return {
      orderBy: params.orderBy ?? 'likeCount',
      direction: params.direction ?? 'desc',
    };
  }
  if (params.sort === 'oldest') {
    return {
      orderBy: params.orderBy ?? 'createdAt',
      direction: params.direction ?? 'asc',
    };
  }
  return {
    orderBy: params.orderBy ?? 'createdAt',
    direction: params.direction ?? (params.sort === 'latest' ? 'desc' : 'desc'),
  };
}

function compareCommunityItems(left: StoredCommunityItem, right: StoredCommunityItem, sort: ReturnType<typeof resolveCommunitySort>) {
  const directionMultiplier = sort.direction === 'asc' ? 1 : -1;
  const value = (item: StoredCommunityItem) => {
    if (sort.orderBy === 'likeCount') return getLikeCount(item.id);
    if (sort.orderBy === 'commentCount') return getCommentCount(item.id);
    return Date.parse(item.createdAt);
  };
  const diff = value(left) - value(right);
  if (diff !== 0) {
    return diff * directionMultiplier;
  }
  return (Date.parse(left.createdAt) - Date.parse(right.createdAt)) * -1;
}

function compareComments(left: CommunityComment, right: CommunityComment, sort: { orderBy: 'createdAt'; direction: SortDirection }) {
  const diff = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return sort.direction === 'asc' ? diff : -diff;
}

function projectCommunityItem(item: StoredCommunityItem, viewerId?: string | null): CoinCommunityItem {
  const likeCount = getLikeCount(item.id);
  const commentCount = getCommentCount(item.id);
  const isLiked = Boolean(viewerId && likesByItemId.get(item.id)?.has(viewerId));
  const author = projectAuthor({
    authorId: String(item.author.id || item.authorId),
    nickname: item.author.nickname,
    name: item.authorName,
    email: item.authorEmail ?? null,
    avatarUrl: item.author.avatarUrl ?? item.avatarUrl ?? null,
    viewerId,
  });
  const authorRelationship = getRelationshipSync(viewerId, author.id ?? item.authorId);
  logger.info(
    {
      domain: 'coin-community',
      itemId: item.id,
      hasDisplayName: Boolean(author.displayName),
      hasEmailMasked: Boolean(author.emailMasked),
      followable: author.followable,
      isMe: author.isMe,
    },
    `[CommunityAuthorDTO] itemId=${item.id} hasDisplayName=${Boolean(author.displayName)} hasEmailMasked=${Boolean(author.emailMasked)} followable=${author.followable} isMe=${author.isMe}`,
  );
  return {
    id: String(item.id),
    symbol: item.symbol,
    content: item.content,
    author,
    authorRelationship,
    authorName: author.displayName,
    avatarUrl: item.avatarUrl,
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt ?? item.createdAt).toISOString(),
    tags: item.tags,
    likeCount,
    replyCount: commentCount,
    commentCount,
    isLiked,
    isFollowing: author.isFollowing,
    badge: item.badge,
    myReaction: isLiked ? 'like' : null,
    reportable: Boolean(viewerId && viewerId !== author.id),
    blockable: Boolean(viewerId && author.id && viewerId !== author.id),
  };
}

export function listCoinCommunity(params: {
  symbol: string;
  sort?: CommunitySort;
  orderBy?: CommunityOrderBy;
  direction?: SortDirection;
  filter?: CommunityFilter;
  cursor?: string;
  limit?: number;
  userId?: string | null;
}): CoinCommunityListResponse {
  const symbol = normalizeCoinSymbol(params.symbol);
  const limit = parseLimit(params.limit);
  const allItems = [...(postsBySymbol.get(symbol) ?? [])];
  const blockedUserIds = new Set(getBlockedUserIdsSync(params.userId));
  const appliedSort = resolveCommunitySort(params);
  const sorted = allItems.sort((left, right) => compareCommunityItems(left, right, appliedSort));
  const relationshipFiltered = params.userId
    ? sorted.filter((item) => !blockedUserIds.has(item.authorId))
    : sorted;
  const filtered = params.filter && params.filter !== 'all'
    ? relationshipFiltered.filter((item) => item.tags.includes(params.filter as string) || item.badge === params.filter)
    : relationshipFiltered;
  const offset = params.cursor
    ? Math.max(filtered.findIndex((item) => item.id === params.cursor) + 1, 0)
    : 0;
  const items = filtered.slice(offset, offset + limit);
  const next = filtered[offset + limit];
  const participantCount = participantCountForPosts(symbol);

  const response = {
    symbol,
    vote: getPoll(symbol, params.userId),
    items: items.map((item) => projectCommunityItem(item, params.userId)),
    pagination: {
      nextCursor: next?.id ?? null,
      hasMore: Boolean(next),
    },
    summary: {
      itemCount: allItems.length,
      participantCount,
    },
    nextCursor: next?.id ?? null,
    sort: appliedSort,
  };
  logger.info(
    {
      domain: 'coin-community',
      symbol: response.symbol,
      participantCount: response.summary.participantCount,
      itemCount: response.items.length,
    },
    `[Community] symbol=${response.symbol} participantCount=${response.summary.participantCount} itemCount=${response.items.length}`,
  );
  return response;
}

export function createCoinCommunityPost(params: {
  symbol: string;
  userId: string;
  authorName?: string | null;
  content: string;
}) {
  const symbol = normalizeCoinSymbol(params.symbol);
  const createdAt = new Date().toISOString();
  const author = projectAuthor({
    authorId: params.userId,
    email: params.authorName,
    viewerId: params.userId,
  });
  const item: StoredCommunityItem = {
    id: randomUUID(),
    authorId: params.userId,
    authorEmail: params.authorName ?? null,
    authorName: author.displayName,
    author,
    authorRelationship: getRelationshipSync(params.userId, params.userId),
    avatarUrl: null,
    createdAt,
    updatedAt: createdAt,
    content: params.content,
    symbol,
    tags: ['activity'],
    likeCount: 0,
    replyCount: 0,
    commentCount: 0,
    isLiked: false,
    isFollowing: false,
    badge: 'activity',
    myReaction: null,
    reportable: false,
    blockable: false,
  };

  const posts = postsBySymbol.get(symbol) ?? [];
  posts.unshift(item);
  postsBySymbol.set(symbol, posts.slice(0, 500));

  return {
    item: projectCommunityItem(item, params.userId),
    summary: {
      itemCount: postsBySymbol.get(symbol)?.length ?? 0,
      participantCount: participantCountForPosts(symbol),
    },
  };
}

export function likeCommunityItem(params: { symbol: string; itemId: string; userId: string }) {
  const found = findCommunityItem(params.symbol, params.itemId);
  if (!found) {
    return null;
  }
  const likes = likesByItemId.get(params.itemId) ?? new Set<string>();
  likes.add(params.userId);
  likesByItemId.set(params.itemId, likes);
  found.item.likeCount = likes.size;
  found.item.updatedAt = new Date().toISOString();
  return {
    itemId: params.itemId,
    symbol: found.symbol,
    isLiked: true,
    likeCount: likes.size,
    updatedAt: found.item.updatedAt,
  };
}

export function unlikeCommunityItem(params: { symbol: string; itemId: string; userId: string }) {
  const found = findCommunityItem(params.symbol, params.itemId);
  if (!found) {
    return null;
  }
  const likes = likesByItemId.get(params.itemId) ?? new Set<string>();
  likes.delete(params.userId);
  likesByItemId.set(params.itemId, likes);
  found.item.likeCount = likes.size;
  found.item.updatedAt = new Date().toISOString();
  return {
    itemId: params.itemId,
    symbol: found.symbol,
    isLiked: false,
    likeCount: likes.size,
    updatedAt: found.item.updatedAt,
  };
}

export function listCommunityComments(params: {
  symbol: string;
  itemId: string;
  cursor?: string;
  limit?: number;
  userId?: string | null;
  sort?: 'latest' | 'oldest';
  direction?: SortDirection;
}) {
  const found = findCommunityItem(params.symbol, params.itemId);
  if (!found) {
    return null;
  }
  const limit = parseLimit(params.limit);
  const blockedUserIds = new Set(getBlockedUserIdsSync(params.userId));
  const appliedSort = {
    orderBy: 'createdAt' as const,
    direction: params.direction ?? (params.sort === 'oldest' ? 'asc' : 'desc') as SortDirection,
  };
  const allComments = (commentsByItemId.get(params.itemId) ?? [])
    .filter((comment) => !params.userId || !comment.author.id || !blockedUserIds.has(comment.author.id))
    .map((comment) => ({
      ...comment,
      postId: comment.itemId,
      author: projectAuthor({
        authorId: comment.author.id,
        nickname: comment.author.nickname,
        email: comment.author.emailMasked,
        avatarUrl: comment.author.avatarUrl,
        viewerId: params.userId,
      }),
      authorRelationship: getRelationshipSync(params.userId, comment.author.id ?? ''),
      reportable: Boolean(params.userId && params.userId !== comment.author.id),
      blockable: Boolean(params.userId && comment.author.id && params.userId !== comment.author.id),
    }))
    .sort((left, right) => compareComments(left, right, appliedSort));
  const offset = params.cursor
    ? Math.max(allComments.findIndex((item) => item.id === params.cursor) + 1, 0)
    : 0;
  const items = allComments.slice(offset, offset + limit);
  const next = allComments[offset + limit];
  return {
    symbol: found.symbol,
    itemId: params.itemId,
    items,
    pagination: {
      nextCursor: next?.id ?? null,
      hasMore: Boolean(next),
    },
    summary: {
      commentCount: allComments.length,
    },
    count: allComments.length,
    sort: appliedSort,
  };
}

export function createCommunityComment(params: {
  symbol: string;
  itemId: string;
  userId: string;
  authorName?: string | null;
  content: string;
}) {
  const found = findCommunityItem(params.symbol, params.itemId);
  if (!found) {
    return null;
  }
  const createdAt = new Date().toISOString();
  const comment: CommunityComment = {
    id: randomUUID(),
    postId: params.itemId,
    itemId: params.itemId,
    content: params.content,
    author: projectAuthor({
      authorId: params.userId,
      email: params.authorName,
      avatarUrl: null,
      viewerId: params.userId,
    }),
    authorRelationship: getRelationshipSync(params.userId, params.userId),
    createdAt,
    updatedAt: createdAt,
    reportable: false,
    blockable: false,
  };
  const comments = commentsByItemId.get(params.itemId) ?? [];
  comments.push(comment);
  commentsByItemId.set(params.itemId, comments);
  found.item.replyCount = comments.length;
  found.item.commentCount = comments.length;
  found.item.updatedAt = createdAt;
  return {
    comment,
    summary: {
      commentCount: comments.length,
    },
  };
}

export function communityPostExists(itemId: string) {
  for (const posts of postsBySymbol.values()) {
    if (posts.some((item) => item.id === itemId)) {
      return true;
    }
  }
  return false;
}

export function communityCommentExists(commentId: string) {
  for (const comments of commentsByItemId.values()) {
    if (comments.some((comment) => comment.id === commentId)) {
      return true;
    }
  }
  return false;
}

export function voteCoinDirection(params: {
  symbol: string;
  userId: string;
  direction: VoteDirection;
}) {
  const symbol = normalizeCoinSymbol(params.symbol);
  const votes = votesBySymbol.get(symbol) ?? new Map<string, VoteDirection>();
  votes.set(params.userId, params.direction);
  votesBySymbol.set(symbol, votes);
  return {
    symbol,
    vote: {
      ...getPoll(symbol, params.userId),
      myVote: params.direction,
    },
  };
}

export function getCoinSentiment(params: { symbol: string; userId?: string | null; date?: string }) {
  return buildSentimentResponse({
    scope: 'coin',
    symbol: params.symbol,
    userId: params.userId,
    date: params.date,
  });
}

export function voteCoinSentiment(params: { symbol: string; userId: string; vote: VoteDirection; date?: string }) {
  return upsertSentimentVote({
    scope: 'coin',
    symbol: params.symbol,
    userId: params.userId,
    vote: params.vote,
    date: params.date,
  });
}

export function getMarketSentiment(params: { userId?: string | null; date?: string } = {}) {
  return buildSentimentResponse({
    scope: 'market',
    userId: params.userId,
    date: params.date,
  });
}

export function voteMarketSentiment(params: { userId: string; vote: VoteDirection; date?: string }) {
  return upsertSentimentVote({
    scope: 'market',
    userId: params.userId,
    vote: params.vote,
    date: params.date,
  });
}

export function getMarketPoll(userId?: string | null) {
  const sentiment = getMarketSentiment({ userId });
  return {
    bullishCount: sentiment.bullishCount,
    bearishCount: sentiment.bearishCount,
    participantCount: sentiment.totalParticipants,
    myVote: sentiment.myVote,
  };
}

export function anonymizeCommunityDataForDeletedUser(userId: string) {
  for (const [symbol, posts] of postsBySymbol.entries()) {
    postsBySymbol.set(symbol, posts.map((item) => {
      if (item.authorId !== userId && item.author.id !== userId) {
        return item;
      }
      return {
        ...item,
        authorId: '',
        authorEmail: null,
        authorName: deletedCommunityAuthor.displayName,
        author: deletedCommunityAuthor,
        authorRelationship: getRelationshipSync(null, ''),
        avatarUrl: null,
        updatedAt: new Date().toISOString(),
        reportable: false,
        blockable: false,
      };
    }));
  }

  for (const [itemId, likes] of likesByItemId.entries()) {
    likes.delete(userId);
    likesByItemId.set(itemId, likes);
  }

  for (const [itemId, comments] of commentsByItemId.entries()) {
    commentsByItemId.set(itemId, comments.map((comment) => {
      if (comment.author.id !== userId) {
        return comment;
      }
      return {
        ...comment,
        author: deletedCommunityAuthor,
        authorRelationship: getRelationshipSync(null, ''),
        updatedAt: new Date().toISOString(),
        reportable: false,
        blockable: false,
      };
    }));
  }

  for (const votes of votesBySymbol.values()) {
    votes.delete(userId);
  }
  for (const votes of sentimentVotesByScope.values()) {
    votes.delete(userId);
  }
}
