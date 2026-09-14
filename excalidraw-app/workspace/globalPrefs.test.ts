import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "@excalidraw/excalidraw/types";

import { loadGlobalPrefs, saveGlobalPrefs } from "./globalPrefs";

describe("global editor preferences (D13)", () => {
  beforeEach(() => localStorage.clear());

  it("returns an empty object before anything is stored", () => {
    expect(loadGlobalPrefs()).toEqual({});
  });

  it("persists device preferences and drops document state", () => {
    saveGlobalPrefs({
      currentItemStrokeColor: "#ff0000",
      exportBackground: false,
      scrollX: 500,
      gridSize: 40,
    } as Partial<AppState> as AppState);

    const loaded = loadGlobalPrefs();

    expect(loaded).toMatchObject({
      currentItemStrokeColor: "#ff0000",
      exportBackground: false,
    });
    // These travel with the document, not the device.
    expect(loaded).not.toHaveProperty("scrollX");
    expect(loaded).not.toHaveProperty("gridSize");
  });

  it("survives corrupt storage rather than breaking the boot", () => {
    localStorage.setItem("scalidraw-editor-prefs", "{not json");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(loadGlobalPrefs()).toEqual({});
  });

  it("does not throw when storage is unavailable", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      saveGlobalPrefs({ currentItemStrokeColor: "#000" } as AppState),
    ).not.toThrow();

    setItem.mockRestore();
  });
});
