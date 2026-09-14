import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHarness, makeElement } from "./helpers";

import type { Harness } from "./helpers";

describe("documents", () => {
  let harness: Harness;
  let cookies: { [key: string]: string };

  beforeEach(async () => {
    harness = await createHarness();
    cookies = await harness.auth();
  });
  afterEach(async () => harness.close());

  const create = async (name?: string) => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/documents",
      cookies,
      payload: name ? { name } : {},
    });
    expect(response.statusCode).toBe(201);
    return response.json().document as {
      id: string;
      name: string;
      version: number;
    };
  };

  it("creates a document at version 1 with a default name", async () => {
    const document = await create();
    expect(document.name).toBe("Untitled");
    expect(document.version).toBe(1);
    expect(document.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("lists documents most-recently-updated first", async () => {
    const first = await create("first");
    const second = await create("second");

    // Touch `first` so ordering is by update time, not creation order.
    await harness.app.inject({
      method: "PATCH",
      url: `/api/documents/${first.id}`,
      cookies,
      payload: { name: "first renamed" },
    });

    const list = (
      await harness.app.inject({
        method: "GET",
        url: "/api/documents",
        cookies,
      })
    ).json().documents as { id: string }[];

    expect(list.map((d) => d.id)).toEqual([first.id, second.id]);
  });

  it("renames and reflects it immediately", async () => {
    const document = await create();
    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/documents/${document.id}`,
      cookies,
      payload: { name: "Sprint ideas" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().document.name).toBe("Sprint ideas");
  });

  it("rejects an empty name rather than storing one", async () => {
    const document = await create();
    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/documents/${document.id}`,
      cookies,
      payload: { name: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("soft-deletes: gone from the API, still recoverable in the row", async () => {
    const document = await create();

    expect(
      (
        await harness.app.inject({
          method: "DELETE",
          url: `/api/documents/${document.id}`,
          cookies,
        })
      ).statusCode,
    ).toBe(204);

    expect(
      (
        await harness.app.inject({
          method: "GET",
          url: `/api/documents/${document.id}`,
          cookies,
        })
      ).statusCode,
    ).toBe(404);

    // D6: no trash UI, but the data is still there for a hand recovery.
    const row = harness.db
      .prepare(`SELECT deleted_at FROM documents WHERE id = ?`)
      .get(document.id) as { deleted_at: number | null };
    expect(row.deleted_at).toBeGreaterThan(0);
  });

  it("duplicates the scene into an independent document", async () => {
    const source = await create("Original");
    await harness.app.inject({
      method: "PUT",
      url: `/api/documents/${source.id}/scene`,
      cookies,
      headers: { "if-match": String(source.version) },
      payload: { elements: [makeElement("a")], appState: { zoom: 2 } },
    });

    const copy = (
      await harness.app.inject({
        method: "POST",
        url: `/api/documents/${source.id}/duplicate`,
        cookies,
        payload: {},
      })
    ).json().document as { id: string; name: string };

    expect(copy.name).toBe("Original (copy)");

    const copiedScene = (
      await harness.app.inject({
        method: "GET",
        url: `/api/documents/${copy.id}/scene`,
        cookies,
      })
    ).json();
    expect(copiedScene.elements).toHaveLength(1);

    // Editing the copy must not touch the original.
    await harness.app.inject({
      method: "PUT",
      url: `/api/documents/${copy.id}/scene`,
      cookies,
      headers: { "if-match": "1" },
      payload: { elements: [], appState: {} },
    });

    const original = (
      await harness.app.inject({
        method: "GET",
        url: `/api/documents/${source.id}/scene`,
        cookies,
      })
    ).json();
    expect(original.elements).toHaveLength(1);
  });

  it("round-trips a PNG thumbnail", async () => {
    const document = await create();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );

    expect(
      (
        await harness.app.inject({
          method: "PUT",
          url: `/api/documents/${document.id}/thumbnail`,
          cookies,
          headers: { "content-type": "image/png" },
          payload: png,
        })
      ).statusCode,
    ).toBe(204);

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/documents/${document.id}/thumbnail`,
      cookies,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload.equals(png)).toBe(true);

    const listed = (
      await harness.app.inject({
        method: "GET",
        url: "/api/documents",
        cookies,
      })
    ).json().documents[0];
    expect(listed.hasThumbnail).toBe(true);
  });

  it("404s for unknown ids on every document route", async () => {
    for (const [method, url] of [
      ["GET", "/api/documents/nope"],
      ["GET", "/api/documents/nope/scene"],
      ["GET", "/api/documents/nope/thumbnail"],
      ["DELETE", "/api/documents/nope"],
    ] as const) {
      const response = await harness.app.inject({ method, url, cookies });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});

describe("static hosting and SPA fallback (D16, D18)", () => {
  let harness: Harness;
  let staticDir: string;

  beforeEach(async () => {
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "scalidraw-static-"));
    fs.writeFileSync(
      path.join(staticDir, "index.html"),
      "<!doctype html><title>app shell</title>",
    );
    fs.writeFileSync(path.join(staticDir, "app.js"), "console.log(1);");
    harness = await createHarness({ STATIC_DIR: staticDir });
  });
  afterEach(async () => {
    await harness.close();
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  it("serves the app shell at the root", async () => {
    // With `index: false` fastify-static answers 403 here and the fallback
    // never runs, making the home URL unreachable.
    const response = await harness.app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("app shell");
  });

  it("serves the app shell for a document route on a hard refresh", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/d/some-document-id",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("app shell");
  });

  it("still serves real assets rather than the shell", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/app.js",
    });
    expect(response.body).toBe("console.log(1);");
  });

  it("never answers an unknown API route with the shell", async () => {
    // The SPA fallback swallowing /api/* would turn a typo'd endpoint into a
    // 200 full of HTML, which is exactly what the client's D24 guard is for.
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/does-not-exist",
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
  });
});
