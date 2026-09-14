import {
  clearAppStateForDatabase,
  clearAppStateForLocalStorage,
} from "@excalidraw/excalidraw/appState";

import type { AppState } from "@excalidraw/excalidraw/types";

import type { DocumentAppState } from "./types";

/**
 * Splitting appState between "this document" and "this device" (D13).
 *
 * The document half is deliberately derived from upstream's own
 * APP_STATE_STORAGE_CONF via `clearAppStateForDatabase` — those are the fields
 * Excalidraw already treats as belonging to a scene rather than a browser, so
 * upstream additions flow through instead of drifting from a copied list.
 *
 * What that table does NOT cover is viewport and selection: they are marked
 * browser-only purely because there has only ever been one scene. With several
 * documents they are per-document too, or you land at the previous document's
 * scroll position every time you switch.
 */
const EXTRA_DOCUMENT_KEYS = [
  "scrollX",
  "scrollY",
  "zoom",
  "scrolledOutside",
  "selectedElementIds",
  "selectedGroupIds",
  "editingGroupId",
] as const;

// `satisfies` would say this more directly, but the repo pins prettier 2.6.2,
// which cannot parse it. This asserts the same thing: every key above is a
// real AppState field, so a rename upstream breaks the build rather than
// silently dropping viewport state on the floor.
type AssertDocumentKeys =
  typeof EXTRA_DOCUMENT_KEYS[number] extends keyof AppState ? true : never;
const _assertDocumentKeys: AssertDocumentKeys = true;
void _assertDocumentKeys;

/**
 * `name` is excluded on purpose: in a multi-document world the document name is
 * metadata owned by the documents table, not a field buried in a scene blob.
 * It is re-applied on load by `mergeAppState`.
 */
const NEVER_GLOBAL = new Set<string>([...EXTRA_DOCUMENT_KEYS, "name"]);

export const splitAppState = (appState: Partial<AppState>) => {
  const documentState = clearAppStateForDatabase(appState) as DocumentAppState;

  for (const key of EXTRA_DOCUMENT_KEYS) {
    if (appState[key] !== undefined) {
      (documentState as Record<string, unknown>)[key] = appState[key];
    }
  }

  const globalState: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    clearAppStateForLocalStorage(appState),
  )) {
    if (!NEVER_GLOBAL.has(key) && !(key in documentState)) {
      globalState[key] = value;
    }
  }

  return {
    document: documentState,
    global: globalState as Partial<AppState>,
  };
};

/**
 * Rebuild the appState to hand the editor when opening a document.
 *
 * Order matters: device preferences first, then the document's own state on
 * top, so a document can override the grid while the pen colour stays yours.
 */
export const mergeAppState = (opts: {
  global: Partial<AppState>;
  document: DocumentAppState;
  documentName: string;
}): Partial<AppState> => ({
  ...opts.global,
  ...opts.document,
  name: opts.documentName,
});

export const DOCUMENT_APP_STATE_KEYS = EXTRA_DOCUMENT_KEYS;
