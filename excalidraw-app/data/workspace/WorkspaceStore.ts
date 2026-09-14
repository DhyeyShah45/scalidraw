import { debounce } from "@excalidraw/common";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import {
  AccessChallengeError,
  AuthRequiredError,
  ConflictError,
  NetworkError,
  NotFoundError,
  workspaceApi,
} from "./api";

import { splitAppState } from "./appStateSplit";

import type { WorkspaceApi } from "./api";
import type { SceneCache } from "./sceneCache";
import type {
  DocumentAppState,
  DocumentId,
  DocumentMeta,
  SceneRecord,
  SyncState,
} from "./types";

export type LoadedDocument = {
  meta: DocumentMeta;
  elements: readonly ExcalidrawElement[];
  appState: DocumentAppState;
  /** True when the canvas came from cache and the server was unreachable. */
  fromCache: boolean;
};

export type WorkspaceStoreOptions = {
  cache: SceneCache;
  api?: WorkspaceApi;
  /** Server flush cadence. Local cache writes are not debounced by this. */
  flushDebounceMs?: number;
  onSyncState?: (state: SyncState) => void;
  /** Called when a reload resolution replaces the open document's contents. */
  onDocumentReplaced?: (document: LoadedDocument) => void;
};

const DEFAULT_FLUSH_DEBOUNCE = 1000;

/**
 * Owns everything between the editor and the server: the local cache, the
 * pending-write queue, conflict state, and the online/offline transitions.
 *
 * The editor never talks to the API directly — it calls `save` and reads
 * `loadDocument`, and this decides whether that means a network round trip.
 */
export class WorkspaceStore {
  private readonly cache: SceneCache;
  private readonly api: WorkspaceApi;
  private readonly onSyncState: (state: SyncState) => void;
  private readonly onDocumentReplaced?: (document: LoadedDocument) => void;

  private documents = new Map<DocumentId, DocumentMeta>();
  /** In-flight flush, so callers can await the push actually completing. */
  private currentFlush: Promise<void> | null = null;
  /** Set while a flush is in flight and another save lands. */
  private flushAgain = false;

  private readonly scheduleFlush: (() => void) & { flush: () => void };

  constructor(options: WorkspaceStoreOptions) {
    this.cache = options.cache;
    this.api = options.api ?? workspaceApi;
    this.onSyncState = options.onSyncState ?? (() => {});
    this.onDocumentReplaced = options.onDocumentReplaced;

    this.scheduleFlush = debounce(
      () => void this.flush(),
      options.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE,
    );
  }

  // ---------------------------------------------------------------- documents

  async listDocuments(): Promise<DocumentMeta[]> {
    const documents = await this.api.listDocuments();
    this.documents = new Map(documents.map((doc) => [doc.id, doc]));
    return documents;
  }

  async createDocument(name?: string) {
    const meta = await this.api.createDocument(name);
    this.documents.set(meta.id, meta);
    await this.cache.put({
      id: meta.id,
      elements: [],
      appState: {},
      version: meta.version,
      dirty: false,
      updatedAt: meta.updatedAt,
    });
    return meta;
  }

  async renameDocument(id: DocumentId, name: string) {
    const meta = await this.api.renameDocument(id, name);
    this.documents.set(id, meta);
    return meta;
  }

  async deleteDocument(id: DocumentId) {
    await this.api.deleteDocument(id);
    this.documents.delete(id);
    await this.cache.delete(id);
  }

  async duplicateDocument(id: DocumentId, name?: string) {
    const meta = await this.api.duplicateDocument(id, name);
    this.documents.set(meta.id, meta);
    return meta;
  }

