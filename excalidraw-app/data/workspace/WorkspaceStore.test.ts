import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { NotFoundError } from "./api";
import { createMemoryKV } from "./kv";
import { SceneCache } from "./sceneCache";
import { FakeWorkspaceServer } from "./testFakes";
import { WorkspaceStore } from "./WorkspaceStore";

import type { SyncState } from "./types";

const element = (id: string) =>
  ({ id, type: "rectangle" } as ExcalidrawElement);

describe("WorkspaceStore", () => {
  let server: FakeWorkspaceServer;
  let cache: SceneCache;
  let states: SyncState[];
  let store: WorkspaceStore;

  const build = () => {
    server = new FakeWorkspaceServer();
    cache = new SceneCache(createMemoryKV());
    states = [];
    store = new WorkspaceStore({
      cache,
      api: server.api,
      // Long enough that nothing fires on its own; tests drive flushNow().
      flushDebounceMs: 100_000,
      onSyncState: (state) => states.push(state),
    });
  };

  beforeEach(build);

  describe("saving", () => {
    it("pushes a save to the server and advances the version", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");

      await store.save("doc-1", [element("a")], {});
      await store.flushNow();

      expect(server.scenes.get("doc-1")!.elements).toEqual([element("a")]);
      expect(server.scenes.get("doc-1")!.meta.version).toBe(2);
      expect(await store.pendingCount()).toBe(0);
    });

    it("sends the base version it last saw, not a guess", async () => {
      server.seed("doc-1", { version: 7 });
      await store.loadDocument("doc-1");

      await store.save("doc-1", [element("a")], {});
      await store.flushNow();

      expect(server.putCalls).toEqual([{ id: "doc-1", baseVersion: 7 }]);
    });

    it("collapses a burst of edits into a single request", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");

      for (let i = 0; i < 25; i++) {
        await store.save("doc-1", [element(`el-${i}`)], {});
      }
      await store.flushNow();

      // The queue is the dirty flag, so 25 edits are one PUT of the latest.
      expect(server.putCalls).toHaveLength(1);
      expect(server.scenes.get("doc-1")!.elements).toEqual([element("el-24")]);
    });

    it("stores only the per-document half of appState", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");

      await store.save("doc-1", [], {
        zoom: { value: 2 as never },
        scrollX: 40,
        gridSize: 30,
        currentItemStrokeColor: "#ff0000",
      });
      await store.flushNow();

      const saved = server.scenes.get("doc-1")!.appState;
      expect(saved).toMatchObject({ scrollX: 40, gridSize: 30 });
      // Device preference — must not travel with the document (D13).
      expect(saved).not.toHaveProperty("currentItemStrokeColor");
    });
  });

  describe("offline queue (D11)", () => {
    it("keeps the write and reports pending rather than throwing", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");

      server.offline = true;
      await store.save("doc-1", [element("a")], {});
      await store.flushNow();

      expect(await store.pendingCount()).toBe(1);
      expect(states.at(-1)).toEqual({ status: "offline", pending: 1 });
      expect(server.scenes.get("doc-1")!.elements).toEqual([]);
    });

    it("drains the queue on reconnect", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");

      server.offline = true;
      await store.save("doc-1", [element("a")], {});
      await store.flushNow();

      server.offline = false;
      await store.flushNow();

      expect(await store.pendingCount()).toBe(0);
      expect(server.scenes.get("doc-1")!.elements).toEqual([element("a")]);
      expect(states.at(-1)).toEqual({ status: "idle" });
    });

    it("survives a page reload, because the queue lives in the cache", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");

      server.offline = true;
      await store.save("doc-1", [element("survivor")], {});
      await store.flushNow();

      // New store over the SAME cache — the browser restarting while offline.
      const revived = new WorkspaceStore({
        cache,
        api: server.api,
        flushDebounceMs: 100_000,
      });
      server.offline = false;
      await revived.flushNow();

      expect(server.scenes.get("doc-1")!.elements).toEqual([
        element("survivor"),
      ]);
    });

    it("queues writes for several documents independently", async () => {
      server.seed("doc-1");
      server.seed("doc-2");
      await store.loadDocument("doc-1");
      await store.loadDocument("doc-2");

      server.offline = true;
      await store.save("doc-1", [element("a")], {});
      await store.save("doc-2", [element("b")], {});
      await store.flushNow();
      expect(await store.pendingCount()).toBe(2);

      server.offline = false;
      await store.flushNow();

      expect(server.scenes.get("doc-1")!.elements).toEqual([element("a")]);
      expect(server.scenes.get("doc-2")!.elements).toEqual([element("b")]);
    });

    it("renders from cache when the server is unreachable", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");
      await store.save("doc-1", [element("cached")], {});
      await store.flushNow();

      server.offline = true;
      const loaded = await store.loadDocument("doc-1");

      expect(loaded.fromCache).toBe(true);
      expect(loaded.elements).toEqual([element("cached")]);
    });

    it("refuses to invent a document when there is no cache and no server", async () => {
      server.offline = true;
      await expect(store.loadDocument("never-seen")).rejects.toThrow(
        /unavailable offline/,
      );
    });
  });

  describe("conflicts (D9)", () => {
    const setupConflict = async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");
      server.writeElsewhere("doc-1");

      await store.save("doc-1", [element("mine")], {});
      await store.flushNow();
    };

    it("reports the conflict and keeps the local write queued", async () => {
      await setupConflict();

      expect(states.at(-1)).toEqual({
        status: "conflict",
        documentId: "doc-1",
        serverVersion: 2,
      });
      // The user's work is still here — this is the whole point.
      expect(await store.pendingCount()).toBe(1);
      expect((await cache.get("doc-1"))!.elements).toEqual([element("mine")]);
    });

    it("does not retry a conflicted document in later flushes", async () => {
      await setupConflict();
      const callsAfterConflict = server.putCalls.length;

      await store.flushNow();
      await store.flushNow();

      // Retrying would just collect 409s forever and mask the prompt.
      expect(server.putCalls).toHaveLength(callsAfterConflict);
    });

    it("resolveWithLocal re-bases onto the server version and wins", async () => {
      await setupConflict();

      await store.resolveWithLocal("doc-1");

      expect(server.scenes.get("doc-1")!.elements).toEqual([element("mine")]);
      expect(server.scenes.get("doc-1")!.meta.version).toBe(3);
      expect(await store.pendingCount()).toBe(0);
    });

    it("resolveWithServer discards the local write and returns the server copy", async () => {
      await setupConflict();
      const replaced = vi.fn();
      const withCallback = new WorkspaceStore({
        cache,
        api: server.api,
        flushDebounceMs: 100_000,
        onDocumentReplaced: replaced,
      });

      const loaded = await withCallback.resolveWithServer("doc-1");

      expect(loaded.elements).toEqual([{ id: "from-other-device" }]);
      expect(await store.pendingCount()).toBe(0);
      expect(replaced).toHaveBeenCalledOnce();
    });
  });

  describe("session loss (D24)", () => {
    it("keeps the write queued and asks for a sign-in", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");

      server.signedOut = true;
      await store.save("doc-1", [element("a")], {});
      await store.flushNow();

      expect(states.at(-1)).toEqual({ status: "auth-required" });
      expect(await store.pendingCount()).toBe(1);
    });

    it("resumes the same write after signing back in", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");

      server.signedOut = true;
      await store.save("doc-1", [element("a")], {});
      await store.flushNow();

      server.signedOut = false;
      await store.flushNow();

      expect(server.scenes.get("doc-1")!.elements).toEqual([element("a")]);
      expect(await store.pendingCount()).toBe(0);
    });
  });

  describe("loading", () => {
    it("prefers unsynced local edits over the server copy", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");

      server.offline = true;
      await store.save("doc-1", [element("unsynced")], {});
      await store.flushNow();

      server.offline = false;
      server.writeElsewhere("doc-1");
      const loaded = await store.loadDocument("doc-1");

      // A background refresh must never silently eat queued work.
      expect(loaded.elements).toEqual([element("unsynced")]);
      expect(loaded.fromCache).toBe(true);
    });

    it("takes the server copy when nothing local is pending", async () => {
      server.seed("doc-1");
      await store.loadDocument("doc-1");

      server.writeElsewhere("doc-1");
      const loaded = await store.loadDocument("doc-1");

      expect(loaded.elements).toEqual([{ id: "from-other-device" }]);
      expect(loaded.fromCache).toBe(false);
    });
  });

  describe("document lifecycle", () => {
    it("creates, renames, duplicates and deletes", async () => {
      const created = await store.createDocument("Ideas");
      expect(created.name).toBe("Ideas");

      await store.save(created.id, [element("a")], {});
      await store.flushNow();

      const renamed = await store.renameDocument(created.id, "Better ideas");
      expect(renamed.name).toBe("Better ideas");

      const copy = await store.duplicateDocument(created.id);
      expect(copy.name).toBe("Better ideas (copy)");

      await store.deleteDocument(created.id);
      expect(await cache.get(created.id)).toBeUndefined();
      expect(server.scenes.has(created.id)).toBe(false);
    });
  });
});

