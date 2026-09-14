import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { NetworkError } from "./api";
import { createFileHandlers } from "./fileStore";
import { createMemoryKV } from "./kv";
import { FakeWorkspaceServer } from "./testFakes";

import type { KVStore } from "./kv";

const file = (id: string): BinaryFileData => ({
  id: id as FileId,
  mimeType: "image/png",
  dataURL: `data:image/png;base64,${id}` as BinaryFileData["dataURL"],
  created: 1,
});

describe("file handlers", () => {
  let cache: KVStore;
  let server: FakeWorkspaceServer;

  beforeEach(() => {
    cache = createMemoryKV();
    server = new FakeWorkspaceServer();
  });

  const handlers = (documentId: string | null = "doc-1") =>
    createFileHandlers({
      currentDocumentId: () => documentId,
      cache,
      api: server.api,
    });

  it("uploads against the open document, keeping the server refcount honest", async () => {
    const upload = vi.spyOn(server.api, "uploadFiles");
    const added = new Map([["f1" as FileId, file("f1")]]);

    const result = await handlers("doc-42").saveFiles({ addedFiles: added });

    expect(upload).toHaveBeenCalledWith("doc-42", [
      { id: "f1", dataURL: "data:image/png;base64,f1", created: 1 },
    ]);
    expect([...result.savedFiles.keys()]).toEqual(["f1"]);
  });

  it("caches an upload before it completes, so a reload keeps the image", async () => {
    server.api.uploadFiles = async () => {
      throw new NetworkError("offline");
    };

    const result = await handlers().saveFiles({
      addedFiles: new Map([["f1" as FileId, file("f1")]]),
    });

    // Upload failed...
    expect([...result.erroredFiles.keys()]).toEqual(["f1"]);
    // ...but the bytes are local, so the canvas still renders after a reload.
    expect(await cache.get("file:f1")).toMatchObject({ id: "f1" });
  });

  it("errors every file when there is no open document to attribute them to", async () => {
    const result = await handlers(null).saveFiles({
      addedFiles: new Map([["f1" as FileId, file("f1")]]),
    });
    expect(result.savedFiles.size).toBe(0);
    expect(result.erroredFiles.size).toBe(1);
  });

  it("serves from cache without hitting the network", async () => {
    await cache.set("file:f1", file("f1"));
    const fetchSpy = vi.spyOn(server.api, "fetchFiles");

    const result = await handlers().getFiles(["f1" as FileId]);

    expect(result.loadedFiles).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches what is missing and caches it for next time", async () => {
    server.api.fetchFiles = async (ids) => ({
      files: ids.map((id) => ({
        id,
        mimeType: "image/png",
        dataURL: `data:image/png;base64,${id}`,
        created: 1,
      })),
      missing: [],
    });

    const first = await handlers().getFiles(["f1" as FileId]);
    expect(first.loadedFiles).toHaveLength(1);
    expect(await cache.get("file:f1")).toBeDefined();

    const fetchSpy = vi.spyOn(server.api, "fetchFiles");
    await handlers().getFiles(["f1" as FileId]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports files the server does not have as errored", async () => {
    server.api.fetchFiles = async (ids) => ({ files: [], missing: ids });

    const result = await handlers().getFiles(["ghost" as FileId]);

    expect(result.loadedFiles).toHaveLength(0);
    expect(result.erroredFiles.get("ghost" as FileId)).toBe(true);
  });

  it("degrades to errored while offline without discarding the cache", async () => {
    await cache.set("file:cached", file("cached"));
    server.api.fetchFiles = async () => {
      throw new NetworkError("offline");
    };

    const result = await handlers().getFiles([
      "cached" as FileId,
      "remote" as FileId,
    ]);

    expect(result.loadedFiles.map((f) => f.id)).toEqual(["cached"]);
    expect(result.erroredFiles.get("remote" as FileId)).toBe(true);
  });
});

describe("image upload queue (closes the D11 gap for images)", () => {
  let cache: KVStore;
  let server: FakeWorkspaceServer;

  beforeEach(() => {
    cache = createMemoryKV();
    server = new FakeWorkspaceServer();
  });

  const handlers = (documentId: string | null = "doc-1") =>
    createFileHandlers({
      currentDocumentId: () => documentId,
      cache,
      api: server.api,
    });

  const goOffline = () => {
    server.api.uploadFiles = async () => {
      throw new NetworkError("offline");
    };
  };

  it("queues an upload that could not reach the server", async () => {
    goOffline();

    await handlers().saveFiles({
      addedFiles: new Map([["f1" as FileId, file("f1")]]),
    });

    expect(await handlers().pendingUploadCount()).toBe(1);
  });

  it("uploads the backlog once the server is reachable again", async () => {
    goOffline();
    await handlers().saveFiles({
      addedFiles: new Map([["f1" as FileId, file("f1")]]),
    });

    const uploads: { documentId: string; ids: string[] }[] = [];
    server.api.uploadFiles = async (documentId, files) => {
      uploads.push({ documentId, ids: files.map((f) => f.id) });
      return { saved: files.map((f) => f.id), rejected: [] };
    };

    const result = await handlers().flushPendingUploads();

    expect(result.uploaded).toEqual(["f1"]);
    expect(uploads).toEqual([{ documentId: "doc-1", ids: ["f1"] }]);
    expect(await handlers().pendingUploadCount()).toBe(0);
  });

  it("survives a reload, because the queue lives in the cache", async () => {
    goOffline();
    await handlers().saveFiles({
      addedFiles: new Map([["f1" as FileId, file("f1")]]),
    });

    // A fresh set of handlers over the same cache — the browser restarting.
    const revived = createFileHandlers({
      currentDocumentId: () => "doc-1",
      cache,
      api: new FakeWorkspaceServer().api,
    });

    expect(await revived.pendingUploadCount()).toBe(1);
  });

  it("attributes each queued image to the document it came from", async () => {
    goOffline();
    await handlers("doc-a").saveFiles({
      addedFiles: new Map([["fa" as FileId, file("fa")]]),
    });
    await handlers("doc-b").saveFiles({
      addedFiles: new Map([["fb" as FileId, file("fb")]]),
    });

    const seen = new Map<string, string[]>();
    server.api.uploadFiles = async (documentId, files) => {
      seen.set(
        documentId,
        files.map((f) => f.id),
      );
      return { saved: files.map((f) => f.id), rejected: [] };
    };

    await handlers().flushPendingUploads();

    // Uploading to the wrong document would corrupt the server refcount.
    expect(seen.get("doc-a")).toEqual(["fa"]);
    expect(seen.get("doc-b")).toEqual(["fb"]);
  });

  it("keeps the queue intact when the retry also fails", async () => {
    goOffline();
    await handlers().saveFiles({
      addedFiles: new Map([["f1" as FileId, file("f1")]]),
    });

    const result = await handlers().flushPendingUploads();

    expect(result.uploaded).toEqual([]);
    expect(result.stillPending).toBe(1);
  });

  it("does not queue a file the server actively rejected", async () => {
    server.api.uploadFiles = async () => ({
      saved: [],
      rejected: [{ id: "f1", reason: "too large" }],
    });

    await handlers().saveFiles({
      addedFiles: new Map([["f1" as FileId, file("f1")]]),
    });

    // Retrying would fail identically; this one is genuinely errored.
    expect(await handlers().pendingUploadCount()).toBe(0);
  });

  it("drops a marker whose bytes are gone rather than retrying forever", async () => {
    goOffline();
    await handlers().saveFiles({
      addedFiles: new Map([["f1" as FileId, file("f1")]]),
    });
    await cache.delete("file:f1");

    server.api.uploadFiles = async (_documentId, files) => ({
      saved: files.map((f) => f.id),
      rejected: [],
    });

    const result = await handlers().flushPendingUploads();

    expect(result.uploaded).toEqual([]);
    expect(result.stillPending).toBe(0);
  });
});
