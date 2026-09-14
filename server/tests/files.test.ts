import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectOrphanFiles, purgeDocument } from "../src/db/documents";

import { PNG_DATA_URL, createHarness, makeElement } from "./helpers";

import type { Harness } from "./helpers";

describe("image files", () => {
  let harness: Harness;
  let cookies: { [key: string]: string };

  beforeEach(async () => {
    harness = await createHarness();
    cookies = await harness.auth();
  });
  afterEach(async () => harness.close());

  const createDocument = async () =>
    (
      await harness.app.inject({
        method: "POST",
        url: "/api/documents",
        cookies,
        payload: {},
      })
    ).json().document.id as string;

  const upload = (documentId: string, id: string) =>
    harness.app.inject({
      method: "POST",
      url: `/api/documents/${documentId}/files`,
      cookies,
      payload: { files: [{ id, dataURL: PNG_DATA_URL, created: 1234 }] },
    });

  it("stores raw bytes and rebuilds the dataURL on read", async () => {
    const documentId = await createDocument();
    expect((await upload(documentId, "file-a")).json().saved).toEqual([
      "file-a",
    ]);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/files/batch",
      cookies,
      payload: { ids: ["file-a"] },
    });

    expect(response.json().files[0]).toMatchObject({
      id: "file-a",
      mimeType: "image/png",
      dataURL: PNG_DATA_URL,
    });

    // Stored decoded, not as the +33% base64 string.
    const row = harness.db
      .prepare(`SELECT size FROM files WHERE id = ?`)
      .get("file-a") as { size: number };
    expect(row.size).toBeLessThan(PNG_DATA_URL.length);
  });

  it("reports missing ids instead of failing the batch", async () => {
    const documentId = await createDocument();
    await upload(documentId, "file-a");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/files/batch",
      cookies,
      payload: { ids: ["file-a", "ghost"] },
    });

    expect(response.json().files).toHaveLength(1);
    expect(response.json().missing).toEqual(["ghost"]);
  });

  it("rejects a malformed dataURL without poisoning the rest of the batch", async () => {
    const documentId = await createDocument();
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/documents/${documentId}/files`,
      cookies,
      payload: {
        files: [
          { id: "good", dataURL: PNG_DATA_URL },
          { id: "bad", dataURL: "not-a-data-url" },
        ],
      },
    });

    expect(response.json().saved).toEqual(["good"]);
    expect(response.json().rejected).toEqual([
      { id: "bad", reason: "malformed dataURL" },
    ]);
  });

  it("deduplicates identical content across documents but links both", async () => {
    const first = await createDocument();
    const second = await createDocument();
    await upload(first, "shared");
    await upload(second, "shared");

    expect(harness.db.prepare(`SELECT COUNT(*) AS n FROM files`).get()).toEqual(
      { n: 1 },
    );
    expect(
      harness.db.prepare(`SELECT COUNT(*) AS n FROM document_files`).get(),
    ).toEqual({ n: 2 });
  });

  /**
   * Landmine 1. The pre-existing client GC deleted any image not on the
   * currently-open canvas; with several documents that silently destroyed
   * images belonging to the ones you were not looking at.
   */
  it("keeps another document's images when this document is saved without them", async () => {
    const withImage = await createDocument();
    const other = await createDocument();
    await upload(withImage, "kept");

    // Saving an unrelated, image-free document must not disturb it.
    await harness.app.inject({
      method: "PUT",
      url: `/api/documents/${other}/scene`,
      cookies,
      headers: { "if-match": "1" },
      payload: { elements: [makeElement("a")], appState: {}, fileIds: [] },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/files/batch",
      cookies,
      payload: { ids: ["kept"] },
    });
    expect(response.json().files).toHaveLength(1);
  });

  it("keeps images a document has stopped referencing, so snapshots stay restorable", async () => {
    const documentId = await createDocument();
    await upload(documentId, "removed-from-canvas");

    // The user deletes the image from the canvas; the scene no longer lists it.
    await harness.app.inject({
      method: "PUT",
      url: `/api/documents/${documentId}/scene`,
      cookies,
      headers: { "if-match": "1" },
      payload: { elements: [], appState: {}, fileIds: [] },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/files/batch",
      cookies,
      payload: { ids: ["removed-from-canvas"] },
    });
    expect(response.json().files).toHaveLength(1);
  });

  it("reclaims image bytes only when a document is purged for real", async () => {
    const documentId = await createDocument();
    await upload(documentId, "doomed");

    expect(collectOrphanFiles(harness.db)).toBe(0);

    const result = purgeDocument(harness.db, documentId);
    expect(result.removed).toBe(true);
    expect(result.filesReclaimed).toBe(1);
    expect(harness.db.prepare(`SELECT COUNT(*) AS n FROM files`).get()).toEqual(
      {
        n: 0,
      },
    );
  });

  it("keeps a shared image alive while any other document still links it", async () => {
    const first = await createDocument();
    const second = await createDocument();
    await upload(first, "shared");
    await upload(second, "shared");

    purgeDocument(harness.db, first);

    expect(harness.db.prepare(`SELECT COUNT(*) AS n FROM files`).get()).toEqual(
      {
        n: 1,
      },
    );
  });
});

describe("library (D14)", () => {
  let harness: Harness;
  let cookies: { [key: string]: string };

  beforeEach(async () => {
    harness = await createHarness();
    cookies = await harness.auth();
  });
  afterEach(async () => harness.close());

  it("starts empty and round-trips items", async () => {
    expect(
      (
        await harness.app.inject({
          method: "GET",
          url: "/api/library",
          cookies,
        })
      ).json(),
    ).toEqual({ libraryItems: [] });

    const items = [{ id: "item-1", elements: [makeElement("a")] }];
    expect(
      (
        await harness.app.inject({
          method: "PUT",
          url: "/api/library",
          cookies,
          payload: { libraryItems: items },
        })
      ).statusCode,
    ).toBe(204);

    expect(
      (
        await harness.app.inject({
          method: "GET",
          url: "/api/library",
          cookies,
        })
      ).json().libraryItems,
    ).toEqual(items);
  });
});
