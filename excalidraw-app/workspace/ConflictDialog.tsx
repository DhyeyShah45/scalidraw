import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import React, { useState } from "react";

import { useWorkspace } from "./WorkspaceProvider";

import "./workspace.scss";

/**
 * The 409 resolution prompt (D9).
 *
 * Deliberately modal and deliberately without a dismiss: the local copy stays
 * queued until a choice is made, and quietly closing this would leave the
 * document stuck — never syncing, with no visible reason why.
 */
export const ConflictDialog = () => {
  const { syncState, resolveConflict } = useWorkspace();
  const [busy, setBusy] = useState<"local" | "server" | null>(null);

  if (syncState.status !== "conflict") {
    return null;
  }

  const resolve = async (keep: "local" | "server") => {
    setBusy(keep);
    try {
      await resolveConflict(keep);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      title="This canvas changed somewhere else"
      onCloseRequest={() => {}}
    >
      <div className="workspace-conflict">
        <p>
          Another device saved this canvas while you were drawing, so your
          changes were not uploaded. Nothing has been lost — pick which version
          to keep.
        </p>
        <div className="workspace-conflict__actions">
          <FilledButton
            label="Keep my changes"
            size="large"
            status={busy === "local" ? "loading" : null}
            disabled={busy !== null}
            onClick={() => void resolve("local")}
          >
            Keep what is on this screen
          </FilledButton>
          <FilledButton
            label="Use the other version"
            variant="outlined"
            size="large"
            status={busy === "server" ? "loading" : null}
            disabled={busy !== null}
            onClick={() => void resolve("server")}
          >
            Use the other device&rsquo;s version
          </FilledButton>
        </div>
        <p className="workspace-conflict__note">
          Keeping what is on this screen overwrites the other version. Either
          way an automatic snapshot of both is retained on the server.
        </p>
      </div>
    </Dialog>
  );
};
