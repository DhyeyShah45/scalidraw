import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { NetworkError, workspaceApi } from "./api";

import type { WorkspaceApi } from "./api";
import type { KVStore } from "./kv";
import type { DocumentId } from "./types";

/**
 * `getFiles`/`saveFiles` for a server-backed `FileManager`.
 *
 * Images are cached locally alongside scenes so an offline canvas still
 * renders its pictures rather than a grid of broken placeholders.
 *
 * Uploads are addressed to a specific document, which is what keeps the
 * server-side refcount honest — the fix for the GC that used to delete images
 * belonging to documents that merely weren't open.
 */
export const createFileHandlers = (opts: {
  currentDocumentId: () => DocumentId | null;
  cache: KVStore;
  api?: WorkspaceApi;
}) => {
  const api = opts.api ?? workspaceApi;
  const key = (id: FileId) => `file:${id}`;

  const getFiles = async (ids: FileId[]) => {
    const loadedFiles: BinaryFileData[] = [];
    const erroredFiles = new Map<FileId, true>();
    const missingLocally: FileId[] = [];

    for (const id of ids) {
      const cached = await opts.cache.get<BinaryFileData>(key(id));
      if (cached) {
        loadedFiles.push(cached);
      } else {
        missingLocally.push(id);
      }
    }

    if (missingLocally.length === 0) {
      return { loadedFiles, erroredFiles };
    }

    try {
      const response = await api.fetchFiles(missingLocally);
      for (const file of response.files) {
        const data = {
          id: file.id as FileId,
          mimeType: file.mimeType as BinaryFileData["mimeType"],
          dataURL: file.dataURL as BinaryFileData["dataURL"],
          created: file.created,
        };
        await opts.cache.set(key(data.id), data);
        loadedFiles.push(data);
      }
      for (const id of response.missing) {
        erroredFiles.set(id as FileId, true);
      }
    } catch (error) {
      if (!(error instanceof NetworkError)) {
        throw error;
      }
      // Offline: report as errored so the editor stops asking, but leave the
      // cache untouched so a later reconnect can still fill them in.
      for (const id of missingLocally) {
        erroredFiles.set(id, true);
      }
    }

    return { loadedFiles, erroredFiles };
  };

  const saveFiles = async ({
    addedFiles,
  }: {
    addedFiles: Map<FileId, BinaryFileData>;
  }) => {
    const savedFiles = new Map<FileId, BinaryFileData>();
    const erroredFiles = new Map<FileId, BinaryFileData>();

    const documentId = opts.currentDocumentId();
    if (!documentId) {
      return { savedFiles, erroredFiles: addedFiles };
    }

    // Cache first: an image the user just pasted must survive a reload even if
    // the upload has not completed.
    for (const [id, file] of addedFiles) {
      await opts.cache.set(key(id), file);
    }

    try {
      const response = await api.uploadFiles(
        documentId,
        [...addedFiles.values()].map((file) => ({
          id: file.id,
          dataURL: file.dataURL,
          created: file.created,
        })),
      );

      const rejected = new Set(response.rejected.map((entry) => entry.id));
      for (const [id, file] of addedFiles) {
        if (rejected.has(id)) {
          erroredFiles.set(id, file);
        } else {
          savedFiles.set(id, file);
        }
      }
    } catch {
      for (const [id, file] of addedFiles) {
        erroredFiles.set(id, file);
      }
    }

    return { savedFiles, erroredFiles };
  };

  return { getFiles, saveFiles };
};
