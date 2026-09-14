import fs from "node:fs";
import path from "node:path";

import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import { registerAuthGuard } from "./auth/plugin";

import { registerAuthRoutes } from "./routes/auth";
import { registerDocumentRoutes } from "./routes/documents";
import { registerFileRoutes } from "./routes/files";
import { registerLibraryRoutes } from "./routes/library";

import type { DB } from "./db";
import type { Config } from "./config";
import type { FastifyInstance } from "fastify";

export type BuildOptions = {
  db: DB;
  config: Config;
  logger?: boolean;
};

const BINARY_TYPES = ["image/png", "application/octet-stream"];

export const buildApp = async ({
  db,
  config,
  logger = false,
}: BuildOptions): Promise<FastifyInstance> => {
  const app = Fastify({
    logger,
    // Behind Cloudflare Tunnel every connection is loopback, so request.ip is
    // useless for the login backoff unless we honour the forwarded header.
    trustProxy: config.trustProxy,
    bodyLimit: Math.max(config.maxSceneBytes, config.maxFileBytes),
  });

  for (const type of BINARY_TYPES) {
    app.addContentTypeParser(
      type,
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
  }

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  registerAuthGuard(app, db, config);

  // Each group is registered as its own plugin so the `preHandler` guard the
  // authenticated groups install stays inside their encapsulation context —
  // registering it on the root instance would also guard /api/auth/login and
  // lock the only user out.
  await app.register(async (instance) => {
    await instance.register(rateLimit, { global: false });
    registerAuthRoutes(instance, db, config);
  });
  await app.register(async (instance) =>
    registerDocumentRoutes(instance, db, config),
  );
  await app.register(async (instance) => registerFileRoutes(instance, db));
  await app.register(async (instance) => registerLibraryRoutes(instance, db));

  app.get("/api/health", async () => ({ ok: true }));

  await registerStatic(app, config);

  return app;
};

const registerStatic = async (app: FastifyInstance, config: Config) => {
  if (!config.staticDir) {
    return;
  }

  const indexPath = path.join(config.staticDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    app.log.warn(
      `STATIC_DIR is set but ${indexPath} does not exist — serving API only.`,
    );
    return;
  }

  await app.register(fastifyStatic, { root: config.staticDir, index: false });

  // SPA fallback for path routes like /d/:id (D16). Without this a hard
  // refresh 404s — a trap the service worker otherwise hides, since its
  // navigateFallback answers navigations from cache once installed.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.type("text/html").send(fs.createReadStream(indexPath));
  });
};
