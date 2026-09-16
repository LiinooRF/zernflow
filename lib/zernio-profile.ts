/**
 * Picks which Zernio profile a new connection should land in.
 *
 * A Zernio profile holds exactly ONE account per platform. Connecting a second
 * Instagram account into a profile that already has one does not add it: it
 * replaces the first and deletes that slot's inbox, DM history and analytics.
 *
 * So the unit that needs its own profile is the ACCOUNT, not the workspace.
 * A workspace pointing at a single profile still let the second Instagram
 * account of that same client wipe the first. This looks at what each profile
 * already holds and only ever hands back one whose slot for this platform is
 * free, creating another profile when they are all taken.
 */

const ZERNIO_API = process.env.ZERNIO_API_URL ?? "https://zernio.com/api";

interface ZernioProfile {
  _id?: string;
  name?: string;
  description?: string;
}

interface ZernioAccount {
  platform?: string;
  username?: string;
  profileId?: { _id?: string; name?: string } | string | null;
}

/** Ties profiles to a workspace independently of display names, so renaming the
 *  workspace does not orphan them. Several profiles can share one tag. */
export function workspaceProfileTag(workspaceId: string): string {
  return `zernflow-workspace:${workspaceId}`;
}

async function zernio<T>(apiKey: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ZERNIO_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Zernio ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function profileIdOf(account: ZernioAccount): string | null {
  const ref = account.profileId;
  if (!ref) return null;
  return typeof ref === "string" ? ref : (ref._id ?? null);
}

/**
 * Returns the id of a profile whose `platform` slot is free, creating one if
 * every profile this workspace owns already has an account of that platform.
 */
export async function pickProfileForPlatform(
  apiKey: string,
  workspace: { id: string; name: string },
  platform: string,
): Promise<{ profileId: string; created: boolean }> {
  const tag = workspaceProfileTag(workspace.id);

  const profilesRes = await zernio<{ profiles?: ZernioProfile[] }>(apiKey, "/v1/profiles");
  const profiles = profilesRes.profiles ?? [];

  const accountsRes = await zernio<{ accounts?: ZernioAccount[] } | ZernioAccount[]>(
    apiKey,
    "/v1/accounts",
  );
  const accounts = Array.isArray(accountsRes) ? accountsRes : (accountsRes.accounts ?? []);

  const takenBy = new Set(
    accounts
      .filter((a) => a.platform === platform)
      .map((a) => profileIdOf(a))
      .filter((id): id is string => Boolean(id)),
  );

  let mine = profiles.filter((p) => p.description === tag);

  // A deployment that predates this owns one untagged profile with its accounts
  // already in it. Adopt it rather than creating a second one and stranding them.
  if (mine.length === 0) {
    const untagged = profiles.find((p) => !p.description?.startsWith("zernflow-workspace:"));
    if (untagged?._id) {
      await zernio(apiKey, `/v1/profiles/${untagged._id}`, {
        method: "PUT",
        body: JSON.stringify({ name: untagged.name ?? workspace.name, description: tag }),
      });
      mine = [{ ...untagged, description: tag }];
    }
  }

  const free = mine.find((p) => p._id && !takenBy.has(p._id));
  if (free?._id) return { profileId: free._id, created: false };

  // Every profile this workspace owns already has an account on this platform,
  // so connecting into any of them would replace it. Make another.
  const created = await zernio<{ profile?: ZernioProfile }>(apiKey, "/v1/profiles", {
    method: "POST",
    body: JSON.stringify({
      name: `${workspace.name} ${mine.length + 1}`,
      description: tag,
    }),
  });

  const id = created.profile?._id;
  if (!id) throw new Error("Zernio did not return a profile id");
  return { profileId: id, created: true };
}

/**
 * The profile ids this workspace owns, adopting a pre-existing untagged profile
 * when it owns none yet.
 *
 * Channel sync needs this: one Zernio account can hold every client, so
 * importing "all accounts under the key" into whichever workspace saved the key
 * would hand each client the other clients' channels. An empty result means
 * this workspace has connected nothing yet and should import nothing.
 */
export async function workspaceProfileIds(
  apiKey: string,
  workspace: { id: string; name: string },
): Promise<Set<string>> {
  const tag = workspaceProfileTag(workspace.id);
  const profilesRes = await zernio<{ profiles?: ZernioProfile[] }>(apiKey, "/v1/profiles");
  const profiles = profilesRes.profiles ?? [];

  const mine = profiles.filter((p) => p.description === tag);
  if (mine.length > 0) {
    return new Set(mine.map((p) => p._id).filter((id): id is string => Boolean(id)));
  }

  const untagged = profiles.find((p) => !p.description?.startsWith("zernflow-workspace:"));
  if (untagged?._id) {
    await zernio(apiKey, `/v1/profiles/${untagged._id}`, {
      method: "PUT",
      body: JSON.stringify({ name: untagged.name ?? workspace.name, description: tag }),
    });
    return new Set([untagged._id]);
  }

  return new Set();
}

/** Which profile an account sits in, or null when the payload omits it. */
export function accountProfileId(account: { profileId?: unknown }): string | null {
  return profileIdOf(account as ZernioAccount);
}
