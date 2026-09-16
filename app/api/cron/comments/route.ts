import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getPostComments, listCommentPosts } from "@/lib/zernio-comments";

/**
 * GET /api/cron/comments?key=CRON_SECRET
 *
 * Pulls comments from Zernio into comment_logs.
 *
 * The comment.received webhook is the fast path, but it only fires forward and
 * a failed delivery is never retried into the database: a comment that arrives
 * while the app is redeploying, or before its channel finished connecting, is
 * lost for good. This sweep is what makes the board eventually correct, and it
 * is also what backfills comments that predate the channel.
 *
 * Run it every 10-15 minutes. Zernio serves this from a cache that does not
 * move for minutes at a time and rate-limits to 60 requests/minute across all
 * of an account's keys, so anything tighter spends quota re-reading the same
 * bytes.
 */

/** Posts inspected per account per sweep, newest first. */
const POSTS_PER_ACCOUNT = 25;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const key = request.nextUrl.searchParams.get("key");
  if (!cronSecret || key !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createServiceClient();

  const { data: workspaces } = await supabase
    .from("workspaces")
    .select("id, name, late_api_key_encrypted")
    .not("late_api_key_encrypted", "is", null);

  const { data: channels } = await supabase
    .from("channels")
    .select("id, workspace_id, late_account_id, username, platform");

  let scanned = 0;
  let upserted = 0;
  const errors: string[] = [];

  for (const ws of (workspaces ?? []) as Array<{
    id: string;
    name: string;
    late_api_key_encrypted: string;
  }>) {
    const mine = (channels ?? []).filter(
      (c) => (c as { workspace_id: string }).workspace_id === ws.id,
    ) as Array<{
      id: string;
      late_account_id: string;
      username: string | null;
      platform: string;
    }>;

    for (const channel of mine) {
      // Two passes per account. Zernio's platform filter is exclusive:
      // "instagram"/"facebook" return ORGANIC posts only, and the synthetic
      // "metaads" value returns the account's ads and dark posts only. Asking
      // for both is the only way to see everything, and which pass a comment
      // came from is what tells organic apart from ads. Meta ad posts are read
      // and answered through the same inbox endpoints as organic ones; the
      // /v1/ads/* family is TikTok-oriented.
      const passes: Array<{ platform: string; source: "organic" | "ad" }> = [
        { platform: channel.platform, source: "organic" },
        { platform: "metaads", source: "ad" },
      ];

      for (const pass of passes) {
      try {
        const { posts } = await listCommentPosts(ws.late_api_key_encrypted, {
          accountId: channel.late_account_id,
          platform: pass.platform,
          limit: POSTS_PER_ACCOUNT,
        });

        for (const post of posts.filter((p) => p.commentCount > 0)) {
          const comments = await getPostComments(
            ws.late_api_key_encrypted,
            post.id,
            channel.late_account_id,
          );
          scanned += comments.length;

          const rows = comments
            .filter((c) => !c.from?.isOwner)
            .map((c) => ({
              channel_id: channel.id,
              workspace_id: ws.id,
              post_id: post.id,
              platform_comment_id: c.id,
              author_id: c.from?.id ?? null,
              author_name: c.from?.name ?? null,
              author_username: c.from?.username ?? null,
              comment_text: c.message,
              account_id: channel.late_account_id,
              account_username: channel.username,
              platform: post.platform,
              post_permalink: post.permalink,
              post_picture: post.picture,
              post_content: post.content,
              comment_created_at: c.createdTime,
              reply_count: c.replyCount ?? 0,
              is_hidden: c.isHidden ?? false,
              can_reply: c.canReply ?? true,
              can_hide: c.canHide ?? true,
              source: pass.source,
              synced_at: new Date().toISOString(),
            }));

          if (rows.length === 0) continue;

          // matched_trigger_id / dm_sent belong to the automation path and are
          // deliberately left out of the update so a sweep never clears what a
          // comment rule recorded.
          const { error } = await supabase
            .from("comment_logs")
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .upsert(rows as any, { onConflict: "channel_id,platform_comment_id" });

          if (error) errors.push(`${ws.name}/@${channel.username}: ${error.message}`);
          else upserted += rows.length;
        }
      } catch (e) {
        errors.push(
          `${ws.name}/@${channel.username} (${pass.source}): ${
            e instanceof Error ? e.message : "sweep failed"
          }`,
        );
      }
      }
    }
  }

  return NextResponse.json({ scanned, upserted, errors });
}