  /**
   * Cache first so the canvas paints immediately, then reconcile with the
   * server. A local record with unsynced edits always wins the reconcile —
   * losing them to a background refresh would be exactly the data loss the
   * queue exists to prevent.
   */
  async loadDocument(id: DocumentId): Promise<LoadedDocument> {
    const cached = await this.cache.get(id);

    let remote: Awaited<ReturnType<WorkspaceApi["getScene"]>> | null = null;
    try {
      remote = await this.api.getScene(id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        await this.cache.delete(id);
        throw error;
      }
      if (!this.isRecoverable(error)) {
        throw error;
      }
      this.reportOffline(error);
    }

    if (!remote) {
      if (!cached) {
        // D11: nothing cached and no server — there is genuinely nothing to
        // show, so say so rather than inventing a local scratch document.
        throw new NetworkError("Document unavailable offline");
      }
      return {
        meta: this.metaFor(id, cached),
        elements: cached.elements,
        appState: cached.appState,
        fromCache: true,
      };
    }

    this.documents.set(id, remote.document);

    if (cached?.dirty) {
      this.scheduleFlush();
      return {
        meta: remote.document,
        elements: cached.elements,
        appState: cached.appState,
        fromCache: true,
      };
    }

    const record: SceneRecord = {
      id,
      elements: remote.elements as readonly ExcalidrawElement[],
      appState: remote.appState as DocumentAppState,
      version: remote.document.version,
      dirty: false,
      updatedAt: remote.document.updatedAt,
    };
    await this.cache.put(record);

    return {
      meta: remote.document,
      elements: record.elements,
      appState: record.appState,
      fromCache: false,
    };
  }

  // -------------------------------------------------------------------- saves

  /**
   * The autosave entry point. Writes the local cache synchronously enough to
   * be safe across a tab close, and schedules the server push.
   */
  async save(
    id: DocumentId,
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
    fileIds: readonly string[] = [],
  ) {
    const existing = await this.cache.get(id);
    const { document: documentAppState } = splitAppState(appState);

    await this.cache.put({
      id,
      elements,
      appState: documentAppState,
      // Keep basing on the last server-accepted version; unsynced edits stack
      // on top of one base rather than inventing versions locally.
      version: existing?.version ?? this.documents.get(id)?.version ?? 0,
      dirty: true,
      conflictedWithVersion: existing?.conflictedWithVersion,
      updatedAt: Date.now(),
    });

    this.pendingFileIds.set(id, [
      ...new Set([...(this.pendingFileIds.get(id) ?? []), ...fileIds]),
    ]);

    this.scheduleFlush();
  }

  private pendingFileIds = new Map<DocumentId, string[]>();

  /** Push everything pending now — used on blur, unload, and Ctrl+S (D7). */
  async flushNow() {
    this.scheduleFlush.flush();
    await (this.currentFlush ?? this.flush());

    // An edit that landed mid-request leaves the record dirty again; drain it
    // too, so "flush now" really means nothing is left unsent.
    if ((await this.cache.syncable()).length > 0) {
      await this.flush();
    }
  }

  /**
   * Resolves once the queue is actually drained, including any flush that was
   * requested while this one was in flight. `flushNow` depends on that: a
   * promise that resolved early would let the tab close mid-write.
   */
  private flush(): Promise<void> {
    if (this.currentFlush) {
      this.flushAgain = true;
      return this.currentFlush;
    }

    const run = async (): Promise<void> => {
      await this.runFlush();
      if (this.flushAgain) {
        this.flushAgain = false;
        await run();
      }
    };

    this.currentFlush = run().finally(() => {
      this.currentFlush = null;
    });
    return this.currentFlush;
  }

  private async runFlush(): Promise<void> {
    const pending = await this.cache.pending();
    // Conflicted records stay dirty but are blocked on the user, so they are
    // not work the queue can do.
    const syncable = pending.filter(
      (record) => record.conflictedWithVersion === undefined,
    );
    const blocked = pending.length - syncable.length;

    if (syncable.length === 0) {
      // Only claim idle when nothing at all is outstanding — announcing it
      // while a conflict prompt is up would dismiss the prompt's state.
      if (blocked === 0) {
        this.onSyncState({ status: "idle" });
      }
      return;
    }

    this.onSyncState({ status: "saving" });

    let sawConflict = blocked > 0;

    for (const record of syncable) {
      const outcome = await this.push(record);
      if (outcome === "stop") {
        return;
      }
      if (outcome === "conflict") {
        sawConflict = true;
      }
    }

    if (sawConflict) {
      // The conflict state is already published and needs the user to act on
      // it. Reporting anything else here would bury the prompt.
      return;
    }

    const remaining = (await this.cache.syncable()).length;
    this.onSyncState(
      remaining === 0
        ? { status: "idle" }
        : { status: "offline", pending: remaining },
    );
  }

