import { createFileHandlers } from "./fileStore";
import { createIdbKV } from "./kv";
import { SceneCache } from "./sceneCache";
import { WorkspaceStore } from "./WorkspaceStore";

import type { WorkspaceStoreOptions } from "./WorkspaceStore";
import type { DocumentId } from "./types";

export { WorkspaceStore } from "./WorkspaceStore";
export { SceneCache } from "./sceneCache";
export { createIdbKV, createMemoryKV } from "./kv";
export { createServerLibraryAdapter } from "./libraryAdapter";
export { createFileHandlers } from "./fileStore";
export { splitAppState, mergeAppState } from "./appStateSplit";
export {
  workspaceApi,
  AccessChallengeError,
  AuthRequiredError,
  ConflictError,
  NetworkError,
  NotFoundError,
  WorkspaceApiError,
} from "./api";
export type { KVStore } from "./kv";
export type { LoadedDocument, WorkspaceStoreOptions } from "./WorkspaceStore";
export type { DocumentId, DocumentMeta, SceneRecord, SyncState } from "./types";

/**
 * Separate databases per concern, matching the existing convention in
 * `LocalData` (`files-db`, `excalidraw-library-db`) and avoiding idb-keyval's
 * one-store-per-database upgrade awkwardness.
 */
const SCENES_DB = ["scalidraw-scenes-db", "scenes-store"] as const;
const FILES_DB = ["scalidraw-files-db", "files-store"] as const;

export const createWorkspace = (
  options: Omit<WorkspaceStoreOptions, "cache"> & {
    currentDocumentId: () => DocumentId | null;
  },
) => {
  const cache = new SceneCache(createIdbKV(...SCENES_DB));
  const store = new WorkspaceStore({ ...options, cache });
  const files = createFileHandlers({
    currentDocumentId: options.currentDocumentId,
    cache: createIdbKV(...FILES_DB),
    api: options.api,
  });

  return { store, files };
};
