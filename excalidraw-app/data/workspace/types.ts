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
  /**
   * Monotonic local edit counter. A push clears `dirty` only if the revision
   * still matches the one it sent — `updatedAt` cannot do this job, because
   * two saves inside the same millisecond are indistinguishable and the
   * second one would be marked synced without ever being sent.
   */
  revision: number;
  /** Consecutive failed pushes, used to stop retrying a poisoned record. */
  failures?: number;
  /**
   * Which browser tab last wrote this record. Two tabs on one document share
   * a cache entry and therefore a `version`, so the server's If-Match check
   * cannot see them diverge — this is what restores that protection locally.
   */
  lastWriterTab?: string;
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
