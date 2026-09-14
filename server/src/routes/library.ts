import { getLibrary, setLibrary } from "../db/library";

import type { FastifyInstance } from "fastify";

import type { DB } from "../db";

export const registerLibraryRoutes = (app: FastifyInstance, db: DB) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/api/library", async () => getLibrary(db));

  // Mirrors LibraryPersistenceAdapter.save (D14). The editor already unions
  // with whatever load() returns, so this is a plain replace.
  app.put(
    "/api/library",
    {
      schema: {
        body: {
          type: "object",
          required: ["libraryItems"],
          properties: { libraryItems: { type: "array" } },
          additionalProperties: true,
        },
      },
    },
    async (request, reply) => {
      const { libraryItems } = request.body as { libraryItems: unknown[] };
      setLibrary(db, { libraryItems });
      return reply.code(204).send();
    },
  );
};
