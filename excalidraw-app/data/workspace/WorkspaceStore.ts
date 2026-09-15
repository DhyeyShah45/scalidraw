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
 * Content identity for a scene. Element `version` increments on every
 * mutation, so summing them detects any edit, and the per-document appState
 * covers viewport-only changes. Keys are sorted because JSON.stringify
 * preserves insertion order and the same state can arrive ordered differently.
 */
export const sceneSignature = (
  elements: readonly ExcalidrawElement[],
  appState: Record<string, unknown>,
) => {
  /*
   * Folds element identity in alongside the version counters. Summing
   * versions alone is not enough: a missing `version` makes the sum NaN, and
   * NaN compares equal for every scene of the same length, so two completely
   * different canvases would look identical and a real save would be dropped
   * as a no-op.
   */
  let identity = 0;
  let versions = 0;
  for (const element of elements) {
    for (let i = 0; i < element.id.length; i++) {
      identity = (identity * 31 + element.id.charCodeAt(i)) | 0;
    }
    identity = (identity * 31 + (element.version ?? 0)) | 0;
    versions += element.version ?? 0;
  }
  const state = Object.keys(appState)
    .sort()
    .map((key) => `${key}=${JSON.stringify(appState[key])}`)
    .join("&");
  return `${elements.length}:${versions}:${identity}:${state}`;
};

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
  /** Identifies this tab for the same-document multi-tab check. */
  private readonly tabId = Math.random().toString(36).slice(2);
  /** Revision this tab believes each document is at. */
  private knownRevision = new Map<DocumentId, number>();
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
      revision: 0,
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
      this.knownRevision.set(id, cached.revision);
      return {
        meta: this.metaFor(id, cached),
        elements: cached.elements,
        appState: cached.appState,
        fromCache: true,
      };
    }

    this.documents.set(id, remote.document);

    if (cached?.dirty) {
      this.knownRevision.set(id, cached.revision);
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
      revision: 0,
      syncedSignature: sceneSignature(
        remote.elements as readonly ExcalidrawElement[],
        remote.appState as Record<string, unknown>,
      ),
      updatedAt: remote.document.updatedAt,
    };
    await this.cache.put(record);
    this.knownRevision.set(id, record.revision);

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
    // Serialized per document: this is a read-modify-write across two awaits,
    // so two overlapping calls could otherwise both read the same record, and
    // the second would write back a stale version or resurrect a cleared
    // conflict flag.
    const previous = this.saveChain.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.writeLocal(id, elements, appState, fileIds));

    this.saveChain.set(id, next);
    await next;
    if (this.saveChain.get(id) === next) {
      this.saveChain.delete(id);
    }

    this.scheduleFlush();
  }

  private async writeLocal(
    id: DocumentId,
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
    fileIds: readonly string[],
  ) {
    const existing = await this.cache.get(id);
    const { document: documentAppState } = splitAppState(appState);
    const signature = sceneSignature(
      elements,
      documentAppState as Record<string, unknown>,
    );

    if (
      !existing?.dirty &&
      existing?.syncedSignature !== undefined &&
      existing.syncedSignature === signature
    ) {
      /*
       * Byte-identical to what the server already holds, so there is nothing
       * to send. This matters more than it sounds: the editor emits onChange
       * on mount and on any re-render, and pushing those bumps the version for
       * content nobody edited — which tells every other device the document
       * changed and hands them a conflict prompt for a phantom edit. Checked
       * before the cross-tab guard below, since a no-op is not a tab conflict.
       */
      return;
    }

    if (this.writtenByAnotherTab(id, existing)) {
      // Another tab edited this document since we loaded it. Overwriting the
      // shared cache record here would discard that tab's work with no 409 to
      // catch it, so surface the same prompt two devices would get.
      //
      // Park this tab's scene rather than dropping it: the shared record now
      // holds the OTHER tab's content, so without this "keep what is on this
      // screen" would push their work and silently lose ours.
      await this.cache.putContended(id, this.tabId, {
        id,
        elements,
        appState: documentAppState,
        version: existing!.version,
        dirty: true,
        revision: (existing!.revision ?? 0) + 1,
        lastWriterTab: this.tabId,
        failures: 0,
        updatedAt: Date.now(),
      });
      this.awaitingResolution.add(id);
      await this.cache.update(id, {
        conflictedWithVersion: existing!.version,
      });
      this.onSyncState({
        status: "conflict",
        documentId: id,
        serverVersion: existing!.version,
      });
      return;
    }

    await this.cache.put({
      id,
      elements,
      appState: documentAppState,
      // Keep basing on the last server-accepted version; unsynced edits stack
      // on top of one base rather than inventing versions locally.
      version: existing?.version ?? this.documents.get(id)?.version ?? 0,
      dirty: true,
      conflictedWithVersion: existing?.conflictedWithVersion,
      revision: (existing?.revision ?? 0) + 1,
      lastWriterTab: this.tabId,
      // A fresh edit deserves a fresh attempt at a record we had given up on.
      failures: 0,
      syncedSignature: existing?.syncedSignature,
      updatedAt: Date.now(),
    });

    this.knownRevision.set(id, (existing?.revision ?? 0) + 1);

    this.pendingFileIds.set(id, [
      ...new Set([...(this.pendingFileIds.get(id) ?? []), ...fileIds]),
    ]);
  }

  private writtenByAnotherTab(
    id: DocumentId,
    existing: SceneRecord | undefined,
  ) {
    return (
      !!existing &&
      existing.conflictedWithVersion === undefined &&
      !!existing.lastWriterTab &&
      existing.lastWriterTab !== this.tabId &&
      existing.revision > (this.knownRevision.get(id) ?? 0)
    );
  }

  /** Documents whose conflict prompt is still waiting on the user. */
  private awaitingResolution = new Set<DocumentId>();
  private saveChain = new Map<DocumentId, Promise<void>>();
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
    try {
      await this.drain();
    } catch (error) {
      // Most often IndexedDB refusing to write (quota, private mode). Without
      // this the rejection escapes a `void` call and sync dies silently.
      this.onSyncState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Local storage unavailable",
      });
    }
  }

  private async drain(): Promise<void> {
    const pending = await this.cache.pending();
    // One definition of "pushable", shared with the remaining-count below.
    // Duplicating the filter here let the give-up cap be ignored on this path
    // while being honoured on the other, so a broken record kept retrying.
    const syncable = await this.cache.syncable();
    const blocked = pending.length - syncable.length;

    if (syncable.length === 0) {
      // Only claim idle when nothing at all is outstanding. A cross-tab clash
      // leaves the shared record CLEAN (the other tab already synced it), so
      // without `awaitingResolution` the very next flush reported idle and
      // wiped the conflict state — the prompt never appeared and the losing
      // tab's work disappeared with no warning at all.
      if (blocked === 0 && this.awaitingResolution.size === 0) {
        this.onSyncState({ status: "idle" });
      }
      return;
    }

    this.onSyncState({ status: "saving" });

    let sawConflict = blocked > 0;

    for (const record of syncable) {
      const outcome = await this.push(record);
      if (outcome === "stop") {
        // Offline or signed out — a whole-queue condition, so stop and let the
        // retry path pick everything up together.
        return;
      }
      if (outcome === "conflict") {
        sawConflict = true;
      }
      // "skip" falls through deliberately: one unpushable document must not
      // starve the rest. `pending()` is ordered oldest-first, so returning
      // early here would retry the same poisoned record forever.
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
  ): Promise<"pushed" | "conflict" | "skip" | "stop"> {
    try {
      const result = await this.api.putScene(record.id, record.version, {
        elements: record.elements,
        appState: record.appState as Record<string, unknown>,
        fileIds: this.pendingFileIds.get(record.id) ?? [],
      });

      // Revision-guarded: if an edit landed while this was in flight, the
      // record stays dirty and merely re-bases onto the new server version.
      await this.cache.settle(record.id, record.revision, {
        version: result.version,
        dirty: false,
        failures: 0,
        syncedSignature: sceneSignature(
          record.elements,
          record.appState as Record<string, unknown>,
        ),
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

      if (error instanceof NotFoundError) {
        // Deleted from another device. There is nothing left to sync to, and
        // retrying forever would block every other document's writes.
        await this.cache.delete(record.id);
        this.documents.delete(record.id);
        return "skip";
      }

      // Something specific to this document that retrying will not fix. Count
      // it, keep the contents, and move on to the rest of the queue.
      await this.cache.update(record.id, {
        failures: (record.failures ?? 0) + 1,
      });
      this.onSyncState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return "skip";
    }
  }

  // ---------------------------------------------------------------- conflicts

  /**
   * Take the server's copy, discarding the local pending write. The caller is
   * expected to hand the returned document back to the editor.
   */
  async resolveWithServer(id: DocumentId): Promise<LoadedDocument> {
    await this.cache.dropContended(id, this.tabId);
    this.awaitingResolution.delete(id);
    // Fetch first. Deleting the local copy up front would destroy both sides
    // if the server happened to be unreachable at that moment.
    const remote = await this.api.getScene(id);
    this.documents.set(id, remote.document);

    const elements = remote.elements as readonly ExcalidrawElement[];
    const appState = remote.appState as DocumentAppState;

    await this.cache.put({
      id,
      elements,
      appState,
      version: remote.document.version,
      dirty: false,
      revision: 0,
      failures: 0,
      lastWriterTab: this.tabId,
      updatedAt: remote.document.updatedAt,
    });
    this.knownRevision.set(id, 0);

    const loaded: LoadedDocument = {
      meta: remote.document,
      elements,
      appState,
      fromCache: false,
    };
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

    // Prefer this tab's parked scene; the shared record holds the other tab's.
    const contended = await this.cache.getContended(id, this.tabId);

    await this.cache.put({
      ...record,
      ...(contended
        ? { elements: contended.elements, appState: contended.appState }
        : {}),
      version: record.conflictedWithVersion,
      conflictedWithVersion: undefined,
      dirty: true,
      revision: record.revision + 1,
      lastWriterTab: this.tabId,
    });

    await this.cache.dropContended(id, this.tabId);
    this.awaitingResolution.delete(id);
    this.knownRevision.set(id, record.revision + 1);
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