describe("WorkspaceStore — queue robustness", () => {
  let server: FakeWorkspaceServer;
  let cache: SceneCache;
  let store: WorkspaceStore;
  let states: SyncState[];

  beforeEach(() => {
    server = new FakeWorkspaceServer();
    cache = new SceneCache(createMemoryKV());
    states = [];
    store = new WorkspaceStore({
      cache,
      api: server.api,
      flushDebounceMs: 100_000,
      onSyncState: (state) => states.push(state),
    });
  });

  const seedAndOpen = async (id: string) => {
    server.seed(id);
    await store.loadDocument(id);
  };

  it("does not let one broken document block the rest of the queue", async () => {
    await seedAndOpen("doc-good");
    await seedAndOpen("doc-broken");

    // Oldest-first ordering means the broken one is attempted first; before
    // the fix it returned "stop" and the healthy document never synced.
    await store.save("doc-broken", [element("x")], {});
    await store.save("doc-good", [element("y")], {});

    const realPut = server.api.putScene;
    server.api.putScene = async (id, base, payload) => {
      if (id === "doc-broken") {
        throw new Error("500 internal server error");
      }
      return realPut(id, base, payload);
    };

    await store.flushNow();

    expect(server.scenes.get("doc-good")!.elements).toEqual([element("y")]);
  });

  it("gives up on a document after repeated failures instead of spinning", async () => {
    await seedAndOpen("doc-1");
    await store.save("doc-1", [element("a")], {});
    server.api.putScene = async () => {
      throw new Error("permanently broken");
    };

    for (let i = 0; i < 8; i++) {
      await store.flushNow();
    }

    // Still held locally — giving up on pushing is not the same as discarding.
    expect((await cache.get("doc-1"))!.dirty).toBe(true);
    expect((await cache.get("doc-1"))!.failures).toBe(SceneCache.MAX_FAILURES);
  });

  it("retries a given-up document as soon as it is edited again", async () => {
    await seedAndOpen("doc-1");
    await store.save("doc-1", [element("a")], {});
    const realPut = server.api.putScene;
    server.api.putScene = async () => {
      throw new Error("broken");
    };
    for (let i = 0; i < 8; i++) {
      await store.flushNow();
    }

    server.api.putScene = realPut;
    await store.save("doc-1", [element("b")], {});
    await store.flushNow();

    expect(server.scenes.get("doc-1")!.elements).toEqual([element("b")]);
  });

  it("drops a document deleted on another device rather than retrying forever", async () => {
    await seedAndOpen("doc-1");
    await store.save("doc-1", [element("a")], {});

    server.scenes.delete("doc-1");
    server.api.putScene = async () => {
      throw new NotFoundError("gone");
    };

    await store.flushNow();

    expect(await cache.get("doc-1")).toBeUndefined();
    expect(await store.pendingCount()).toBe(0);
  });

  it("keeps an edit that lands while a push is in flight", async () => {
    await seedAndOpen("doc-1");
    await store.save("doc-1", [element("first")], {});

    // Slip a second edit in between the request going out and it resolving.
    const realPut = server.api.putScene;
    server.api.putScene = async (id, base, payload) => {
      const result = await realPut(id, base, payload);
      await store.save("doc-1", [element("second")], {});
      return result;
    };

    await store.flushNow();
    server.api.putScene = realPut;

    // Before the revision guard, the settle wrote `dirty: false` over the
    // second edit and it was never sent to the server at all.
    const record = await cache.get("doc-1");
    expect(record!.elements).toEqual([element("second")]);
    expect(record!.dirty).toBe(true);

    await store.flushNow();
    expect(server.scenes.get("doc-1")!.elements).toEqual([element("second")]);
  });

  it("reports a cache failure instead of dying silently", async () => {
    await seedAndOpen("doc-1");
    vi.spyOn(cache, "pending").mockRejectedValueOnce(
      new Error("QuotaExceededError"),
    );

    await store.flushNow();

    expect(states.at(-1)).toMatchObject({ status: "error" });
  });

  it("does not destroy both copies if the server drops mid-resolution", async () => {
    await seedAndOpen("doc-1");
    server.writeElsewhere("doc-1");
    await store.save("doc-1", [element("mine")], {});
    await store.flushNow();

    server.offline = true;
    await expect(store.resolveWithServer("doc-1")).rejects.toThrow();

    // The local copy must survive a failed resolution attempt.
    expect((await cache.get("doc-1"))!.elements).toEqual([element("mine")]);
  });
});

