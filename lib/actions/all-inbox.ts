"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * One DM inbox across every client.
 *
 * The per-workspace Inbox is fine when you run one brand. An agency running a
 * dozen has to open a dozen workspaces to find out whether anyone is waiting,
 * which is how a lead sits unanswered for two days. This reads conversations
 * straight from Postgres for every workspace the caller belongs to - no Zernio
 * call, so it costs nothing against the rate limit and loads instantly.
 */

export interface InboxThread {
  id: string;
  workspaceId: string;
  workspaceName: string;
  platform: string;
  accountUsername: string | null;
  contactName: string;
  contactAvatar: string | null;
  preview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  status: string;
  assignedTo: string | null;
}

export interface UnifiedInbox {
  threads: InboxThread[];
  workspaces: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; username: string; platform: string }>;
}

const INBOX_LIMIT = 300;

export async function getUnifiedInbox(): Promise<UnifiedInbox> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { threads: [], workspaces: [], accounts: [] };

  const { data: memberships } = await supabase
    .from("workspace_members")
    .select("workspaces(id, name)")
    .eq("user_id", user.id);

  const workspaces = ((memberships ?? []) as unknown as Array<{
    workspaces: { id: string; name: string } | null;
  }>)
    .map((m) => m.workspaces)
    .filter((w): w is { id: string; name: string } => Boolean(w));

  if (workspaces.length === 0) return { threads: [], workspaces: [], accounts: [] };

  const names = new Map(workspaces.map((w) => [w.id, w.name]));

  const { data: rows } = await supabase
    .from("conversations")
    .select(
      "id, workspace_id, platform, status, unread_count, last_message_preview, last_message_at, assigned_to, contacts(display_name, avatar_url), channels(late_account_id, username)",
    )
    .in(
      "workspace_id",
      workspaces.map((w) => w.id),
    )
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(INBOX_LIMIT);

  const accounts = new Map<string, { id: string; username: string; platform: string }>();

  const threads: InboxThread[] = ((rows ?? []) as unknown as Array<{
    id: string;
    workspace_id: string;
    platform: string;
    status: string;
    unread_count: number;
    last_message_preview: string | null;
    last_message_at: string | null;
    assigned_to: string | null;
    contacts: { display_name: string | null; avatar_url: string | null } | null;
    channels: { late_account_id: string; username: string | null } | null;
  }>).map((r) => {
    if (r.channels?.late_account_id) {
      accounts.set(r.channels.late_account_id, {
        id: r.channels.late_account_id,
        username: r.channels.username ?? r.channels.late_account_id,
        platform: r.platform,
      });
    }
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      workspaceName: names.get(r.workspace_id) ?? "",
      platform: r.platform,
      accountUsername: r.channels?.username ?? null,
      contactName: r.contacts?.display_name ?? "Unknown",
      contactAvatar: r.contacts?.avatar_url ?? null,
      preview: r.last_message_preview,
      lastMessageAt: r.last_message_at,
      unreadCount: r.unread_count ?? 0,
      status: r.status,
      assignedTo: r.assigned_to,
    };
  });

  return {
    threads,
    workspaces,
    accounts: [...accounts.values()].sort((a, b) => a.username.localeCompare(b.username)),
  };
}
