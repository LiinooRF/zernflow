"use server";

import { createClient } from "@/lib/supabase/server";
import {
  privateReplyToComment,
  replyToComment,
  setCommentHidden,
} from "@/lib/zernio-comments";

/**
 * The board reads comment_logs, not Zernio.
 *
 * Zernio rate-limits to 60 requests/minute across an account's keys and serves
 * comments from a cache that does not move for minutes, so querying it per page
 * load put a hard ceiling on how many clients could have the board open at once
 * and made every load wait on the network. comment_logs is filled by the
 * comment.received webhook (instantly) and by /api/cron/comments (the sweep
 * that catches whatever the webhook missed).
 */

export interface CommentItem {
  id: string;
  commentId: string;
  text: string;
  createdAt: string | null;
  authorName: string | null;
  authorUsername: string | null;
  replyCount: number;
  isHidden: boolean;
  canReply: boolean;
  canHide: boolean;
  postId: string;
  postPermalink: string | null;
  postPicture: string | null;
  postContent: string | null;
  platform: string;
  /** "ad" when the comment came from an ad or dark post, not an organic one. */
  source: "organic" | "ad";
  accountId: string | null;
  accountUsername: string | null;
  workspaceId: string;
  workspaceName: string;
}

export interface CommentsBoard {
  items: CommentItem[];
  workspaces: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; username: string; platform: string }>;
  /** Oldest sync across the rows shown, so the UI can admit how fresh it is. */
  lastSyncedAt: string | null;
}

/** Rows loaded per board. Filtering happens client-side over this window. */
const BOARD_LIMIT = 300;

export async function getCommentsBoard(): Promise<CommentsBoard> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { items: [], workspaces: [], accounts: [], lastSyncedAt: null };

  const { data: memberships } = await supabase
    .from("workspace_members")
    .select("workspaces(id, name)")
    .eq("user_id", user.id);

  const workspaces = ((memberships ?? []) as unknown as Array<{
    workspaces: { id: string; name: string } | null;
  }>)
    .map((m) => m.workspaces)
    .filter((w): w is { id: string; name: string } => Boolean(w));

  if (workspaces.length === 0) {
    return { items: [], workspaces: [], accounts: [], lastSyncedAt: null };
  }

  const names = new Map(workspaces.map((w) => [w.id, w.name]));

  // RLS already limits this to the caller's workspaces; the explicit filter
  // keeps it correct if the policies are ever loosened.
  const { data: rows } = await supabase
    .from("comment_logs")
    .select("*")
    .in(
      "workspace_id",
      workspaces.map((w) => w.id),
    )
    .order("comment_created_at", { ascending: false, nullsFirst: false })
    .limit(BOARD_LIMIT);

  const items: CommentItem[] = ((rows ?? []) as unknown as Array<Record<string, unknown>>).map(
    (r) => ({
      id: String(r.id),
      commentId: String(r.platform_comment_id),
      text: String(r.comment_text ?? ""),
      createdAt: (r.comment_created_at as string) ?? (r.created_at as string) ?? null,
      authorName: (r.author_name as string) ?? null,
      authorUsername: (r.author_username as string) ?? null,
      replyCount: Number(r.reply_count ?? 0),
      isHidden: Boolean(r.is_hidden),
      canReply: r.can_reply === undefined ? true : Boolean(r.can_reply),
      canHide: r.can_hide === undefined ? true : Boolean(r.can_hide),
      postId: String(r.post_id ?? ""),
      postPermalink: (r.post_permalink as string) ?? null,
      postPicture: (r.post_picture as string) ?? null,
      postContent: (r.post_content as string) ?? null,
      platform: (r.platform as string) ?? "instagram",
      source: (r.source as string) === "ad" ? "ad" : "organic",
      accountId: (r.account_id as string) ?? null,
      accountUsername: (r.account_username as string) ?? null,
      workspaceId: String(r.workspace_id),
      workspaceName: names.get(String(r.workspace_id)) ?? "",
    }),
  );

  const accounts = new Map<string, { id: string; username: string; platform: string }>();
  for (const item of items) {
    if (item.accountId) {
      accounts.set(item.accountId, {
        id: item.accountId,
        username: item.accountUsername ?? item.accountId,
        platform: item.platform,
      });
    }
  }

  const syncs = ((rows ?? []) as unknown as Array<{ synced_at?: string | null }>)
    .map((r) => r.synced_at)
    .filter((s): s is string => Boolean(s))
    .sort();

  return {
    items,
    workspaces,
    accounts: [...accounts.values()].sort((a, b) => a.username.localeCompare(b.username)),
    lastSyncedAt: syncs.length ? syncs[syncs.length - 1] : null,
  };
}

/** Membership check plus the workspace's key, for the write paths. Never trust
 *  the workspace id that arrives from the client. */
async function workspaceKey(workspaceId: string): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id, workspaces(late_api_key_encrypted)")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .single();

  const ws = (membership as unknown as {
    workspaces?: { late_api_key_encrypted?: string | null };
  } | null)?.workspaces;

  return ws?.late_api_key_encrypted ?? null;
}

async function markRow(commentRowId: string, patch: Record<string, unknown>) {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase.from("comment_logs") as any).update(patch).eq("id", commentRowId);
}

export async function replyToCommentAction(input: {
  rowId: string;
  workspaceId: string;
  postId: string;
  commentId: string;
  accountId: string;
  message: string;
}) {
  const message = input.message.trim();
  if (!message) return { error: "Write something first" };

  const apiKey = await workspaceKey(input.workspaceId);
  if (!apiKey) return { error: "No access to this workspace" };

  try {
    await replyToComment(apiKey, input.postId, {
      accountId: input.accountId,
      message,
      commentId: input.commentId,
    });
    // Reflect it now; the next sweep replaces this with Zernio's own count.
    await markRow(input.rowId, { reply_count: 1, reply_sent: true });
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Reply failed" };
  }
}

export async function privateReplyAction(input: {
  rowId: string;
  workspaceId: string;
  postId: string;
  commentId: string;
  accountId: string;
  message: string;
}) {
  const message = input.message.trim();
  if (!message) return { error: "Write something first" };

  const apiKey = await workspaceKey(input.workspaceId);
  if (!apiKey) return { error: "No access to this workspace" };

  try {
    await privateReplyToComment(apiKey, input.postId, input.commentId, {
      accountId: input.accountId,
      message,
    });
    await markRow(input.rowId, { dm_sent: true });
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Private reply failed" };
  }
}

export async function toggleHiddenAction(input: {
  rowId: string;
  workspaceId: string;
  postId: string;
  commentId: string;
  accountId: string;
  hidden: boolean;
}) {
  const apiKey = await workspaceKey(input.workspaceId);
  if (!apiKey) return { error: "No access to this workspace" };

  try {
    await setCommentHidden(apiKey, input.postId, input.commentId, input.accountId, input.hidden);
    await markRow(input.rowId, { is_hidden: input.hidden });
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not change visibility" };
  }
}
