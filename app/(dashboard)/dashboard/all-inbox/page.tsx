import { getUnifiedInbox } from "@/lib/actions/all-inbox";
import { getWorkspace } from "@/lib/workspace";
import { AllInboxView } from "./all-inbox-view";

export const dynamic = "force-dynamic";

export default async function AllInboxPage() {
  await getWorkspace();
  const inbox = await getUnifiedInbox();

  return (
    <AllInboxView
      threads={inbox.threads}
      workspaces={inbox.workspaces}
      accounts={inbox.accounts}
    />
  );
}
