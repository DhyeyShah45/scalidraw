import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeScene } from "../src/db/documents";

import { createHarness, makeElement } from "./helpers";

import type { Harness } from "./helpers";

describe("scene writes", () => {
  let harness: Harness;
  let cookies: { [key: string]: string };
  let documentId: string;

  beforeEach(async () => {
    harness = await createHarness();
    cookies = await harness.auth();
    documentId = (
      await harness.app.inject({
        method: "POST",
        url: "/api/documents",
        cookies,
        payload: {},
      })
    ).json().document.id;
  });
  afterEach(async () => harness.close());

  const put = (version: number | null, elements: unknown[], appState = {}) =>
    harness.app.inject({
      method: "PUT",
      url: `/api/documents/${documentId}/scene`,
      cookies,
      headers: version === null ? {} : { "if-match": String(version) },
      payload: { elements, appState },
    });

  it("bumps the version and returns it as an ETag", async () => {
    const response = await put(1, [makeElement("a")]);

    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(2);
    expect(response.headers.etag).toBe('"2"');
  });

  it("round-trips elements and the per-document appState subset", async () => {
    await put(1, [makeElement("a")], { zoom: { value: 2 }, scrollX: 40 });

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/documents/${documentId}/scene`,
      cookies,
    });

    expect(response.json().elements).toEqual([makeElement("a")]);
    expect(response.json().appState).toEqual({
      zoom: { value: 2 },
      scrollX: 40,
    });
    expect(response.headers.etag).toBe('"2"');
  });

  it("requires If-Match rather than defaulting to a blind overwrite", async () => {
    const response = await put(null, [makeElement("a")]);
    expect(response.statusCode).toBe(428);
    expect(response.json().code).toBe("PRECONDITION_REQUIRED");
  });

  it("409s a stale write and reports the current version (D9)", async () => {
    await put(1, [makeElement("a")]);

    // Second device still believes the document is at version 1.
    const stale = await put(1, [makeElement("b")]);

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      currentVersion: 2,
    });

    // Crucially, the losing write must NOT have landed.
    const scene = (
      await harness.app.inject({
        method: "GET",
        url: `/api/documents/${documentId}/scene`,
        cookies,
      })
    ).json();
    expect(scene.elements).toEqual([makeElement("a")]);
  });

  it("lets the client resolve a conflict by re-sending at the current version", async () => {
    await put(1, [makeElement("a")]);
    const resolved = await put(2, [makeElement("b")]);

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().version).toBe(3);
  });

  it("stores the scene gzipped", async () => {
    await put(
      1,
      Array.from({ length: 200 }, (_, i) => makeElement(`el-${i}`)),
    );

    const row = harness.db
      .prepare(`SELECT blob FROM scenes WHERE document_id = ?`)
      .get(documentId) as { blob: Buffer };

    expect(row.blob[0]).toBe(0x1f); // gzip magic
    expect(row.blob[1]).toBe(0x8b);
    expect(row.blob.byteLength).toBeLessThan(2000);
  });
});

describe("snapshots (D5)", () => {
  let harness: Harness;
  let documentId: string;

  beforeEach(async () => {
    harness = await createHarness();
    const cookies = await harness.auth();
    documentId = (
      await harness.app.inject({
        method: "POST",
        url: "/api/documents",
        cookies,
        payload: {},
      })
    ).json().document.id;
  });
  afterEach(async () => harness.close());

  const countSnapshots = () =>
    (
      harness.db
        .prepare(`SELECT COUNT(*) AS n FROM snapshots WHERE document_id = ?`)
        .get(documentId) as { n: number }
    ).n;

  it("does not snapshot every autosave", async () => {
    let version = 1;
    for (let i = 0; i < 20; i++) {
      const result = writeScene(harness.db, harness.config, {
        id: documentId,
        baseVersion: version,
        scene: { elements: [makeElement(`el-${i}`)], appState: {} },
        now: 1_000_000 + i * 1000, // one second apart
      });
      expect(result.ok).toBe(true);
      version += 1;
    }

    // 20 saves inside one 10-minute window is one snapshot, not twenty.
    expect(countSnapshots()).toBe(1);
  });

  it("snapshots once the interval has elapsed", async () => {
    const elevenMinutes = 11 * 60 * 1000;
    let version = 1;
    for (let i = 0; i < 3; i++) {
      writeScene(harness.db, harness.config, {
        id: documentId,
        baseVersion: version,
        scene: { elements: [makeElement(`el-${i}`)], appState: {} },
        now: 1_000_000 + i * elevenMinutes,
      });
      version += 1;
    }

    expect(countSnapshots()).toBe(3);
  });

  it("prunes to the retention limit, keeping the newest", async () => {
    const harnessWithSmallRetention = await createHarness({
      SNAPSHOTS_PER_DOCUMENT: "3",
    });
    const cookies = await harnessWithSmallRetention.auth();
    const id = (
      await harnessWithSmallRetention.app.inject({
        method: "POST",
        url: "/api/documents",
        cookies,
        payload: {},
      })
    ).json().document.id;

    const elevenMinutes = 11 * 60 * 1000;
    for (let i = 0; i < 6; i++) {
      writeScene(
        harnessWithSmallRetention.db,
        harnessWithSmallRetention.config,
        {
          id,
          baseVersion: i + 1,
          scene: { elements: [makeElement(`el-${i}`)], appState: {} },
          now: 1_000_000 + i * elevenMinutes,
        },
      );
    }

    const versions = harnessWithSmallRetention.db
      .prepare(
        `SELECT version FROM snapshots WHERE document_id = ? ORDER BY created_at DESC`,
      )
      .all(id) as { version: number }[];

    expect(versions.map((row) => row.version)).toEqual([7, 6, 5]);

    await harnessWithSmallRetention.close();
  });
});
