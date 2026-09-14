import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { AppState, BinaryFileData } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";
import { importFromLocalStorage } from "../data/localStorage";
import { createIdbKV } from "../data/workspace";

import type { DocumentMeta, KVStore, WorkspaceStore } from "../data/workspace";

/**
 * One-shot import of the single scene the app kept in localStorage before
 * documents existed.
 *
 * The legacy data is never deleted — only a flag is written. If this goes
 * wrong the original drawing is still sitting in localStorage where it always
 * was, which matters because it may be the only copy.
 */
export const MIGRATION_FLAG = "scalidraw-legacy-migrated";

/** Legacy image store, owned by `LocalData` (`LocalData.ts`). */
const LEGACY_FILES_DB = ["files-db", "files-store"] as const;

export const hasMigrated = () => {
  try {
    return localStorage.getItem(MIGRATION_FLAG) === "true";
  } catch {
    // No localStorage at all means nothing to migrate from either.
    return true;
  }
};

export const markMigrated = () => {
  try {
    localStorage.setItem(MIGRATION_FLAG, "true");
  } catch (error) {
    console.warn("could not record the legacy migration flag", error);
  }
};

export type LegacyScene = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState> | null;
};

export const readLegacyScene = (): LegacyScene | null => {
  try {
    if (!localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)) {
      return null;
    }
  } catch {
    return null;
  }

  const { elements, appState } = importFromLocalStorage();
  // An empty canvas is not worth a document; treat it as nothing to migrate.
  return elements.length > 0 ? { elements, appState } : null;
};

/**
 * Collects the legacy images the scene actually references. Anything else in
 * that store belongs to scenes that no longer exist.
 */
export const readLegacyFiles = async (
  elements: readonly ExcalidrawElement[],
  kv: KVStore = createIdbKV(...LEGACY_FILES_DB),
) => {
  const wanted = new Set(
    elements
      .filter(
        (element): element is ExcalidrawElement & { fileId: string } =>
          "fileId" in element && !!element.fileId,
      )
      .map((element) => element.fileId),
  );

  if (wanted.size === 0) {
    return {};
  }

  const files: { [id: string]: BinaryFileData } = {};
  try {
    for (const [id, data] of await kv.entries<BinaryFileData>()) {
      if (wanted.has(id) && data?.dataURL) {
        files[id] = data;
      }
    }
  } catch (error) {
    // Losing the images is bad but losing the drawing would be worse, so the
    // migration continues without them.
    console.warn("could not read legacy images", error);
  }
  return files;
};

export type MigrationResult =
  | { migrated: false; reason: "already-done" | "nothing-to-migrate" }
  | { migrated: true; document: DocumentMeta; imageCount: number };

export const migrateLegacyScene = async (opts: {
  store: WorkspaceStore;
  /** Uploads images against the newly created document. */
  uploadFiles: (
    elements: readonly ExcalidrawElement[],
    files: { [id: string]: BinaryFileData },
  ) => Promise<void>;
  /** Called with the new document's id before uploading, for refcounting. */
  onDocumentCreated?: (id: string) => void;
  name?: string;
  readScene?: () => LegacyScene | null;
  readFiles?: (
    elements: readonly ExcalidrawElement[],
  ) => Promise<{ [id: string]: BinaryFileData }>;
}): Promise<MigrationResult> => {
  if (hasMigrated()) {
    return { migrated: false, reason: "already-done" };
  }

  const legacy = (opts.readScene ?? readLegacyScene)();
  if (!legacy) {
    // Nothing to bring across, but still flag it so an empty canvas drawn on
    // later is never mistaken for legacy data.
    markMigrated();
    return { migrated: false, reason: "nothing-to-migrate" };
  }

  const document = await opts.store.createDocument(
    opts.name ?? "Imported canvas",
  );
  opts.onDocumentCreated?.(document.id);

  const files = await (opts.readFiles ?? readLegacyFiles)(legacy.elements);
  if (Object.keys(files).length) {
    await opts.uploadFiles(legacy.elements, files);
  }

  await opts.store.save(
    document.id,
    legacy.elements,
    legacy.appState ?? {},
    Object.keys(files),
  );
  await opts.store.flushNow();

  // Only after the scene has actually reached the server. Flagging earlier
  // would strand the drawing if the upload failed.
  markMigrated();

  return { migrated: true, document, imageCount: Object.keys(files).length };
};
