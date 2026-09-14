import { SESSION_COOKIE, touchSession } from "./session";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Config } from "../config";
import type { DB } from "../db";

declare module "fastify" {
  interface FastifyInstance {
    /** preHandler that 401s anything without a live session. */
    requireAuth: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

export const registerAuthGuard = (
  app: FastifyInstance,
  db: DB,
  config: Config,
) => {
  app.decorate(
    "requireAuth",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = request.cookies[SESSION_COOKIE];

      if (!token || !touchSession(db, token, config.sessionTtlMs)) {
        // The client distinguishes this from a Cloudflare Access redirect by
        // the JSON body + explicit code (D24) — an Access bounce arrives as a
        // 302 to an HTML login page, which must not be mistaken for a 401.
        await reply
          .code(401)
          .send({ error: "unauthorized", code: "NO_SESSION" });
      }
    },
  );
};

export const sessionCookieOptions = (config: Config, maxAgeMs: number) => ({
  path: "/",
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: "lax" as const,
  maxAge: Math.floor(maxAgeMs / 1000),
});
