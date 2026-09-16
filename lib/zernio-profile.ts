/**
 * Maps a workspace to its own Zernio profile.
 *
 * A Zernio profile holds exactly ONE account per platform, and connecting a
 * different account of the same platform into an occupied slot replaces it and
 * deletes that slot's inbox, DM history and analytics. So connecting a second
 * Instagram account into the same profile does not add it - it silently
 * destroys the first one.
 *
 * Giving every workspace its own profile is what makes a second Instagram
 * account possible at all, and it is the natural fit for the one-client
 * -per-workspace layout an agency ends up with.
 */

import type { Zernio } from "./zernio-client";

interface ZernioProfile {
  _id?: string;
  name?: string;
  description?: string;
}

/** Ties a profile to a workspace independently of its display name, so that
 *  renaming the workspace does not orphan the profile. */
export function workspaceProfileTag(workspaceId: string): string {
  return `zernflow-workspace:${workspaceId}`;
}

export async function getOrCreateWorkspaceProfile(
  zernio: Zernio,
  workspace: { id: string; name: string },
): Promise<string> {
  const tag = workspaceProfileTag(workspace.id);

  const res = await zernio.profiles.listProfiles();
  const profiles = (res?.data?.profiles ?? []) as ZernioProfile[];

  const tagged = profiles.find((p) => p.description === tag);
  if (tagged?._id) return tagged._id;

  // A pre-existing deployment has its accounts in whatever profile it has been
  // using. Adopt it for the first workspace instead of creating a second
  // profile and stranding the accounts already connected there.
  if (profiles.length === 1 && profiles[0]?._id) {
    const existing = profiles[0];
    if (!existing.description?.startsWith("zernflow-workspace:")) {
      await zernio.profiles.updateProfile({
        path: { profileId: existing._id! },
        body: { name: existing.name ?? workspace.name, description: tag },
      });
      return existing._id!;
    }
  }

  const created = await zernio.profiles.createProfile({
    body: { name: workspace.name, description: tag },
  });

  const id = (created?.data as { profile?: ZernioProfile } | undefined)?.profile?._id;
  if (!id) throw new Error("Zernio did not return a profile id");
  return id;
}
