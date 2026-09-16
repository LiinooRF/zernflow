"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  AlertTriangle,
  EyeOff,
  Eye,
  ExternalLink,
  MessageSquare,
  RefreshCw,
  Send,
} from "lucide-react";
import { PlatformIcon } from "@/components/platform-icon";
import {
  privateReplyAction,
  replyToCommentAction,
  toggleHiddenAction,
  type CommentItem,
} from "@/lib/actions/comments";

interface Props {
  items: CommentItem[];
  workspaces: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; username: string; platform: string }>;
  errors: string[];
}

type ReplyMode = "public" | "private";

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Zernio serves this data from a cache and rate-limits to 60 requests/minute
 * per key, and one board refresh costs one request per workspace plus one per
 * post that has comments. Polling every few seconds would burn the budget on
 * identical bytes, so the fast path is the push below and this is only the
 * safety net for anything the webhook misses.
 */
const POLL_MS = 60_000;
/** New comments usually arrive in bursts; refetch once when the burst settles. */
const PUSH_DEBOUNCE_MS = 3_000;

export function CommentsView({ items, workspaces, accounts, errors }: Props) {
  const router = useRouter();
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [onlyUnanswered, setOnlyUnanswered] = useState(true);
  const [refreshing, startRefresh] = useTransition();
  const [live, setLive] = useState(false);
  const [pushed, setPushed] = useState(0);

  const refresh = useCallback(() => {
    setPushed(0);
    startRefresh(() => router.refresh());
  }, [router]);

  // Push: Zernio's comment.received webhook writes into comment_logs, which is
  // in the supabase_realtime publication, so a new comment reaches the browser
  // as it lands instead of on the next poll.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("comments-board")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "comment_logs" },
        () => {
          setPushed((n) => n + 1);
          if (debounce.current) clearTimeout(debounce.current);
          debounce.current = setTimeout(() => router.refresh(), PUSH_DEBOUNCE_MS);
        },
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      if (debounce.current) clearTimeout(debounce.current);
      supabase.removeChannel(channel);
    };
  }, [router]);

  // Safety net. Paused while the tab is hidden so a forgotten tab does not eat
  // the rate limit all afternoon.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [router]);

  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (workspaceFilter !== "all" && item.workspaceId !== workspaceFilter) return false;
        if (accountFilter !== "all" && item.accountId !== accountFilter) return false;
        if (onlyUnanswered && item.comment.replyCount > 0) return false;
        return true;
      }),
    [items, workspaceFilter, accountFilter, onlyUnanswered],
  );

  const unanswered = items.filter((item) => item.comment.replyCount === 0).length;

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Comments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every comment across all your clients&apos; accounts, newest first.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            title={
              live
                ? "New comments arrive as Zernio pushes them"
                : "Live updates unavailable - falling back to a refresh every minute"
            }
          >
            <span
              className={`h-2 w-2 rounded-full ${live ? "bg-green-500" : "bg-muted-foreground/40"}`}
            />
            {live ? "Live" : "Polling"}
          </span>

          {pushed > 0 && (
            <button
              onClick={refresh}
              className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-700"
            >
              {pushed} new — show
            </button>
          )}

          <button
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {workspaces.length > 1 && (
          <select
            value={workspaceFilter}
            onChange={(e) => setWorkspaceFilter(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="all">All clients ({workspaces.length})</option>
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
        )}

        <select
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="all">All accounts ({accounts.length})</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              @{account.username} · {account.platform}
            </option>
          ))}
        </select>

        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyUnanswered}
            onChange={(e) => setOnlyUnanswered(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          Unanswered only ({unanswered})
        </label>

        <span className="ml-auto text-sm text-muted-foreground">
          {visible.length} shown
        </span>
      </div>

      {errors.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            Some accounts could not be read
          </p>
          <ul className="mt-2 list-inside list-disc space-y-1">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-border p-10 text-center">
          <MessageSquare className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">No comments to show</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {onlyUnanswered && items.length > 0
              ? "Everything here has been answered. Untick the filter to see them."
              : "Connect a channel and comments on your posts will land here."}
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {visible.map((item) => (
            <CommentCard key={`${item.post.id}-${item.comment.id}`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommentCard({ item }: { item: CommentItem }) {
  const router = useRouter();
  const { comment, post } = item;
  const [mode, setMode] = useState<ReplyMode | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    const action = mode === "private" ? privateReplyAction : replyToCommentAction;

    startTransition(async () => {
      const result = await action({
        workspaceId: item.workspaceId,
        postId: post.id,
        commentId: comment.id,
        accountId: item.accountId,
        message,
      });

      if (result.error) {
        setError(result.error);
        return;
      }

      setDone(mode === "private" ? "DM sent" : "Reply posted");
      setMessage("");
      setMode(null);
      router.refresh();
    });
  }

  function toggleHidden() {
    setError(null);
    startTransition(async () => {
      const result = await toggleHiddenAction({
        workspaceId: item.workspaceId,
        postId: post.id,
        commentId: comment.id,
        accountId: item.accountId,
        hidden: !comment.isHidden,
      });
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-start gap-3">
        {post.picture ? (
          <Image
            src={post.picture}
            alt=""
            width={48}
            height={48}
            unoptimized
            className="h-12 w-12 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="h-12 w-12 shrink-0 rounded-lg bg-muted" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <PlatformIcon platform={post.platform} className="h-3.5 w-3.5" />
            <span className="font-medium text-foreground">@{item.accountUsername}</span>
            <span>·</span>
            <span>{item.workspaceName}</span>
            <span>·</span>
            <span>{timeAgo(comment.createdTime)}</span>
            {comment.isHidden && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
                Hidden
              </span>
            )}
            {comment.replyCount > 0 && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
                Answered
              </span>
            )}
          </div>

          <p className="mt-2 text-sm font-medium text-foreground">
            {comment.from?.name || comment.from?.username || "Unknown"}
            {comment.from?.username && (
              <span className="ml-1 font-normal text-muted-foreground">
                @{comment.from.username}
              </span>
            )}
          </p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">{comment.message}</p>

          <p className="mt-2 line-clamp-1 text-xs text-muted-foreground/70">
            on: {post.content || "(no caption)"}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {comment.canReply && (
              <button
                onClick={() => setMode(mode === "public" ? null : "public")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Reply
              </button>
            )}
            {(post.platform === "instagram" || post.platform === "facebook") && (
              <button
                onClick={() => setMode(mode === "private" ? null : "private")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <Send className="h-3.5 w-3.5" />
                Send DM
              </button>
            )}
            {comment.canHide && (
              <button
                onClick={toggleHidden}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
              >
                {comment.isHidden ? (
                  <>
                    <Eye className="h-3.5 w-3.5" /> Unhide
                  </>
                ) : (
                  <>
                    <EyeOff className="h-3.5 w-3.5" /> Hide
                  </>
                )}
              </button>
            )}
            {(comment.url || post.permalink) && (
              <a
                href={comment.url || post.permalink || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </a>
            )}
            {done && <span className="text-xs font-medium text-green-700">{done}</span>}
          </div>

          {mode && (
            <div className="mt-3">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={2}
                autoFocus
                placeholder={
                  mode === "private"
                    ? "Private DM to this commenter..."
                    : "Public reply to this comment..."
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
              {mode === "private" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Meta allows one private reply per comment, and only within 7 days of it.
                </p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={submit}
                  disabled={pending || !message.trim()}
                  className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
                >
                  {pending ? "Sending..." : mode === "private" ? "Send DM" : "Reply"}
                </button>
                <button
                  onClick={() => {
                    setMode(null);
                    setMessage("");
                  }}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

          {comment.replies?.length > 0 && (
            <div className="mt-3 space-y-2 border-l-2 border-border pl-3">
              {comment.replies.map((reply) => (
                <div key={reply.id} className="text-xs">
                  <span className="font-medium text-foreground">
                    {reply.from?.username || reply.from?.name || "Unknown"}
                  </span>
                  <span className="ml-2 text-muted-foreground">{reply.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
