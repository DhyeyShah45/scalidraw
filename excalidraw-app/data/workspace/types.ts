import type { AppState, BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

export type DocumentId = string;

export type DocumentMeta = {
  id: DocumentId;
  name: string;
  /** Server version this client last saw; the If-Match token. */
  version: number;
  createdAt: number;
  updatedAt: number;
  hasThumbnail: boolean;
};

/** The appState subset that belongs to a document rather than the device (D13). */
export type DocumentAppState = Partial<AppState>;

export type SceneRecord = {
  id: DocumentId;
  elements: readonly ExcalidrawElement[];
  appState: DocumentAppState;
  /** Server version these contents are based on. */
  version: number;
  /**
   * True when the local copy has edits the server has not accepted. A dirty
   * record IS the sync queue entry — there is no separate queue, so a burst of
   * edits collapses to one pending write per document (latest wins).
   */
  dirty: boolean;
  /** Set when the server rejected the pending write as stale (D9). */
  conflictedWithVersion?: number;
  updatedAt: number;
};

export type SyncState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "offline"; pending: number }
  | { status: "auth-required" }
  | { status: "conflict"; documentId: DocumentId; serverVersion: number }
  | { status: "error"; message: string };

export type FileUpload = Pick<BinaryFileData, "id" | "dataURL" | "created">;
