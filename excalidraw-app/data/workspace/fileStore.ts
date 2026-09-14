import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { NetworkError, workspaceApi } from "./api";

import type { WorkspaceApi } from "./api";
import type { KVStore } from "./kv";
import type { DocumentId, FileUpload } from "./types";

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
  /**
   * An upload that has not landed yet. The bytes are already under `file:`,
   * so this only has to remember which document to attribute them to.
   *
   * Without it, D11's "the queue never drops work" held for scenes but not for
   * images: a failed upload left the bytes local with nothing ever retrying,
   * so an image pasted while offline stayed invisible to every other device.
   */
  const pendingKey = (id: FileId) => `upload:${id}`;

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
          // Rejected by the server (malformed, too large) — retrying would
          // fail identically, so this one really is errored.
          await opts.cache.delete(pendingKey(id));
          erroredFiles.set(id, file);
        } else {
          await opts.cache.delete(pendingKey(id));
          savedFiles.set(id, file);
        }
      }
    } catch {
      // Could not reach the server. Queue rather than give up.
      for (const [id, file] of addedFiles) {
        await opts.cache.set(pendingKey(id), { documentId });
        erroredFiles.set(id, file);
      }
    }

    return { savedFiles, erroredFiles };
  };

  /**
   * Retry queued uploads. Called on reconnect and whenever the scene queue is
   * flushed, so images follow the same "eventually lands" guarantee as scenes.
   */
  const flushPendingUploads = async () => {
    const entries = await opts.cache.entries<{ documentId: DocumentId }>();
    const queued = entries.filter(([k]) => k.startsWith("upload:"));
    if (queued.length === 0) {
      return { uploaded: [] as FileId[], stillPending: 0 };
    }

    // One request per document rather than per image.
    const byDocument = new Map<DocumentId, FileId[]>();
    for (const [k, value] of queued) {
      const id = k.slice("upload:".length) as FileId;
      const list = byDocument.get(value.documentId) ?? [];
      list.push(id);
      byDocument.set(value.documentId, list);
    }

    const uploaded: FileId[] = [];

    for (const [documentId, ids] of byDocument) {
      const payload: FileUpload[] = [];
      for (const id of ids) {
        const cached = await opts.cache.get<BinaryFileData>(key(id));
        if (!cached) {
          // Bytes are gone, so there is nothing left to upload; dropping the
          // marker stops it being retried forever.
          await opts.cache.delete(pendingKey(id));
          continue;
        }
        payload.push({
          id,
          dataURL: cached.dataURL,
          created: cached.created ?? Date.now(),
        });
      }

      if (payload.length === 0) {
        continue;
      }

      try {
        const response = await api.uploadFiles(documentId, payload);
        const rejected = new Set(response.rejected.map((entry) => entry.id));
        for (const entry of payload) {
          await opts.cache.delete(pendingKey(entry.id));
          if (!rejected.has(entry.id)) {
            uploaded.push(entry.id);
          }
        }
      } catch {
        // Still unreachable — leave the markers for the next attempt.
      }
    }

    const remaining = (await opts.cache.entries()).filter(([k]) =>
      k.startsWith("upload:"),
    ).length;

    return { uploaded, stillPending: remaining };
  };

  const pendingUploadCount = async () =>
    (await opts.cache.entries()).filter(([k]) => k.startsWith("upload:"))
      .length;

  return { getFiles, saveFiles, flushPendingUploads, pendingUploadCount };
};
