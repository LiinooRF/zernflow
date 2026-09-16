"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createZernioClient } from "@/lib/zernio-client";
import {
  ensureWebhookRegistered,
  getOrCreateWorkspaceWebhookSecret,
} from "@/lib/zernio-webhook";

/**
 * Registers this deployment's /api/webhooks/late endpoint with Zernio for one
 * workspace.
 *
 * POST /api/v1/channels/test-key already does this, but only when the key is
 * saved through "Test connection". Saving it with the Save button writes
 * straight to the workspaces row from the browser and never registers
 * anything, so that workspace receives no inbound events at all: no live DMs,
 * no comment.received, and an empty comment_logs however many comments the
 * account gets. This closes that path.
 */
export async function syncWebhookAction(workspaceId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .single();
  if (!membership) return { error: "No access to this workspace" };

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("late_api_key_encrypted")
    .eq("id", workspaceId)
    .single();

  const apiKey = (workspace as { late_api_key_encrypted?: string | null } | null)
    ?.late_api_key_encrypted;
  if (!apiKey) return { error: "Add your Zernio API key first" };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return { error: "NEXT_PUBLIC_APP_URL is not set on this deployment" };

  try {
    // The secret column is not writable by members under RLS, so mint it with
    // the service client; the membership check above is what authorizes this.
    const secret = await getOrCreateWorkspaceWebhookSecret(await createServiceClient(), workspaceId);
    const zernio = createZernioClient(apiKey);

    const result = await ensureWebhookRegistered(zernio, {
      appUrl,
      secret,
      events: ["message.received", "comment.received"],
    });

    return { ok: true, action: result.action };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : "Could not register the webhook with Zernio",
    };
  }
}
