import { afterEach, describe, expect, it, vi } from "vitest";

import {
  documentPath,
  navigateToDocument,
  onDocumentRouteChange,
  originWithCurrentDocument,
  parseDocumentId,
  replaceWithDocument,
} from "./routing";

const at = (pathname: string) => {
  vi.stubGlobal("location", {
    ...window.location,
    pathname,
    origin: "https://canvas.example",
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  // history spies are installed per test; without this they accumulate calls
  // across cases and assertions read the previous test's history.
  vi.restoreAllMocks();
});

describe("parseDocumentId", () => {
  it("reads the id out of a document path", () => {
    expect(parseDocumentId("/d/_GhkB3IYx0St9WXH")).toBe("_GhkB3IYx0St9WXH");
  });

  it("tolerates a trailing slash", () => {
    expect(parseDocumentId("/d/abc/")).toBe("abc");
  });

  it("ignores anything that is not a document route", () => {
    for (const path of [
      "/",
      "/d/",
      "/d/a/b",
      "/other/abc",
      "/excalidraw-plus-export",
    ]) {
      expect(parseDocumentId(path), path).toBeNull();
    }
  });

  it("rejects ids with characters the server never generates", () => {
    expect(parseDocumentId("/d/../../etc/passwd")).toBeNull();
    expect(parseDocumentId("/d/abc%20def")).toBeNull();
  });
});

describe("originWithCurrentDocument", () => {
  /**
   * Three call sites reset the URL to the bare origin after consuming a
   * `#json=` or `#room=` fragment. On a path-routed app that also throws away
   * the open document, so they go through this instead.
   */
  it("keeps the open document in the URL", () => {
    at("/d/abc123");
    expect(originWithCurrentDocument()).toBe("https://canvas.example/d/abc123");
  });

  it("falls back to the bare origin outside a document", () => {
    at("/");
    expect(originWithCurrentDocument()).toBe("https://canvas.example");
  });
});

describe("navigation", () => {
  it("pushes a history entry so Back returns to the previous document", () => {
    at("/d/first");
    const push = vi.spyOn(window.history, "pushState");

    navigateToDocument("second");

    expect(push).toHaveBeenCalledWith(
      { documentId: "second" },
      "",
      "/d/second",
    );
  });

  it("does not stack duplicate entries for the document already open", () => {
    at("/d/same");
    const push = vi.spyOn(window.history, "pushState");

    navigateToDocument("same");

    expect(push).not.toHaveBeenCalled();
  });

  it("replaces rather than pushes when adopting a default document", () => {
    at("/");
    const replace = vi.spyOn(window.history, "replaceState");

    replaceWithDocument("adopted");

    expect(replace).toHaveBeenCalledWith(
      { documentId: "adopted" },
      "",
      "/d/adopted",
    );
  });

  it("builds paths from ids", () => {
    expect(documentPath("xyz")).toBe("/d/xyz");
  });
});

describe("onDocumentRouteChange", () => {
  it("reports the new id on popstate and unsubscribes cleanly", () => {
    at("/d/one");
    const handler = vi.fn();
    const unsubscribe = onDocumentRouteChange(handler);

    at("/d/two");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(handler).toHaveBeenCalledWith("two");

    unsubscribe();
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
