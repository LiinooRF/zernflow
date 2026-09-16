"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Inbox, RefreshCw, Send } from "lucide-react";
import { PlatformIcon } from "@/components/platform-icon";
import type { InboxThread } from "@/lib/actions/all-inbox";

interface Props {
  threads: InboxThread[];
  workspaces: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; username: string; platform: string }>;
}

/** Reads Postgres only, so ten seconds is cheap and keeps it visibly live. */
const POLL_MS = 10_000;
const PUSH_DEBOUNCE_MS = 1_500;

function timeAgo(iso: string | null) {
  if (!iso) return "";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function AllInboxView({ threads, workspaces, accounts }: Props) {
  const router = useRouter();
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [live, setLive] = useState(false);

  const refresh = useCallback(() => startRefresh(() => router.refresh()), [router]);

  // conversations is in the supabase_realtime publication, so a new DM moves
  // the thread to the top without anyone reloading.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("all-inbox")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => {
        if (debounce.current) clearTimeout(debounce.current);
        debounce.current = setTimeout(() => router.refresh(), PUSH_DEBOUNCE_MS);
      })
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
      threads.filter((t) => {
        if (workspaceFilter !== "all" && t.workspaceId !== workspaceFilter) return false;
        if (accountFilter !== "all" && t.channelId !== accountFilter) return false;
        if (onlyUnread && t.unreadCount === 0) return false;
        return true;
      }),
    [threads, workspaceFilter, accountFilter, onlyUnread],
  );

  const unread = threads.filter((t) => t.unreadCount > 0).length;
  const waiting = threads
    .filter((t) => t.unreadCount > 0 && t.lastMessageAt)
    .reduce<string | null>(
      (acc, t) => (!acc || (t.lastMessageAt as string) < acc ? (t.lastMessageAt as string) : acc),
      null,
    );

  return (
    // The dashboard layout is overflow-hidden, so every screen brings its own
    // scroll container: fixed header, scrollable list.
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border p-6 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">All inbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Direct messages from every client account in one place.
            {waiting && (
              <>
                {" "}
                Longest wait: <strong>{timeAgo(waiting)}</strong>.
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={`h-2 w-2 rounded-full ${live ? "bg-green-500" : "bg-muted-foreground/40"}`}
            />
            {live ? "Live" : "Polling"}
          </span>
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
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.username} · {a.platform}
            </option>
          ))}
        </select>

        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyUnread}
            onChange={(e) => setOnlyUnread(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          Unread only ({unread})
        </label>

        <span className="ml-auto text-sm text-muted-foreground">{visible.length} shown</span>
      </div>

      </div>

      <div className="flex-1 overflow-auto p-6">
      {visible.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-border p-10 text-center">
          <Inbox className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">Nothing here</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {onlyUnread && threads.length > 0
              ? "No unread conversations. Untick the filter to see them all."
              : "Conversations appear as people message your clients' accounts."}
          </p>
        </div>
      ) : (
        <div className="mt-4 divide-y divide-border rounded-xl border border-border">
          {visible.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

interface ThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  text: string | null;
  created_at: string;
}

function ThreadRow({ thread }: { thread: InboxThread }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<ThreadMessage[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Replying to a preview line is replying blind: you cannot see what was
  // asked, or what was already answered. Opening a row pulls the thread.
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || history || loadingHistory) return;
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/v1/messages?conversationId=${thread.id}`);
      const data = await res.json();
      setHistory(Array.isArray(data) ? data : []);
      if (!Array.isArray(data) && data?.error) setError(data.error);
    } catch {
      setError("Could not load the conversation");
    } finally {
      setLoadingHistory(false);
    }
  }

  async function send() {
    if (!message.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      // Reuses the existing endpoint, which resolves the workspace and its key
      // from the conversation itself, so it works for any client.
      const res = await fetch("/api/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: thread.id, text: message.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `Send failed (${res.status})`);
        return;
      }
      setSent(true);
      setMessage("");
      setHistory(null);
      // Pull the thread again so the reply you just sent is visible.
      const again = await fetch(`/api/v1/messages?conversationId=${thread.id}`);
      const fresh = await again.json();
      setHistory(Array.isArray(fresh) ? fresh : []);
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        {thread.contactAvatar ? (
          <Image
            src={thread.contactAvatar}
            alt=""
            width={40}
            height={40}
            unoptimized
            className="h-10 w-10 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
            {thread.contactName.slice(0, 2).toUpperCase()}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <PlatformIcon platform={thread.platform} className="h-3.5 w-3.5" />
            <span className="font-medium text-foreground">{thread.contactName}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-foreground">
              {thread.workspaceName}
              {thread.accountUsername ? ` · @${thread.accountUsername}` : ""}
            </span>
            <span>·</span>
            <span>{timeAgo(thread.lastMessageAt)}</span>
            {thread.unreadCount > 0 && (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                {thread.unreadCount} unread
              </span>
            )}
            {thread.status !== "open" && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
                {thread.status}
              </span>
            )}
          </div>

          <p className="mt-1 line-clamp-2 text-sm text-foreground">
            {thread.preview || <span className="text-muted-foreground">(no preview)</span>}
          </p>

          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={toggle}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <Send className="h-3.5 w-3.5" />
              {open ? "Close" : "Open & reply"}
            </button>
            {sent && <span className="text-xs font-medium text-green-700">Sent</span>}
          </div>

          {open && (
            <div className="mt-3">
              {loadingHistory && (
                <p className="text-xs text-muted-foreground">Loading conversation...</p>
              )}
              {history && history.length > 0 && (
                <div className="mb-3 max-h-64 space-y-2 overflow-auto rounded-lg border border-border bg-muted/30 p-3">
                  {history.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                        m.direction === "outbound"
                          ? "ml-auto bg-foreground text-background"
                          : "bg-background border border-border"
                      }`}
                    >
                      {m.text || <span className="opacity-60">(attachment)</span>}
                      <div className="mt-1 text-[10px] opacity-60">{timeAgo(m.created_at)}</div>
                    </div>
                  ))}
                </div>
              )}
              {history && history.length === 0 && !loadingHistory && (
                <p className="mb-2 text-xs text-muted-foreground">
                  No messages returned for this conversation.
                </p>
              )}
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={2}
                autoFocus
                placeholder={`Reply to ${thread.contactName}...`}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Meta only accepts free-form messages within 24 hours of the contact&apos;s last
                message.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={send}
                  disabled={sending || !message.trim()}
                  className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
                >
                  {sending ? "Sending..." : "Send"}
                </button>
                <button
                  onClick={() => {
                    setOpen(false);
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
