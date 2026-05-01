import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import { normalizeCoinSymbol } from './coin-symbol';

export type CommunitySort = 'latest' | 'popular';
export type CommunityFilter = 'all' | 'holder' | 'profit' | 'activity';
export type VoteDirection = 'bullish' | 'bearish';

export type CoinCommunityItem = {
  id: string;
  authorName: string;
  avatarUrl: string | null;
  createdAt: string;
  content: string;
  symbol: string;
  tags: string[];
  likeCount: number;
  commentCount: number;
  isFollowing: boolean;
  badge: string | null;
  myReaction: string | null;
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
  nextCursor: string | null;
};

type StoredCommunityItem = CoinCommunityItem & {
  authorId: string;
};

export const MAX_COMMUNITY_CONTENT_LENGTH = 1000;

// TODO: Replace this in-memory store with a persistent community repository.
const postsBySymbol = new Map<string, StoredCommunityItem[]>();
const votesBySymbol = new Map<string, Map<string, VoteDirection>>();

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

export function listCoinCommunity(params: {
  symbol: string;
  sort?: CommunitySort;
  filter?: CommunityFilter;
  cursor?: string;
  limit?: number;
  userId?: string | null;
}): CoinCommunityListResponse {
  const symbol = normalizeCoinSymbol(params.symbol);
  const limit = parseLimit(params.limit);
  const allItems = [...(postsBySymbol.get(symbol) ?? [])];
  const sorted = allItems.sort((left, right) => {
    if (params.sort === 'popular') {
      return (right.likeCount + right.commentCount) - (left.likeCount + left.commentCount)
        || Date.parse(right.createdAt) - Date.parse(left.createdAt);
    }
    return Date.parse(right.createdAt) - Date.parse(left.createdAt);
  });
  const filtered = params.filter && params.filter !== 'all'
    ? sorted.filter((item) => item.tags.includes(params.filter as string) || item.badge === params.filter)
    : sorted;
  const offset = params.cursor
    ? Math.max(filtered.findIndex((item) => item.id === params.cursor) + 1, 0)
    : 0;
  const items = filtered.slice(offset, offset + limit);
  const next = filtered[offset + limit];

  const response = {
    symbol,
    vote: getPoll(symbol, params.userId),
    items: items.map(({ authorId: _authorId, ...item }) => ({
      ...item,
      myReaction: null,
      isFollowing: false,
    })),
    nextCursor: next?.id ?? null,
  };
  logger.info(
    {
      domain: 'coin-community',
      symbol: response.symbol,
      participantCount: response.vote.participantCount,
      itemCount: response.items.length,
    },
    `[Community] symbol=${response.symbol} participantCount=${response.vote.participantCount} itemCount=${response.items.length}`,
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
  const item: StoredCommunityItem = {
    id: randomUUID(),
    authorId: params.userId,
    authorName: params.authorName?.trim() || 'Cryptory User',
    avatarUrl: null,
    createdAt,
    content: params.content,
    symbol,
    tags: ['activity'],
    likeCount: 0,
    commentCount: 0,
    isFollowing: false,
    badge: 'activity',
    myReaction: null,
  };

  const posts = postsBySymbol.get(symbol) ?? [];
  posts.unshift(item);
  postsBySymbol.set(symbol, posts.slice(0, 500));

  return {
    id: item.id,
    createdAt,
  };
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

export function getMarketPoll(userId?: string | null) {
  return getPoll('MARKET', userId);
}
