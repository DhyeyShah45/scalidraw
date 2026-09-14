import { describe, expect, it } from "vitest";

import type { AppState } from "@excalidraw/excalidraw/types";

import { mergeAppState, splitAppState } from "./appStateSplit";

const appState = (overrides: Partial<AppState>) => overrides;

describe("splitAppState (D13)", () => {
  it("keeps canvas properties with the document", () => {
    const { document } = splitAppState(
      appState({
        gridSize: 30,
        gridModeEnabled: true,
        viewBackgroundColor: "#fff",
      }),
    );

    expect(document).toMatchObject({
      gridSize: 30,
      gridModeEnabled: true,
      viewBackgroundColor: "#fff",
    });
  });

  it("keeps viewport and selection with the document", () => {
    // Upstream marks these browser-only because there has only ever been one
    // scene; with several, they must travel per document or every switch lands
    // you at the previous document's scroll position.
    const { document, global } = splitAppState(
      appState({
        scrollX: 120,
        scrollY: -40,
        zoom: { value: 1.5 as never },
        selectedElementIds: { abc: true },
      }),
    );

    expect(document).toMatchObject({
      scrollX: 120,
      scrollY: -40,
      selectedElementIds: { abc: true },
    });
    expect(global).not.toHaveProperty("scrollX");
    expect(global).not.toHaveProperty("selectedElementIds");
  });

  it("keeps device preferences global", () => {
    const { document, global } = splitAppState(
      appState({
        currentItemStrokeColor: "#ff0000",
        currentItemFontFamily: 2 as never,
        exportBackground: false,
        zenModeEnabled: true,
      }),
    );

    expect(global).toMatchObject({
      currentItemStrokeColor: "#ff0000",
      exportBackground: false,
      zenModeEnabled: true,
    });
    expect(document).not.toHaveProperty("currentItemStrokeColor");
  });

  it("excludes `name` from both halves — it is document metadata", () => {
    const { document, global } = splitAppState(appState({ name: "My canvas" }));

    expect(document).not.toHaveProperty("name");
    expect(global).not.toHaveProperty("name");
  });

  it("drops ephemeral runtime state entirely", () => {
    const { document, global } = splitAppState(
      appState({ isResizing: true, errorMessage: "boom", fileHandle: null }),
    );

    for (const half of [document, global]) {
      expect(half).not.toHaveProperty("isResizing");
      expect(half).not.toHaveProperty("errorMessage");
      expect(half).not.toHaveProperty("fileHandle");
    }
  });
});

describe("mergeAppState", () => {
  it("lets the document override device preferences", () => {
    const merged = mergeAppState({
      global: { gridSize: 20, currentItemStrokeColor: "#000" },
      document: { gridSize: 50 },
      documentName: "Ideas",
    });

    expect(merged.gridSize).toBe(50);
    expect(merged.currentItemStrokeColor).toBe("#000");
  });

  it("applies the document name from metadata", () => {
    const merged = mergeAppState({
      global: {},
      document: {},
      documentName: "Sprint planning",
    });
    expect(merged.name).toBe("Sprint planning");
  });

  it("round-trips through split without losing the document half", () => {
    const original = appState({
      gridSize: 30,
      scrollX: 10,
      zoom: { value: 2 as never },
      currentItemStrokeColor: "#abc",
    });
    const { document, global } = splitAppState(original);

    const merged = mergeAppState({ global, document, documentName: "x" });

    expect(merged.gridSize).toBe(30);
    expect(merged.scrollX).toBe(10);
    expect(merged.currentItemStrokeColor).toBe("#abc");
  });
});
