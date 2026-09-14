import { LoginBackoff, sleep } from "../auth/backoff";
import { verifyPassword } from "../auth/password";
import { sessionCookieOptions } from "../auth/plugin";
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  pruneExpiredSessions,
} from "../auth/session";

import type { FastifyInstance } from "fastify";
import type { Config } from "../config";
import type { DB } from "../db";

const loginSchema = {
  body: {
    type: "object",
    required: ["password"],
    properties: { password: { type: "string", minLength: 1, maxLength: 1024 } },
    additionalProperties: false,
  },
} as const;

export const registerAuthRoutes = (
  app: FastifyInstance,
  db: DB,
  config: Config,
) => {
  const backoff = new LoginBackoff();

  app.post(
    "/api/auth/login",
    { schema: loginSchema },
    async (request, reply) => {
      const { password } = request.body as { password: string };
      const key = request.ip;

      await sleep(backoff.delayFor(key));

      if (!(await verifyPassword(config.passwordHash, password))) {
        backoff.recordFailure(key);
        return reply.code(401).send({ error: "invalid credentials" });
      }

      backoff.reset(key);
      backoff.prune();
      pruneExpiredSessions(db);

      const session = createSession(db, config.sessionTtlMs);
      return reply
        .setCookie(
          SESSION_COOKIE,
          session.token,
          sessionCookieOptions(config, config.sessionTtlMs),
        )
        .code(200)
        .send({ authenticated: true, expiresAt: session.expiresAt });
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      destroySession(db, token);
    }
    return reply
      .clearCookie(SESSION_COOKIE, { path: "/" })
      .code(200)
      .send({ authenticated: false });
  });

  // Cheap probe the client calls on boot to decide between the login gate and
  // the canvas. Deliberately behind requireAuth so an expired session and a
  // Cloudflare Access bounce are distinguishable (D24).
  app.get("/api/auth/session", { preHandler: app.requireAuth }, async () => ({
    authenticated: true,
  }));
};
