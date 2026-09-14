import clsx from "clsx";
import React from "react";

import { useWorkspace } from "./WorkspaceProvider";

import "./workspace.scss";

/**
 * Sync state has to be visible (D20).
 *
 * The host is a laptop that is only on when it is on, so "saved" is not a safe
 * assumption the user can make silently — closing the lid with writes still
 * queued must be something they can see, not discover later.
 */
export const SyncStatus = () => {
  const { syncState, flush } = useWorkspace();

  const { label, tone, action } = describe(syncState);
  if (!label) {
    return null;
  }

  return (
    <button
      type="button"
      className={clsx("workspace-sync", `workspace-sync--${tone}`)}
      onClick={() => void flush()}
      title={action}
    >
      <span className="workspace-sync__dot" />
      {label}
    </button>
  );
};

const describe = (state: ReturnType<typeof useWorkspace>["syncState"]) => {
  switch (state.status) {
    case "idle":
      return { label: null, tone: "ok", action: "" };
    case "saving":
      return { label: "Saving…", tone: "busy", action: "Saving to the server" };
    case "offline":
      return {
        label:
          state.pending === 1
            ? "1 change not uploaded"
            : `${state.pending} changes not uploaded`,
        tone: "warn",
        action: "Click to retry now",
      };
    case "auth-required":
      return {
        label: "Signed out — reload to sign in",
        tone: "warn",
        action: "Your work is saved locally and will upload after signing in",
      };
    case "conflict":
      return {
        label: "Changed on another device",
        tone: "warn",
        action: "Choose which copy to keep",
      };
    case "error":
      return { label: state.message, tone: "danger", action: "Click to retry" };
    default:
      return { label: null, tone: "ok", action: "" };
  }
};