  /** `stop` aborts the whole flush (offline, signed out). */
  private async push(
    record: SceneRecord,
  ): Promise<"pushed" | "conflict" | "stop"> {
    try {
      const result = await this.api.putScene(record.id, record.version, {
        elements: record.elements,
        appState: record.appState as Record<string, unknown>,
        fileIds: this.pendingFileIds.get(record.id) ?? [],
      });

      const current = await this.cache.get(record.id);
      // Another edit landed while this request was in flight; it keeps the
      // dirty flag and re-bases onto the version the server just handed back.
      const stillDirty = current ? current.updatedAt > record.updatedAt : false;

      await this.cache.update(record.id, {
        version: result.version,
        dirty: stillDirty,
      });
      this.pendingFileIds.delete(record.id);

      const meta = this.documents.get(record.id);
      if (meta) {
        this.documents.set(record.id, { ...meta, version: result.version });
      }
      return "pushed";
    } catch (error) {
      if (error instanceof ConflictError) {
        await this.cache.update(record.id, {
          conflictedWithVersion: error.serverVersion,
        });
        this.onSyncState({
          status: "conflict",
          documentId: record.id,
          serverVersion: error.serverVersion,
        });
        return "conflict";
      }

      if (error instanceof AuthRequiredError) {
        // Includes the Access bounce (D24). The write stays queued so signing
        // back in resumes rather than restarts.
        this.onSyncState({ status: "auth-required" });
        return "stop";
      }

      if (error instanceof NetworkError) {
        this.reportOffline(error);
        return "stop";
      }

      this.onSyncState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return "stop";
    }
  }

  // ---------------------------------------------------------------- conflicts

  /**
   * Take the server's copy, discarding the local pending write. The caller is
   * expected to hand the returned document back to the editor.
   */
  async resolveWithServer(id: DocumentId): Promise<LoadedDocument> {
    await this.cache.update(id, {
      dirty: false,
      conflictedWithVersion: undefined,
    });
    await this.cache.delete(id);

    const loaded = await this.loadDocument(id);
    this.onDocumentReplaced?.(loaded);
    this.onSyncState({ status: "idle" });
    return loaded;
  }

  /** Keep the local copy and force it over the server's. */
  async resolveWithLocal(id: DocumentId) {
    const record = await this.cache.get(id);
    if (!record || record.conflictedWithVersion === undefined) {
      return;
    }

    await this.cache.update(id, {
      version: record.conflictedWithVersion,
      conflictedWithVersion: undefined,
      dirty: true,
    });
    await this.flush();
  }

  // ------------------------------------------------------------------ helpers

  async pendingCount() {
    return this.cache.pendingCount();
  }

  /** Retry the queue — wire to `window.online` and to a manual retry button. */
  retry() {
    this.scheduleFlush();
  }

  private isRecoverable(error: unknown) {
    return error instanceof NetworkError || error instanceof AuthRequiredError;
  }

  private reportOffline(error: unknown) {
    if (
      error instanceof AccessChallengeError ||
      error instanceof AuthRequiredError
    ) {
      this.onSyncState({ status: "auth-required" });
      return;
    }
    void this.cache
      .syncable()
      .then((pending) =>
        this.onSyncState({ status: "offline", pending: pending.length }),
      );
  }

  private metaFor(id: DocumentId, record: SceneRecord): DocumentMeta {
    return (
      this.documents.get(id) ?? {
        id,
        name: "Untitled",
        version: record.version,
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
        hasThumbnail: false,
      }
    );
  }
}
