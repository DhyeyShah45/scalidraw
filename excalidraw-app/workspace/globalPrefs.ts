import type { AppState } from "@excalidraw/excalidraw/types";

import { splitAppState } from "../data/workspace";

/**
 * Device-local editor preferences (D13).
 *
 * Only documents sync. Pen colour, export settings and snapping prefs stay
 * per-device on purpose — a stylus tablet wants different defaults than a
 * laptop — following the precedent already set by `useHandleAppTheme`, which
 * keeps theme in its own key rather than in the scene blob.
 */
const STORAGE_KEY = "scalidraw-editor-prefs";

export const loadGlobalPrefs = (): Partial<AppState> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<AppState>) : {};
  } catch (error) {
    console.warn("could not read editor preferences", error);
    return {};
  }
};

export const saveGlobalPrefs = (appState: Partial<AppState>) => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(splitAppState(appState).global),
    );
  } catch (error) {
    // Quota or a locked-down browser; preferences are not worth surfacing.
    console.warn("could not persist editor preferences", error);
  }
};
