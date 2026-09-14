import {
  createDocument,
  deleteDocument,
  duplicateDocument,
  getDocument,
  getScene,
  getThumbnail,
  listDocuments,
  renameDocument,
  setThumbnail,
  writeScene,
} from "../db/documents";

import { parseDataURL, putFile } from "../db/files";

import type { FastifyInstance } from "fastify";

import type { Config } from "../config";
import type { DB } from "../db";
import type { SceneData } from "../db/documents";

const DEFAULT_NAME = "Untitled";
const MAX_NAME = 200;

/** Accepts both a bare version (`3`) and a quoted ETag (`"3"`). */
const parseIfMatch = (raw: string | undefined): number | null => {
  if (raw === undefined) {
    return null;
  }
  const parsed = Number(raw.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const nameProperty = {
  type: "string",
  minLength: 1,
  maxLength: MAX_NAME,
} as const;

const sceneProperties = {
  elements: { type: "array" },
  appState: { type: "object" },
  fileIds: { type: "array", items: { type: "string" }, maxItems: 5000 },
} as const;

export const registerDocumentRoutes = (
  app: FastifyInstance,
  db: DB,
  config: Config,
) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/api/documents", async () => ({ documents: listDocuments(db) }));

  app.post(
    "/api/documents",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            name: nameProperty,
            scene: { type: "object", properties: sceneProperties },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        name?: string;
        scene?: Partial<SceneData>;
      };

      const document = createDocument(db, {
        name: body.name ?? DEFAULT_NAME,
        scene: body.scene
          ? {
              elements: body.scene.elements ?? [],
              appState: body.scene.appState ?? {},
            }
          : undefined,
      });

      return reply.code(201).send({ document });
    },
  );

  app.get("/api/documents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = getDocument(db, id);
    if (!document) {
      return reply.code(404).send({ error: "not found" });
    }
    return { document };
  });

  app.patch(
    "/api/documents/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: nameProperty },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { name } = request.body as { name: string };

      if (!renameDocument(db, id, name)) {
        return reply.code(404).send({ error: "not found" });
      }
      return { document: getDocument(db, id) };
    },
  );

  app.delete("/api/documents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deleteDocument(db, id)) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.code(204).send();
  });

  app.post(
    "/api/documents/:id/duplicate",
    {
      schema: {
        body: {
          type: "object",
          properties: { name: nameProperty },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { name?: string };
      const source = getDocument(db, id);
      if (!source) {
        return reply.code(404).send({ error: "not found" });
      }

      const copy = duplicateDocument(
        db,
        id,
        body.name ?? `${source.name} (copy)`.slice(0, MAX_NAME),
      );
      return reply.code(201).send({ document: copy });
    },
  );

  app.get("/api/documents/:id/scene", async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = getScene(db, id);
    if (!found) {
      return reply.code(404).send({ error: "not found" });
    }

    return reply
      .header("ETag", `"${found.meta.version}"`)
      .header("Cache-Control", "no-store")
      .send({
        document: found.meta,
        elements: found.scene.elements,
        appState: found.scene.appState,
      });
  });

  app.put(
    "/api/documents/:id/scene",
    {
      bodyLimit: config.maxSceneBytes,
      schema: {
        body: {
          type: "object",
          required: ["elements"],
          properties: sceneProperties,
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        elements: unknown[];
        appState?: Record<string, unknown>;
        fileIds?: string[];
      };

      const baseVersion = parseIfMatch(request.headers["if-match"] as string);
      if (baseVersion === null) {
        return reply.code(428).send({
          error: "If-Match header required",
          code: "PRECONDITION_REQUIRED",
        });
      }

      const result = writeScene(db, config, {
        id,
        baseVersion,
        scene: { elements: body.elements, appState: body.appState ?? {} },
        fileIds: body.fileIds,
      });

      if (!result.ok) {
        if (result.reason === "not-found") {
          return reply.code(404).send({ error: "not found" });
        }
        // D9: the client shows "changed elsewhere — reload or overwrite?" and
        // keeps the pending write queued until the user picks.
        return reply.code(409).send({
          error: "version conflict",
          code: "VERSION_CONFLICT",
          currentVersion: result.currentVersion,
        });
      }

      return reply.header("ETag", `"${result.version}"`).send({
        version: result.version,
        updatedAt: result.updatedAt,
      });
    },
  );

  app.get("/api/documents/:id/thumbnail", async (request, reply) => {
    const { id } = request.params as { id: string };
    const thumbnail = getThumbnail(db, id);
    if (!thumbnail) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply
      .header("Content-Type", "image/png")
      .header("ETag", `"${thumbnail.updatedAt}"`)
      .header("Cache-Control", "private, max-age=0, must-revalidate")
      .send(thumbnail.png);
  });

  app.put(
    "/api/documents/:id/thumbnail",
    { bodyLimit: config.maxFileBytes },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body;

      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        return reply
          .code(415)
          .send({ error: "expected a non-empty image/png body" });
      }
      if (!setThumbnail(db, id, body)) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.code(204).send();
    },
  );

  // Images are uploaded against the document that references them, which is
  // what keeps the refcount in `document_files` honest (landmine 1).
  app.post(
    "/api/documents/:id/files",
    {
      bodyLimit: config.maxSceneBytes,
      schema: {
        body: {
          type: "object",
          required: ["files"],
          properties: {
            files: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                required: ["id", "dataURL"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 200 },
                  dataURL: { type: "string" },
                  created: { type: "number" },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { files } = request.body as {
        files: { id: string; dataURL: string; created?: number }[];
      };

      if (!getDocument(db, id)) {
        return reply.code(404).send({ error: "not found" });
      }

      const saved: string[] = [];
      const rejected: { id: string; reason: string }[] = [];

      for (const file of files) {
        const parsed = parseDataURL(file.dataURL);
        if (!parsed) {
          rejected.push({ id: file.id, reason: "malformed dataURL" });
          continue;
        }
        if (parsed.bytes.byteLength > config.maxFileBytes) {
          rejected.push({ id: file.id, reason: "too large" });
          continue;
        }
        putFile(db, {
          id: file.id,
          documentId: id,
          mimeType: parsed.mimeType,
          bytes: parsed.bytes,
          created: file.created,
        });
        saved.push(file.id);
      }

      return reply.code(200).send({ saved, rejected });
    },
  );
};
