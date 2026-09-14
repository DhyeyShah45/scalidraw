import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";
import { SceneCache, WorkspaceStore, createMemoryKV } from "../data/workspace";
import { FakeWorkspaceServer } from "../data/workspace/testFakes";

import {
  MIGRATION_FLAG,
  hasMigrated,
  migrateLegacyScene,
  readLegacyFiles,
  readLegacyScene,
} from "./migration";

const rect = (id: string) =>
  ({
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  } as unknown as ExcalidrawElement);

const imageElement = (id: string, fileId: string) =>
  ({
    id,
    type: "image",
    fileId,
    status: "saved",
  } as unknown as ExcalidrawElement);

const seedLegacyScene = (elements: unknown[], appState: object = {}) => {
  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
    JSON.stringify(elements),
  );
  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
    JSON.stringify(appState),
  );
};

describe("reading the legacy scene", () => {
  beforeEach(() => localStorage.clear());

  it("finds a stored scene", () => {
    seedLegacyScene([rect("a")], { viewBackgroundColor: "#eee" });
    expect(readLegacyScene()?.elements).toHaveLength(1);
  });

  it("treats an empty canvas as nothing to migrate", () => {
    seedLegacyScene([]);
    expect(readLegacyScene()).toBeNull();
  });

  it("returns nothing when the app was never used before", () => {
    expect(readLegacyScene()).toBeNull();
  });
});

describe("reading legacy images", () => {
  it("takes only the images the scene actually references", async () => {
    const kv = createMemoryKV();
    await kv.set("used", { id: "used", dataURL: "data:image/png;base64,AA" });
    await kv.set("orphan", {
      id: "orphan",
      dataURL: "data:image/png;base64,BB",
    });

    const files = await readLegacyFiles([imageElement("el", "used")], kv);

    // The legacy store accumulated images from scenes that no longer exist.
    expect(Object.keys(files)).toEqual(["used"]);
  });

  it("survives an unreadable image store", async () => {
    const kv = createMemoryKV();
    vi.spyOn(kv, "entries").mockRejectedValue(new Error("IDB unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Losing images is bad; losing the drawing would be worse.
    await expect(
      readLegacyFiles([imageElement("el", "used")], kv),
    ).resolves.toEqual({});
  });
});

describe("migrateLegacyScene", () => {
  let server: FakeWorkspaceServer;
  let store: WorkspaceStore;

  beforeEach(() => {
    localStorage.clear();
    server = new FakeWorkspaceServer();
    store = new WorkspaceStore({
      cache: new SceneCache(createMemoryKV()),
      api: server.api,
      flushDebounceMs: 100_000,
    });
  });

  const run = (overrides = {}) =>
    migrateLegacyScene({
      store,
      uploadFiles: async () => {},
      readFiles: async () => ({}),
      ...overrides,
    });

  it("creates a document from the old scene and uploads it", async () => {
    seedLegacyScene([rect("a"), rect("b")], { gridSize: 40 });

    const result = await run();

    expect(result.migrated).toBe(true);
    const stored = server.scenes.get(
      result.migrated ? result.document.id : "",
    )!;
    expect(stored.elements).toHaveLength(2);
    expect(stored.meta.name).toBe("Imported canvas");
  });

  it("never runs twice", async () => {
    seedLegacyScene([rect("a")]);
    await run();

    const second = await run();

    expect(second).toEqual({ migrated: false, reason: "already-done" });
    expect(server.scenes.size).toBe(1);
  });

  it("leaves the original localStorage scene untouched", async () => {
    seedLegacyScene([rect("a")]);
    await run();

    // It may be the only copy, so the import never deletes it.
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toContain(
      '"a"',
    );
  });

  it("flags an empty canvas as done without creating a document", async () => {
    const result = await run();

    expect(result).toEqual({ migrated: false, reason: "nothing-to-migrate" });
    expect(server.scenes.size).toBe(0);
    expect(hasMigrated()).toBe(true);
  });

  it("carries images across, addressed to the new document", async () => {
    seedLegacyScene([imageElement("el", "file-1")]);
    const uploads: string[] = [];

    const result = await run({
      readFiles: async () => ({
        "file-1": {
          id: "file-1",
          dataURL: "data:image/png;base64,AA",
        } as BinaryFileData,
      }),
      uploadFiles: async (
        _elements: readonly ExcalidrawElement[],
        files: { [id: string]: BinaryFileData },
      ) => {
        uploads.push(...Object.keys(files));
      },
    });

    expect(uploads).toEqual(["file-1"]);
    expect(result.migrated && result.imageCount).toBe(1);
  });

  it("does not flag itself done if the upload fails", async () => {
    seedLegacyScene([rect("a")]);
    server.offline = true;

    await expect(run()).rejects.toThrow();

    // Flagging early would strand the drawing: retried on the next boot.
    expect(localStorage.getItem(MIGRATION_FLAG)).toBeNull();
  });
});
