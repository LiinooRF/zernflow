/**
 * Thin wrapper over Zernio's inbox comment endpoints.
 *
 * These are not exposed as methods on the @zernio/node client, so they are
 * called directly. Every call is scoped by the workspace's own API key, which
 * is what keeps one client's comments out of another client's view.
 */

const ZERNIO_API = process.env.ZERNIO_API_URL ?? "https://zernio.com/api";

export interface CommentPost {
  id: string;
  accountId: string;
  accountUsername: string;
  platform: string;
  content: string;
  createdTime: string;
  permalink: string | null;
  picture: string | null;
  commentCount: number;
  likeCount: number;
}

export interface CommentAuthor {
  id: string;
  name: string | null;
  username: string | null;
  isOwner: boolean;
}

export interface Comment {
  id: string;
  message: string;
  createdTime: string;
  from: CommentAuthor;
  platform: string;
  url: string | null;
  likeCount: number;
  replyCount: number;
  replies: Comment[];
  isHidden: boolean;
  isLiked: boolean;
  isPinned: boolean;
  canReply: boolean;
  canHide: boolean;
  canLike: boolean;
  canPin: boolean;
  canDelete: boolean;
}

async function zernio<T>(
  apiKey: string,
  path: string,
  init?: RequestInit & { query?: Record<string, string | number | undefined> },
): Promise<T> {
  const url = new URL(`${ZERNIO_API}${path}`);
  for (const [key, value] of Object.entries(init?.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zernio ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Posts that have comments, newest first. Omitting accountId returns every
 * account under the key, which is the whole point for an agency.
 */
export async function listCommentPosts(
  apiKey: string,
  opts: { accountId?: string; platform?: string; limit?: number; cursor?: string } = {},
): Promise<{ posts: CommentPost[]; nextCursor: string | null; accountsFailed: number }> {
  const data = await zernio<{
    data: CommentPost[];
    pagination?: { hasMore: boolean; nextCursor: string | null };
    meta?: { accountsFailed?: number };
  }>(apiKey, "/v1/inbox/comments", {
    query: {
      accountId: opts.accountId,
      platform: opts.platform,
      limit: opts.limit ?? 25,
      cursor: opts.cursor,
    },
  });

  return {
    posts: data.data ?? [],
    nextCursor: data.pagination?.hasMore ? (data.pagination.nextCursor ?? null) : null,
    accountsFailed: data.meta?.accountsFailed ?? 0,
  };
}

export async function getPostComments(
  apiKey: string,
  postId: string,
  accountId: string,
  limit = 25,
): Promise<Comment[]> {
  const data = await zernio<{ comments: Comment[] }>(
    apiKey,
    `/v1/inbox/comments/${encodeURIComponent(postId)}`,
    { query: { accountId, limit } },
  );
  return data.comments ?? [];
}

/** Public reply. Omitting commentId comments on the post itself. */
export async function replyToComment(
  apiKey: string,
  postId: string,
  body: { accountId: string; message: string; commentId?: string },
) {
  return zernio(apiKey, `/v1/inbox/comments/${encodeURIComponent(postId)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * DM the commenter instead of replying in public. Instagram and Facebook only,
 * and Meta only allows it once per comment.
 */
export async function privateReplyToComment(
  apiKey: string,
  postId: string,
  commentId: string,
  body: { accountId: string; message: string },
) {
  return zernio(
    apiKey,
    `/v1/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/private-reply`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** Same path for both: POST hides, DELETE unhides. */
export async function setCommentHidden(
  apiKey: string,
  postId: string,
  commentId: string,
  accountId: string,
  hidden: boolean,
) {
  return zernio(
    apiKey,
    `/v1/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/hide`,
    {
      method: hidden ? "POST" : "DELETE",
      body: JSON.stringify({ accountId }),
    },
  );
}
