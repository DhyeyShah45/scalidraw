import { ConflictError, NetworkError, AuthRequiredError } from "./api";

import type { WorkspaceApi } from "./api";
import type { DocumentMeta } from "./types";

type SceneState = {
  meta: DocumentMeta;
  elements: readonly unknown[];
  appState: Record<string, unknown>;
};

/**
 * An in-memory stand-in for the server that enforces the parts the client must
 * respect: version bumps and If-Match. Tests that fake `putScene` with a stub
 * would pass even if the client stopped sending a base version at all.
 */
export class FakeWorkspaceServer {
  scenes = new Map<string, SceneState>();
  offline = false;
  signedOut = false;
  putCalls: { id: string; baseVersion: number }[] = [];

  private counter = 0;

  seed(id: string, overrides: Partial<DocumentMeta> = {}) {
    const now = 1_700_000_000_000;
    this.scenes.set(id, {
      meta: {
        id,
        name: "Seeded",
        version: 1,
        createdAt: now,
        updatedAt: now,
        hasThumbnail: false,
        ...overrides,
      },
      elements: [],
      appState: {},
    });
    return this.scenes.get(id)!.meta;
  }

  /** Simulates another device writing, which is what produces a 409. */
  writeElsewhere(id: string) {
    const scene = this.scenes.get(id)!;
    scene.meta = { ...scene.meta, version: scene.meta.version + 1 };
    scene.elements = [{ id: "from-other-device" }];
  }

  private guard() {
    if (this.offline) {
      throw new NetworkError("offline");
    }
    if (this.signedOut) {
      throw new AuthRequiredError();
    }
  }

  api: WorkspaceApi = {
    login: async () => ({ authenticated: true as const, expiresAt: 0 }),
    logout: async () => undefined,
    session: async () => ({ authenticated: true as const }),

    listDocuments: async () => {
      this.guard();
      return [...this.scenes.values()].map((scene) => scene.meta);
    },

    createDocument: async (name?: string) => {
      this.guard();
      const id = `doc-${++this.counter}`;
      return this.seed(id, { name: name ?? "Untitled" });
    },

    renameDocument: async (id: string, name: string) => {
      this.guard();
      const scene = this.scenes.get(id)!;
      scene.meta = { ...scene.meta, name };
      return scene.meta;
    },

    deleteDocument: async (id: string) => {
      this.guard();
      this.scenes.delete(id);
    },

    duplicateDocument: async (id: string, name?: string) => {
      this.guard();
      const source = this.scenes.get(id)!;
      const copy = this.seed(`doc-${++this.counter}`, {
        name: name ?? `${source.meta.name} (copy)`,
      });
      this.scenes.get(copy.id)!.elements = source.elements;
      return copy;
    },

    getScene: async (id: string) => {
      this.guard();
      const scene = this.scenes.get(id);
      if (!scene) {
        throw new Error("not found");
      }
      return {
        document: scene.meta,
        elements: scene.elements,
        appState: scene.appState,
      };
    },

    putScene: async (id: string, baseVersion: number, payload) => {
      this.guard();
      this.putCalls.push({ id, baseVersion });
      const scene = this.scenes.get(id)!;
      if (scene.meta.version !== baseVersion) {
        throw new ConflictError(scene.meta.version);
      }
      const version = scene.meta.version + 1;
      scene.meta = { ...scene.meta, version, updatedAt: Date.now() };
      scene.elements = payload.elements;
      scene.appState = payload.appState;
      return { version, updatedAt: scene.meta.updatedAt };
    },

    putThumbnail: async () => undefined,
    uploadFiles: async () => ({ saved: [], rejected: [] }),
    fetchFiles: async () => ({ files: [], missing: [] }),
    getLibrary: async () => ({ libraryItems: [] }),
    putLibrary: async () => undefined,
  };
}
