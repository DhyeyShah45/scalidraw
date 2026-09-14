import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccessChallengeError,
  AuthRequiredError,
  ConflictError,
  NetworkError,
  NotFoundError,
  request,
} from "./api";

// Not `body` or `json` — both collide with real Response members.
const respondWith = (overrides: Partial<Response> & { payload?: unknown }) => {
  const { payload: body, ...rest } = overrides;
  const response = {
    type: "basic",
    status: 200,
    statusText: "OK",
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body ?? ""),
    ...rest,
  } as unknown as Response;

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return response;
};

afterEach(() => vi.unstubAllGlobals());

describe("api request", () => {
  it("returns the parsed body on success", async () => {
    respondWith({ payload: { hello: "world" } });
    await expect(request("/api/thing")).resolves.toEqual({ hello: "world" });
  });

  it("never follows redirects", async () => {
    respondWith({ payload: {} });
    await request("/api/thing");

    // Following would turn an edge login page into a 200 the caller trusts.
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({
      redirect: "manual",
    });
  });

  describe("Cloudflare Access challenges (D24)", () => {
    it("treats an opaque redirect as a session challenge, not success", async () => {
      respondWith({ type: "opaqueredirect", status: 0, ok: false });
      await expect(request("/api/documents")).rejects.toBeInstanceOf(
        AccessChallengeError,
      );
    });

    it("treats an HTML body on a 200 as a challenge", async () => {
      // The failure mode this guards: autosave recording a login page as a
      // successful write and dropping the user's drawing.
      respondWith({
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        payload: undefined,
      });
      await expect(request("/api/documents")).rejects.toBeInstanceOf(
        AccessChallengeError,
      );
    });

    it("reports a challenge as an auth problem, so the write stays queued", () => {
      // AccessChallengeError extends AuthRequiredError precisely so callers
      // that only know about sign-in handle the edge case correctly.
      expect(new AccessChallengeError()).toBeInstanceOf(AuthRequiredError);
    });
  });

  it("maps 401 to AuthRequiredError", async () => {
    respondWith({ status: 401, ok: false, payload: { code: "NO_SESSION" } });
    await expect(request("/api/documents")).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it("maps 409 to ConflictError carrying the server version", async () => {
    respondWith({ status: 409, ok: false, payload: { currentVersion: 12 } });

    await expect(request("/api/documents/x/scene")).rejects.toMatchObject({
      serverVersion: 12,
    });
    await expect(request("/api/documents/x/scene")).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("maps 404 to NotFoundError", async () => {
    respondWith({ status: 404, ok: false });
    await expect(request("/api/documents/gone")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("maps a transport failure to NetworkError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("failed")));
    await expect(request("/api/documents")).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("propagates an abort rather than disguising it as offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    );
    await expect(request("/api/documents")).rejects.toBeInstanceOf(
      DOMException,
    );
  });

  it("handles 204 with no body", async () => {
    respondWith({ status: 204, payload: undefined });
    await expect(request("/api/library")).resolves.toBeUndefined();
  });
});
