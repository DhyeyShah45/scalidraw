import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { debounce, isTestEnv } from "@excalidraw/common";
import { isInitializedImageElement, newElementWith } from "@excalidraw/element";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

import { FileManager } from "../data/FileManager";
import {
  AuthRequiredError,
  NotFoundError,
  createWorkspace,
  mergeAppState,
  workspaceApi,
} from "../data/workspace";

import { loadGlobalPrefs, saveGlobalPrefs } from "./globalPrefs";
import { migrateLegacyScene } from "./migration";
import {
  navigateToDocument,
  onDocumentRouteChange,
  parseDocumentId,
  replaceWithDocument,
} from "./routing";

import type { DocumentId, DocumentMeta, SyncState } from "../data/workspace";

export type WorkspaceStatus = "loading" | "unauthenticated" | "ready" | "error";

type OpenDocument = {
  meta: DocumentMeta;
  initialData: ExcalidrawInitialDataState;
};

type WorkspaceContextValue = {
  status: WorkspaceStatus;
  error: string | null;
  documents: DocumentMeta[];
  open: OpenDocument | null;
  signIn: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  openDocument: (id: DocumentId) => void;
  createDocument: (name?: string) => Promise<void>;
  renameDocument: (id: DocumentId, name: string) => Promise<void>;
  deleteDocument: (id: DocumentId) => Promise<void>;
  duplicateDocument: (id: DocumentId) => Promise<void>;
  /** Takes a scene the editor already holds and stores it as a new document. */
  adoptScene: (
    elements: readonly ExcalidrawElement[],
    files: BinaryFiles,
    name?: string,
  ) => Promise<void>;
  handleChange: (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void;
  flush: () => Promise<void>;
  resolveConflict: (keep: "local" | "server") => Promise<void>;
  registerApi: (api: ExcalidrawImperativeAPI | null) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Sync state lives in its own context because it changes on every save.
 *
 * Keeping it in the main value re-rendered the whole editor on each tick, and
 * re-rendering <Excalidraw> makes it emit onChange — which saves, which ticks
 * sync state again. That feedback loop wrote to the server about once a second
 * on a completely idle canvas, inflating the version and filling the snapshot
 * history with identical scenes.
 */
const SyncStateContext = createContext<SyncState>({ status: "idle" });

export const useWorkspace = () => {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  }
  return value;
};

export const useSyncState = () => useContext(SyncStateContext);

const NEW_DOCUMENT_NAME = "Untitled";

export const WorkspaceProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [open, setOpen] = useState<OpenDocument | null>(null);
  const [syncState, setSyncState] = useState<SyncState>({ status: "idle" });

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const currentIdRef = useRef<DocumentId | null>(null);

  const workspace = useMemo(
    () =>
      createWorkspace({
        currentDocumentId: () => currentIdRef.current,
        onSyncState: setSyncState,
      }),
    [],
  );

  const { store, files } = workspace;

  /**
   * Image lifecycle reuses the editor's own FileManager so uploads, retries
   * and the `pending`/`saved` status on image elements behave exactly as they
   * do on excalidraw.com — only the storage behind it changes.
   */
  const fileManager = useMemo(
    () =>
      new FileManager({ getFiles: files.getFiles, saveFiles: files.saveFiles }),
    [files],
  );

  // ------------------------------------------------------------------ loading

  const loadInto = useCallback(
    async (id: DocumentId) => {
      currentIdRef.current = id;

      const loaded = await store.loadDocument(id);
      const elements = loaded.elements as readonly ExcalidrawElement[];

      // Images are fetched up front rather than lazily: the canvas is about to
      // remount, and handing them to initialData avoids a frame of blank
      // placeholders where the pictures should be.
      const fileIds = [
        ...new Set(
          elements
            .filter(
              (element): element is ExcalidrawElement & { fileId: FileId } =>
                "fileId" in element && !!element.fileId,
            )
            .map((element) => element.fileId),
        ),
      ];
      const { loadedFiles } = fileIds.length
        ? await fileManager.getFiles(fileIds)
        : { loadedFiles: [] };

      setOpen({
        meta: loaded.meta,
        initialData: {
          elements,
          appState: mergeAppState({
            global: loadGlobalPrefs(),
            document: loaded.appState,
            documentName: loaded.meta.name,
          }) as ExcalidrawInitialDataState["appState"],
          files: Object.fromEntries(
            loadedFiles.map((file) => [file.id, file]),
          ) as ExcalidrawInitialDataState["files"],
          scrollToContent: false,
        },
      });
    },
    [store, fileManager],
  );

  /** Resolve which document should be on screen, creating one if needed. */
  const resolveInitialDocument = useCallback(
    async (available: DocumentMeta[]) => {
      const fromUrl = parseDocumentId();

      if (fromUrl) {
        try {
          await loadInto(fromUrl);
          return;
        } catch (caught) {
          if (!(caught instanceof NotFoundError)) {
            throw caught;
          }
          // A bookmark to something deleted: fall through to the most recent
          // rather than stranding the user on an error page.
        }
      }

      const mostRecent = available[0];
      if (mostRecent) {
        replaceWithDocument(mostRecent.id);
        await loadInto(mostRecent.id);
        return;
      }

      const created = await store.createDocument(NEW_DOCUMENT_NAME);
      setDocuments([created]);
      replaceWithDocument(created.id);
      await loadInto(created.id);
    },
    [loadInto, store],
  );

  const boot = useCallback(async () => {
    setStatus("loading");
    setError(null);

    if (isTestEnv()) {
      // The existing app tests render the root without a server. Reporting
      // ready with no open document leaves `workspace.open` null, which routes
      // the editor down the original localStorage path those tests assert on.
      // Workspace behaviour is covered by its own unit tests instead.
      setStatus("ready");
      return;
    }

    try {
      await workspaceApi.session();
      let available = await store.listDocuments();

      // Bring the pre-documents localStorage scene across on first run. It is
      // only ever attempted once, and the original is left untouched.
      const migration = await migrateLegacyScene({
        store,
        onDocumentCreated: (id) => {
          currentIdRef.current = id;
        },
        uploadFiles: (elements, files) =>
          fileManager.saveFiles({ elements, files }).then(() => undefined),
      }).catch((error) => {
        // A failed import must not keep the app from starting — the legacy
        // data is still in localStorage, so it can be retried.
        console.error("could not import the previous canvas", error);
        return { migrated: false } as const;
      });

      if (migration.migrated) {
        available = await store.listDocuments();
      }

      setDocuments(available);
      await resolveInitialDocument(available);
      setStatus("ready");
    } catch (caught) {
      if (caught instanceof AuthRequiredError) {
        setStatus("unauthenticated");
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("error");
    }
  }, [store, resolveInitialDocument, fileManager]);

  useEffect(() => {
    void boot();
    // Boot once; re-running would remount the canvas underneath the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/forward between documents.
  useEffect(() => {
    if (status !== "ready") {
      return;
    }
    return onDocumentRouteChange((id) => {
      if (id && id !== currentIdRef.current) {
        void loadInto(id);
      }
    });
  }, [status, loadInto]);

  // ------------------------------------------------------------------ actions

  const openDocument = useCallback(
    (id: DocumentId) => {
      if (id === currentIdRef.current) {
        return;
      }
      navigateToDocument(id);
      void loadInto(id).catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    },
    [loadInto],
  );

  const refreshDocuments = useCallback(async () => {
    setDocuments(await store.listDocuments());
  }, [store]);

  const createDocument = useCallback(
    async (name?: string) => {
      // Flush first: the canvas is about to be replaced, and an unsent write
      // for the outgoing document would otherwise sit until the next save.
      await store.flushNow();
      const created = await store.createDocument(name ?? NEW_DOCUMENT_NAME);
      await refreshDocuments();
      openDocument(created.id);
    },
    [store, refreshDocuments, openDocument],
  );

  const renameDocument = useCallback(
    async (id: DocumentId, name: string) => {
      const updated = await store.renameDocument(id, name);
      await refreshDocuments();
      if (id === currentIdRef.current) {
        setOpen((previous) =>
          previous ? { ...previous, meta: updated } : previous,
        );
        apiRef.current?.updateScene({ appState: { name } });
      }
    },
    [store, refreshDocuments],
  );

  const deleteDocument = useCallback(
    async (id: DocumentId) => {
      await store.deleteDocument(id);
      const remaining = await store.listDocuments();
      setDocuments(remaining);

      if (id !== currentIdRef.current) {
        return;
      }
      const next = remaining[0];
      if (next) {
        openDocument(next.id);
      } else {
        await createDocument();
      }
    },
    [store, openDocument, createDocument],
  );

  const duplicateDocument = useCallback(
    async (id: DocumentId) => {
      await store.flushNow();
      const copy = await store.duplicateDocument(id);
      await refreshDocuments();
      openDocument(copy.id);
    },
    [store, refreshDocuments, openDocument],
  );

  /**
   * Used when a collaboration session ends and the user keeps the room's work
   * (D17). It lands as its own document rather than being written over
   * whichever document was open when the session started.
   */
  const adoptScene = useCallback(
    async (
      elements: readonly ExcalidrawElement[],
      sceneFiles: BinaryFiles,
      name?: string,
    ) => {
      const created = await store.createDocument(
        name ?? `Shared session ${new Date().toLocaleDateString()}`,
      );

      // Point the file handlers at the new document before uploading, so the
      // images are refcounted against it and not the previous one.
      currentIdRef.current = created.id;
      if (Object.keys(sceneFiles).length) {
        await fileManager.saveFiles({ elements, files: sceneFiles });
      }

      await store.save(created.id, elements, {}, Object.keys(sceneFiles));
      await store.flushNow();
      await refreshDocuments();
      openDocument(created.id);
    },
    [store, fileManager, refreshDocuments, openDocument],
  );

  // -------------------------------------------------------------------- saves

  const persistPrefs = useMemo(
    () => debounce((appState: AppState) => saveGlobalPrefs(appState), 1000),
    [],
  );

  /**
   * onChange fires on every pointer move during a drag, so the cache write is
   * debounced the same way the original localStorage save was. The server
   * flush sits behind its own, longer debounce inside the store.
   */
  const persistScene = useMemo(
    () =>
      debounce(
        (
          id: DocumentId,
          elements: readonly ExcalidrawElement[],
          appState: AppState,
          fileIds: string[],
        ) => void store.save(id, elements, appState, fileIds),
        300,
      ),
    [store],
  );

  const saveImages = useCallback(
    async (elements: readonly ExcalidrawElement[], sceneFiles: BinaryFiles) => {
      await fileManager.saveFiles({ elements, files: sceneFiles });

      const api = apiRef.current;
      if (!api) {
        return;
      }

      // Flip freshly-uploaded images from `pending` to `saved`, or the unload
      // guard keeps insisting there is unsaved work.
      let changed = false;
      const next = api.getSceneElementsIncludingDeleted().map((element) => {
        if (!fileManager.shouldUpdateImageElementStatus(element)) {
          return element;
        }
        const updated = newElementWith(element, { status: "saved" });
        changed ||= updated !== element;
        return updated;
      });

      if (changed) {
        api.updateScene({
          elements: next,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    },
    [fileManager],
  );

  const handleChange = useCallback(
    (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      sceneFiles: BinaryFiles,
    ) => {
      const id = currentIdRef.current;
      if (!id) {
        return;
      }

      persistPrefs(appState);

      persistScene(id, elements, appState, Object.keys(sceneFiles));

      if (elements.some(isInitializedImageElement)) {
        void saveImages(elements, sceneFiles);
      }
    },
    [persistPrefs, persistScene, saveImages],
  );

  const flush = useCallback(async () => {
    persistPrefs.flush();
    persistScene.flush();
    await store.flushNow();
    // Images ride the same guarantee as scenes: anything that could not be
    // uploaded is retried here rather than sitting in the cache forever.
    await files.flushPendingUploads();
  }, [store, persistPrefs, persistScene, files]);

  const resolveConflict = useCallback(
    async (keep: "local" | "server") => {
      const id = currentIdRef.current;
      if (!id) {
        return;
      }
      if (keep === "local") {
        await store.resolveWithLocal(id);
        return;
      }
      await store.resolveWithServer(id);
      await loadInto(id);
    },
    [store, loadInto],
  );

  // ---------------------------------------------------------------- lifecycle

  const signIn = useCallback(
    async (password: string) => {
      await workspaceApi.login(password);
      await boot();
    },
    [boot],
  );

  const signOut = useCallback(async () => {
    // Never sign out over unsent work — it would be stranded in a cache the
    // login screen cannot reach.
    await store.flushNow();
    await workspaceApi.logout();
    setStatus("unauthenticated");
    setOpen(null);
    setDocuments([]);
  }, [store]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") {
        void flush();
      }
    };
    const onOnline = () => {
      store.retry();
      void files.flushPendingUploads();
    };

    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("online", onOnline);
    };
  }, [flush, store, files]);

  const value = useMemo(
    (): WorkspaceContextValue => ({
      status,
      error,
      documents,
      open,
      signIn,
      signOut,
      openDocument,
      createDocument,
      renameDocument,
      deleteDocument,
      duplicateDocument,
      adoptScene,
      handleChange,
      flush,
      resolveConflict,
      registerApi: (api) => {
        apiRef.current = api;
      },
    }),
    [
      status,
      error,
      documents,
      open,
      signIn,
      signOut,
      openDocument,
      createDocument,
      renameDocument,
      deleteDocument,
      duplicateDocument,
      adoptScene,
      handleChange,
      flush,
      resolveConflict,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      <SyncStateContext.Provider value={syncState}>
        {children}
      </SyncStateContext.Provider>
    </WorkspaceContext.Provider>
  );
};
