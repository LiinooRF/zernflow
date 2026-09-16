"use server";

import { createClient } from "@/lib/supabase/server";
import {
  getPostComments,
  listCommentPosts,
  privateReplyToComment,
  replyToComment,
  setCommentHidden,
  type Comment,
  type CommentPost,
} from "@/lib/zernio-comments";

/** Posts scanned per workspace on one load. Comments are only fetched for the
 *  ones that actually have any, so this is the cap on breadth, not on depth. */
const POSTS_PER_WORKSPACE = 25;
/** Posts fetched concurrently. Keeps a client with many posts from stalling
 *  the whole board while staying well under Zernio's rate limits. */
const CONCURRENCY = 5;

export interface CommentItem {
  comment: Comment;
  post: Pick<CommentPost, "id" | "permalink" | "picture" | "content" | "platform">;
  accountId: string;
  accountUsername: string;
  workspaceId: string;
  workspaceName: string;
}

export interface CommentsBoard {
  items: CommentItem[];
  workspaces: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; username: string; platform: string }>;
  errors: string[];
}

interface WorkspaceWithKey {
  id: string;
  name: string;
  apiKey: string;
}

/** Every workspace the caller belongs to that has a Zernio key configured. */
async function callerWorkspaces(): Promise<WorkspaceWithKey[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  // RLS already scopes this to the caller; the explicit filter keeps the query
  // honest if the policies are ever loosened.
  const { data } = await supabase
    .from("workspace_members")
    .select("workspaces(id, name, late_api_key_encrypted)")
    .eq("user_id", user.id);

  const rows = (data ?? []) as unknown as Array<{
    workspaces: { id: string; name: string; late_api_key_encrypted: string | null } | null;
  }>;

  return rows
    .map((row) => row.workspaces)
    .filter((ws): ws is NonNullable<typeof ws> => Boolean(ws?.late_api_key_encrypted))
    .map((ws) => ({ id: ws.id, name: ws.name, apiKey: ws.late_api_key_encrypted! }));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return results;
}

/**
 * One board across every client the caller can see. A workspace that fails
 * (revoked key, Zernio hiccup) is reported in `errors` instead of taking the
 * whole page down with it — with many clients, one broken key is normal.
 */
export async function getCommentsBoard(): Promise<CommentsBoard> {
  const workspaces = await callerWorkspaces();
  const errors: string[] = [];
  const items: CommentItem[] = [];
  const accounts = new Map<string, { id: string; username: string; platform: string }>();

  await Promise.all(
    workspaces.map(async (ws) => {
      let posts: CommentPost[];
      try {
        const listed = await listCommentPosts(ws.apiKey, { limit: POSTS_PER_WORKSPACE });
        posts = listed.posts;
        if (listed.accountsFailed > 0) {
          errors.push(`${ws.name}: Zernio could not read ${listed.accountsFailed} account(s)`);
        }
      } catch (e) {
        errors.push(`${ws.name}: ${e instanceof Error ? e.message : "could not list posts"}`);
        return;
      }

      for (const post of posts) {
        accounts.set(post.accountId, {
          id: post.accountId,
          username: post.accountUsername,
          platform: post.platform,
        });
      }

      const withComments = posts.filter((post) => post.commentCount > 0);

      await mapWithConcurrency(withComments, CONCURRENCY, async (post) => {
        try {
          const comments = await getPostComments(ws.apiKey, post.id, post.accountId);
          for (const comment of comments) {
            // The account's own replies are context, not work to be done.
            if (comment.from?.isOwner) continue;
            items.push({
              comment,
              post: {
                id: post.id,
                permalink: post.permalink,
                picture: post.picture,
                content: post.content,
                platform: post.platform,
              },
              accountId: post.accountId,
              accountUsername: post.accountUsername,
              workspaceId: ws.id,
              workspaceName: ws.name,
            });
          }
        } catch (e) {
          errors.push(
            `${ws.name} / ${post.accountUsername}: ${
              e instanceof Error ? e.message : "could not read comments"
            }`,
          );
        }
      });
    }),
  );

  items.sort(
    (a, b) =>
      new Date(b.comment.createdTime).getTime() - new Date(a.comment.createdTime).getTime(),
  );

  return {
    items,
    workspaces: workspaces.map((ws) => ({ id: ws.id, name: ws.name })),
    accounts: [...accounts.values()].sort((a, b) => a.username.localeCompare(b.username)),
    errors,
  };
}

/** Re-checks membership before using a workspace's key: the workspace id comes
 *  from the client, so it cannot be trusted on its own. */
async function keyForWorkspace(workspaceId: string): Promise<string | null> {
  const workspaces = await callerWorkspaces();
  return workspaces.find((ws) => ws.id === workspaceId)?.apiKey ?? null;
}

export async function replyToCommentAction(input: {
  workspaceId: string;
  postId: string;
  commentId: string;
  accountId: string;
  message: string;
}) {
  const message = input.message.trim();
  if (!message) return { error: "Write something first" };

  const apiKey = await keyForWorkspace(input.workspaceId);
  if (!apiKey) return { error: "No access to this workspace" };

  try {
    await replyToComment(apiKey, input.postId, {
      accountId: input.accountId,
      message,
      commentId: input.commentId,
    });
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Reply failed" };
  }
}

export async function privateReplyAction(input: {
  workspaceId: string;
  postId: string;
  commentId: string;
  accountId: string;
  message: string;
}) {
  const message = input.message.trim();
  if (!message) return { error: "Write something first" };

  const apiKey = await keyForWorkspace(input.workspaceId);
  if (!apiKey) return { error: "No access to this workspace" };

  try {
    await privateReplyToComment(apiKey, input.postId, input.commentId, {
      accountId: input.accountId,
      message,
    });
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Private reply failed" };
  }
}

export async function toggleHiddenAction(input: {
  workspaceId: string;
  postId: string;
  commentId: string;
  accountId: string;
  hidden: boolean;
}) {
  const apiKey = await keyForWorkspace(input.workspaceId);
  if (!apiKey) return { error: "No access to this workspace" };

  try {
    await setCommentHidden(apiKey, input.postId, input.commentId, input.accountId, input.hidden);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not change visibility" };
  }
}
