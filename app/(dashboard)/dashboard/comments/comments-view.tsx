"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { EyeOff, Eye, ExternalLink, MessageSquare, RefreshCw, Send } from "lucide-react";
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
  lastSyncedAt: string | null;
}

type ReplyMode = "public" | "private";

function timeAgo(iso: string | null) {
  if (!iso) return "";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The board reads Postgres now, so refreshing is cheap; this is just a floor
 *  under the live subscription in case the socket drops. */
const POLL_MS = 60_000;
/** Comments arrive in bursts; re-read once the burst settles. */
const PUSH_DEBOUNCE_MS = 2_000;

export function CommentsView({ items, workspaces, accounts, lastSyncedAt }: Props) {
  const router = useRouter();
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [onlyUnanswered, setOnlyUnanswered] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<"all" | "organic" | "ad">("all");
  const [refreshing, startRefresh] = useTransition();
  const [live, setLive] = useState(false);
  const [pushed, setPushed] = useState(0);

  const refresh = useCallback(() => {
    setPushed(0);
    startRefresh(() => router.refresh());
  }, [router]);

  // Zernio's comment.received webhook writes comment_logs, which is in the
  // supabase_realtime publication, so a new comment reaches the browser as it
  // lands rather than on the next sweep.
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
        if (sourceFilter !== "all" && item.source !== sourceFilter) return false;
        if (onlyUnanswered && item.replyCount > 0) return false;
        return true;
      }),
    [items, workspaceFilter, accountFilter, onlyUnanswered, sourceFilter],
  );

  const unanswered = items.filter((item) => item.replyCount === 0).length;
  // What an agency actually gets judged on: how long the oldest unanswered
  // comment has been sitting there.
  const oldest = items
    .filter((i) => i.replyCount === 0 && i.createdAt)
    .reduce<string | null>(
      (acc, i) => (!acc || (i.createdAt as string) < acc ? (i.createdAt as string) : acc),
      null,
    );

  return (
    // The dashboard layout is overflow-hidden, so every screen brings its own
    // scroll container: fixed header, scrollable list.
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border p-6 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Comments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every comment across all your clients&apos; accounts, newest first.
            {oldest && (
              <>
                {" "}
                Oldest unanswered: <strong>{timeAgo(oldest)}</strong>.
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            title={
              live
                ? "New comments appear as they arrive"
                : "Live updates unavailable - refreshing every minute instead"
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

        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as "all" | "organic" | "ad")}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="all">Organic + ads ({items.length})</option>
          <option value="organic">Organic only ({items.filter((i) => i.source === "organic").length})</option>
          <option value="ad">Ads only ({items.filter((i) => i.source === "ad").length})</option>
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
          {lastSyncedAt && ` · synced ${timeAgo(lastSyncedAt)} ago`}
        </span>
      </div>

      </div>

      <div className="flex-1 overflow-auto p-6">
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
            <CommentCard key={item.id} item={item} />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

function CommentCard({ item }: { item: CommentItem }) {
  const router = useRouter();
  const [mode, setMode] = useState<ReplyMode | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const canDm = item.platform === "instagram" || item.platform === "facebook";

  function submit() {
    setError(null);
    if (!item.accountId) {
      setError("This comment has no account yet - wait for the next sync");
      return;
    }
    const action = mode === "private" ? privateReplyAction : replyToCommentAction;
    const accountId = item.accountId;

    startTransition(async () => {
      const result = await action({
        rowId: item.id,
        workspaceId: item.workspaceId,
        postId: item.postId,
        commentId: item.commentId,
        accountId,
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
    if (!item.accountId) return;
    const accountId = item.accountId;
    startTransition(async () => {
      const result = await toggleHiddenAction({
        rowId: item.id,
        workspaceId: item.workspaceId,
        postId: item.postId,
        commentId: item.commentId,
        accountId,
        hidden: !item.isHidden,
      });
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-start gap-3">
        {item.postPicture ? (
          <Image
            src={item.postPicture}
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
            <PlatformIcon platform={item.platform} className="h-3.5 w-3.5" />
            {item.accountUsername && (
              <span className="font-medium text-foreground">@{item.accountUsername}</span>
            )}
            <span>·</span>
            <span>{item.workspaceName}</span>
            {item.createdAt && (
              <>
                <span>·</span>
                <span>{timeAgo(item.createdAt)}</span>
              </>
            )}
            {item.source === "ad" && (
              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700">
                Ad
              </span>
            )}
            {item.isHidden && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
                Hidden
              </span>
            )}
            {item.replyCount > 0 && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
                Answered
              </span>
            )}
          </div>

          <p className="mt-2 text-sm font-medium text-foreground">
            {item.authorName || item.authorUsername || "Unknown"}
            {item.authorUsername && (
              <span className="ml-1 font-normal text-muted-foreground">
                @{item.authorUsername}
              </span>
            )}
          </p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">{item.text}</p>

          {item.postContent && (
            <p className="mt-2 line-clamp-1 text-xs text-muted-foreground/70">
              on: {item.postContent}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.canReply && (
              <button
                onClick={() => setMode(mode === "public" ? null : "public")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Reply
              </button>
            )}
            {canDm && (
              <button
                onClick={() => setMode(mode === "private" ? null : "private")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <Send className="h-3.5 w-3.5" />
                Send DM
              </button>
            )}
            {item.canHide && (
              <button
                onClick={toggleHidden}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
              >
                {item.isHidden ? (
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
            {item.postPermalink && (
              <a
                href={item.postPermalink}
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
        </div>
      </div>
    </div>
  );
}