describe("two tabs on the same document", () => {
  let server: FakeWorkspaceServer;
  let cache: SceneCache;

  /** Separate store instances over ONE cache — that is what two tabs are. */
  const openTab = (states?: SyncState[]) =>
    new WorkspaceStore({
      cache,
      api: server.api,
      flushDebounceMs: 100_000,
      onSyncState: (state) => states?.push(state),
    });

  beforeEach(async () => {
    server = new FakeWorkspaceServer();
    cache = new SceneCache(createMemoryKV());
    server.seed("doc-1");
  });

  it("refuses to silently overwrite the other tab's work", async () => {
    const tabA = openTab();
    const bStates: SyncState[] = [];
    const tabB = openTab(bStates);

    await tabA.loadDocument("doc-1");
    await tabB.loadDocument("doc-1");

    await tabA.save("doc-1", [element("from-a")], {});
    await tabB.save("doc-1", [element("from-b")], {});

    // Sharing a cache record means they share a `version` too, so the
    // server's If-Match check cannot see them diverge — without this guard
    // B's save would just replace A's with nothing to catch it.
    expect(bStates.at(-1)).toMatchObject({
      status: "conflict",
      documentId: "doc-1",
    });
    expect((await cache.get("doc-1"))!.elements).toEqual([element("from-a")]);
  });

  it("lets a single tab save repeatedly without ever conflicting", async () => {
    const states: SyncState[] = [];
    const tab = openTab(states);
    await tab.loadDocument("doc-1");

    for (let i = 0; i < 5; i++) {
      await tab.save("doc-1", [element(`el-${i}`)], {});
    }
    await tab.flushNow();

    expect(states.some((state) => state.status === "conflict")).toBe(false);
    expect(server.scenes.get("doc-1")!.elements).toEqual([element("el-4")]);
  });

  it("does not conflict after a reload, which is a new tab id", async () => {
    const first = openTab();
    await first.loadDocument("doc-1");
    await first.save("doc-1", [element("a")], {});
    await first.flushNow();

    // Same browser, fresh page: new store, new tab id, same cache.
    const states: SyncState[] = [];
    const reloaded = openTab(states);
    await reloaded.loadDocument("doc-1");
    await reloaded.save("doc-1", [element("b")], {});

    expect(states.some((state) => state.status === "conflict")).toBe(false);
  });

  it("the losing tab can keep its own version", async () => {
    const tabA = openTab();
    const tabB = openTab();
    await tabA.loadDocument("doc-1");
    await tabB.loadDocument("doc-1");

    await tabA.save("doc-1", [element("from-a")], {});
    await tabA.flushNow();
    await tabB.save("doc-1", [element("from-b")], {});

    await tabB.save("doc-1", [element("from-b")], {});
    await tabB.resolveWithLocal("doc-1");
    await tabB.flushNow();

    expect(server.scenes.get("doc-1")!.elements).toEqual([element("from-b")]);
  });
});

