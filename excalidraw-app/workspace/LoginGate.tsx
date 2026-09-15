import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import React, { useState } from "react";

import { AuthRequiredError } from "../data/workspace";

import { useWorkspace } from "./WorkspaceProvider";

import "./workspace.scss";

/**
 * The sign-in screen. Rendered instead of the canvas, never alongside it —
 * mounting the editor for a signed-out user would start an autosave loop
 * against a document it cannot reach.
 */
export const LoginGate = () => {
  const { signIn } = useWorkspace();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busy || !password) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await signIn(password);
    } catch (caught) {
      setError(
        caught instanceof AuthRequiredError
          ? "Incorrect password."
          : "Could not reach the server. Check your connection and try again.",
      );
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <div className="workspace-login">
      <form className="workspace-login__card" onSubmit={submit}>
        <h1 className="workspace-login__title">Scalidraw</h1>
        <p className="workspace-login__subtitle">
          Sign in to open your canvases.
        </p>

        <label className="workspace-login__label" htmlFor="workspace-password">
          Password
        </label>
        <input
          id="workspace-password"
          className="workspace-login__input"
          type="password"
          autoComplete="current-password"
          value={password}
          autoFocus
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error && <div className="workspace-login__error">{error}</div>}

        {/*
          FilledButton hardcodes type="button", so it never submits the form
          around it — the click has to invoke the handler directly. The form's
          onSubmit is still what handles pressing Enter in the field.
        */}
        <FilledButton
          className="workspace-login__submit"
          label="Sign in"
          size="large"
          fullWidth
          status={busy ? "loading" : null}
          disabled={busy || !password}
          onClick={() => void submit()}
        >
          Sign in
        </FilledButton>
      </form>
    </div>
  );
};
