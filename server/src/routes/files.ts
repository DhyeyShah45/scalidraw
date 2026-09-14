import { getFiles } from "../db/files";

import type { FastifyInstance } from "fastify";

import type { DB } from "../db";

export const registerFileRoutes = (app: FastifyInstance, db: DB) => {
  app.addHook("preHandler", app.requireAuth);

  // Batch by design: Excalidraw's FileManager asks for every image on a canvas
  // at once, and one request beats N round trips over a home connection.
  app.post(
    "/api/files/batch",
    {
      schema: {
        body: {
          type: "object",
          required: ["ids"],
          properties: {
            ids: {
              type: "array",
              maxItems: 1000,
              items: { type: "string", minLength: 1, maxLength: 200 },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { ids } = request.body as { ids: string[] };
      const files = getFiles(db, ids);
      const found = new Set(files.map((file) => file.id));

      return {
        files,
        // The client marks these errored so it stops re-requesting them.
        missing: ids.filter((id) => !found.has(id)),
      };
    },
  );
};