describe("WorkspaceStore — no-op writes", () => {
  let server: FakeWorkspaceServer;
  let cache: SceneCache;
  let store: WorkspaceStore;

  beforeEach(() => {
    server = new FakeWorkspaceServer();
    cache = new SceneCache(createMemoryKV());
    store = new WorkspaceStore({
      cache,
      api: server.api,
      flushDebounceMs: 100_000,
    });
  });

  /*
   * Opening a document fires onChange, which looks exactly like an edit. If
   * that reaches the server the version bumps for content nobody changed, and
   * every other device holding the document is told it "changed elsewhere".
   * Observed in a real browser as a save roughly once a second on an idle
   * canvas.
   */
  it("does not push content identical to what the server holds", async () => {
    server.seed("doc-1");
    const loaded = await store.loadDocument("doc-1");

    await store.save("doc-1", loaded.elements, loaded.appState);
    await store.flushNow();

    expect(server.putCalls).toHaveLength(0);
    expect(server.scenes.get("doc-1")!.meta.version).toBe(1);
  });

  it("still pushes once something genuinely changes", async () => {
    server.seed("doc-1");
    const loaded = await store.loadDocument("doc-1");

    await store.save("doc-1", loaded.elements, loaded.appState);
    await store.flushNow();
    await store.save("doc-1", [element("new")], {});
    await store.flushNow();

    expect(server.putCalls).toHaveLength(1);
    expect(server.scenes.get("doc-1")!.elements).toEqual([element("new")]);
  });

  it("treats a viewport-only change as a real change", async () => {
    server.seed("doc-1");
    const loaded = await store.loadDocument("doc-1");

    await store.save("doc-1", loaded.elements, { scrollX: 250 });
    await store.flushNow();

    expect(server.putCalls).toHaveLength(1);
  });

  it("does not suppress a write that is still queued", async () => {
    server.seed("doc-1");
    const loaded = await store.loadDocument("doc-1");

    server.offline = true;
    await store.save("doc-1", [element("offline-edit")], {});
    await store.flushNow();

    // Same content again while the first is still pending must not be
    // mistaken for a no-op and drop the queued write.
    await store.save("doc-1", [element("offline-edit")], {});
    server.offline = false;
    await store.flushNow();

    expect(server.scenes.get("doc-1")!.elements).toEqual([
      element("offline-edit"),
    ]);
    expect(loaded.elements).toEqual([]);
  });
});

