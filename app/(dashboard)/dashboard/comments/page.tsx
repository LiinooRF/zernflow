import { getCommentsBoard } from "@/lib/actions/comments";
import { getWorkspace } from "@/lib/workspace";
import { CommentsView } from "./comments-view";

// Comments are fetched live from Zernio on every load.
export const dynamic = "force-dynamic";

export default async function CommentsPage() {
  // Enforces auth and the redirect to /login, same as every other dashboard page.
  await getWorkspace();

  const board = await getCommentsBoard();

  return (
    <CommentsView
      items={board.items}
      workspaces={board.workspaces}
      accounts={board.accounts}
      errors={board.errors}
    />
  );
}
