import { describe, expect, it } from 'vitest';
import {
  communityCommentExists,
  communityPostExists,
  createCoinCommunityPost,
  createCommunityComment,
  deleteCommunityDataForDeletedUser,
  likeCommunityItem,
  listCoinCommunity,
  listCommunityComments,
  voteCoinDirection,
} from '../src/domains/coins/coin-community.service';

describe('community account deletion', () => {
  it('removes the deleted user posts and comments instead of retaining their text', () => {
    const symbol = 'ACCOUNTDELETECONTRACT';
    const deletedUserId = 'deleted-user-community-contract';
    const survivorUserId = 'survivor-user-community-contract';
    const deletedPost = createCoinCommunityPost({
      symbol,
      userId: deletedUserId,
      authorName: 'deleted@example.com',
      content: 'deleted user post must disappear',
    }).item;
    const survivorPost = createCoinCommunityPost({
      symbol,
      userId: survivorUserId,
      authorName: 'survivor@example.com',
      content: 'survivor post remains',
    }).item;
    const survivorCommentOnDeletedPost = createCommunityComment({
      symbol,
      itemId: deletedPost.id,
      userId: survivorUserId,
      content: 'comment attached to deleted post',
    })?.comment;
    const deletedUserComment = createCommunityComment({
      symbol,
      itemId: survivorPost.id,
      userId: deletedUserId,
      content: 'deleted user comment must disappear',
    })?.comment;
    likeCommunityItem({ symbol, itemId: survivorPost.id, userId: deletedUserId });
    voteCoinDirection({ symbol, userId: deletedUserId, vote: 'bullish' });

    const result = deleteCommunityDataForDeletedUser(deletedUserId);

    expect(result).toMatchObject({
      postsDeleted: 1,
      commentsDeleted: 2,
      likesRemoved: 1,
    });
    expect(communityPostExists(deletedPost.id)).toBe(false);
    expect(communityCommentExists(survivorCommentOnDeletedPost?.id ?? '')).toBe(false);
    expect(communityCommentExists(deletedUserComment?.id ?? '')).toBe(false);

    const remaining = listCoinCommunity({ symbol, userId: survivorUserId });
    expect(remaining.items.map((item) => item.content)).toEqual(['survivor post remains']);
    expect(remaining.vote.participantCount).toBe(0);
    expect(remaining.items[0]).toMatchObject({ likeCount: 0, commentCount: 0, replyCount: 0 });
    expect(listCommunityComments({ symbol, itemId: survivorPost.id, userId: survivorUserId })?.items).toEqual([]);
    expect(JSON.stringify(remaining)).not.toContain('deleted user');
  });
});