describe("two tabs — the losing tab's work must survive", () => {
  let server: FakeWorkspaceServer;
  let cache: SceneCache;

  const openTab = (states?: SyncState[]) =>
    new WorkspaceStore({
      cache,
      api: server.api,
      flushDebounceMs: 100_000,
      onSyncState: (state) => states?.push(state),
    });

  beforeEach(() => {
    server = new FakeWorkspaceServer();
    cache = new SceneCache(createMemoryKV());
    server.seed("doc-1");
  });

  /*
   * Seen in a real browser: both tabs drew, one tab's work vanished, and no
   * prompt ever appeared. Two causes — the shared record stays clean after the
   * winning tab syncs, so the next flush reported "idle" over the conflict
   * state; and the losing scene was discarded rather than parked, so even
   * "keep mine" would have pushed the other tab's content.
   */
  it("keeps the conflict visible instead of reporting idle", async () => {
    const tabA = openTab();
    const bStates: SyncState[] = [];
    const tabB = openTab(bStates);

    await tabA.loadDocument("doc-1");
    await tabB.loadDocument("doc-1");

    await tabA.save("doc-1", [element("from-a")], {});
    await tabA.flushNow();

    await tabB.save("doc-1", [element("from-b")], {});
    await tabB.flushNow();
    await tabB.flushNow();

    expect(bStates.at(-1)).toMatchObject({ status: "conflict" });
  });

  it("\"keep mine\" uploads THIS tab's scene, not the other tab's", async () => {
    const tabA = openTab();
    const tabB = openTab();

    await tabA.loadDocument("doc-1");
    await tabB.loadDocument("doc-1");

    await tabA.save("doc-1", [element("from-a")], {});
    await tabA.flushNow();

    await tabB.save("doc-1", [element("from-b")], {});
    await tabB.resolveWithLocal("doc-1");
    await tabB.flushNow();

    expect(server.scenes.get("doc-1")!.elements).toEqual([element("from-b")]);
  });

  it("parks the losing scene durably, so a reload does not lose it", async () => {
    const tabA = openTab();
    const tabB = openTab();
    await tabA.loadDocument("doc-1");
    await tabB.loadDocument("doc-1");

    await tabA.save("doc-1", [element("from-a")], {});
    await tabA.flushNow();
    await tabB.save("doc-1", [element("from-b")], {});

    // The parked copy lives in the cache, not in memory.
    const parked = await cache.getContended("doc-1", (tabB as any).tabId);
    expect(parked?.elements).toEqual([element("from-b")]);
  });

  it('"use theirs" discards the parked scene rather than leaving it behind', async () => {
    const tabA = openTab();
    const tabB = openTab();
    await tabA.loadDocument("doc-1");
    await tabB.loadDocument("doc-1");

    await tabA.save("doc-1", [element("from-a")], {});
    await tabA.flushNow();
    await tabB.save("doc-1", [element("from-b")], {});
    await tabB.resolveWithServer("doc-1");

    expect(
      await cache.getContended("doc-1", (tabB as any).tabId),
    ).toBeUndefined();
    expect(server.scenes.get("doc-1")!.elements).toEqual([element("from-a")]);
  });
});
