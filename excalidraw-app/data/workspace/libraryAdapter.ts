import type { LibraryPersistedData } from "@excalidraw/excalidraw/data/library";

import { AuthRequiredError, NetworkError, workspaceApi } from "./api";

import type { WorkspaceApi } from "./api";

/**
 * Server-backed shape library (D14).
 *
 * Drop-in for `LibraryIndexedDBAdapter` — pass it to `useHandleLibrary` as
 * `adapter`, keeping the IndexedDB one as `migrationAdapter` so an existing
 * local library is pulled up to the server on first run.
 *
 * Note `load()` is called on the save path too (the editor re-reads and unions
 * before writing, to avoid deleting items another client still holds), so this
 * caches the `"load"` source only.
 */
export const createServerLibraryAdapter = (
  api: WorkspaceApi = workspaceApi,
) => {
  let cached: { libraryItems: unknown[] } | null = null;

  return {
    load: async (metadata: { source: "load" | "save" }) => {
      if (metadata.source === "load" && cached) {
        return cached as never;
      }
      try {
        const payload = await api.getLibrary();
        cached = payload;
        return payload as never;
      } catch (error) {
        // A library that fails to load must not block the editor booting;
        // returning null just means "no items yet".
        if (
          error instanceof NetworkError ||
          error instanceof AuthRequiredError
        ) {
          return (cached ?? null) as never;
        }
        throw error;
      }
    },

    save: async (data: LibraryPersistedData) => {
      await api.putLibrary(data.libraryItems);
      cached = { libraryItems: [...data.libraryItems] };
    },
  };
};
