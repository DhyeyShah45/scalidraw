import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LoginBackoff } from "../src/auth/backoff";
import { loadConfig } from "../src/config";

import { TEST_PASSWORD, createHarness } from "./helpers";

import type { Harness } from "./helpers";

describe("auth", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => harness.close());

  it("rejects a wrong password without issuing a cookie", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "wrong" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.cookies).toHaveLength(0);
  });

  it("issues an httpOnly session cookie on success", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const cookie = response.cookies[0]!;
    expect(cookie.name).toBe("scalidraw_session");
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
  });

  it("guards the API and reports a machine-readable code", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/documents",
    });

    expect(response.statusCode).toBe(401);
    // The client keys off this to tell an expired session apart from a
    // Cloudflare Access bounce, which arrives as a 302 to an HTML page (D24).
    expect(response.json()).toMatchObject({ code: "NO_SESSION" });
  });

  it("does not guard the login route itself", async () => {
    // Regression: registering requireAuth on the root instance rather than
    // inside each plugin scope would lock the only user out permanently.
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });

  it("accepts a live session and refuses it after logout", async () => {
    const cookies = await harness.auth();

    expect(
      (
        await harness.app.inject({
          method: "GET",
          url: "/api/documents",
          cookies,
        })
      ).statusCode,
    ).toBe(200);

    await harness.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      cookies,
    });

    expect(
      (
        await harness.app.inject({
          method: "GET",
          url: "/api/documents",
          cookies,
        })
      ).statusCode,
    ).toBe(401);
  });

  it("expires sessions once past their TTL", async () => {
    const cookies = await harness.auth();
    harness.db.prepare(`UPDATE sessions SET expires_at = 1`).run();

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/documents",
      cookies,
    });
    expect(response.statusCode).toBe(401);
    // The dead row is reaped on the way past, not left to accumulate.
    expect(
      harness.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get(),
    ).toEqual({ n: 0 });
  });

  it("stores session tokens hashed, so a stolen DB yields no live sessions", async () => {
    const cookies = await harness.auth();
    const stored = harness.db.prepare(`SELECT token FROM sessions`).get() as {
      token: string;
    };
    expect(stored.token).not.toBe(cookies.scalidraw_session);
  });
});

describe("login backoff", () => {
  it("grows exponentially and resets on success, never locking out", () => {
    const backoff = new LoginBackoff();
    const ip = "203.0.113.7";

    expect(backoff.delayFor(ip)).toBe(0);

    backoff.recordFailure(ip);
    expect(backoff.delayFor(ip)).toBe(250);
    backoff.recordFailure(ip);
    expect(backoff.delayFor(ip)).toBe(500);
    backoff.recordFailure(ip);
    expect(backoff.delayFor(ip)).toBe(1000);

    // Capped, so a sustained attack cannot push the real user's delay to hours.
    for (let i = 0; i < 40; i++) {
      backoff.recordFailure(ip);
    }
    expect(backoff.delayFor(ip)).toBe(30_000);

    backoff.reset(ip);
    expect(backoff.delayFor(ip)).toBe(0);
  });

  it("forgets failures once the window lapses", () => {
    const backoff = new LoginBackoff();
    const now = 1_000_000;
    backoff.recordFailure("ip", now);
    expect(backoff.delayFor("ip", now + 16 * 60 * 1000)).toBe(0);
  });
});

describe("config", () => {
  it("refuses a plaintext password in AUTH_PASSWORD_HASH", () => {
    expect(() =>
      loadConfig({ AUTH_PASSWORD_HASH: "hunter2" } as NodeJS.ProcessEnv),
    ).toThrow(/argon2/);
  });

  it("refuses to start with no credential at all", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/required/);
  });
});

describe("session sliding (D25)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ SESSION_TTL_DAYS: "30" });
  });
  afterEach(async () => harness.close());

  it("re-issues the cookie when the session slides, not just the row", async () => {
    const cookies = await harness.auth();

    // Push the session past its halfway point so the next request renews it.
    const soon = Date.now() + 60_000;
    harness.db.prepare(`UPDATE sessions SET expires_at = ?`).run(soon);

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/documents",
      cookies,
    });

    expect(response.statusCode).toBe(200);
    // Extending only the database row leaves the browser discarding the
    // cookie at login + TTL, which makes sliding renewal inert.
    expect(response.cookies).toHaveLength(1);
    expect(response.cookies[0]!.name).toBe("scalidraw_session");
    expect(response.cookies[0]!.maxAge).toBe(30 * 24 * 60 * 60);

    const stored = harness.db
      .prepare(`SELECT expires_at FROM sessions`)
      .get() as { expires_at: number };
    expect(stored.expires_at).toBeGreaterThan(soon);
  });

  it("does not re-issue the cookie on every request", async () => {
    const cookies = await harness.auth();

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/documents",
      cookies,
    });

    expect(response.cookies).toHaveLength(0);
  });
});

describe("backoff cannot be shed by rotating X-Forwarded-For", () => {
  it("keeps delaying once the global ladder engages", () => {
    const backoff = new LoginBackoff();

    // A per-IP ladder alone is bypassable: behind a trusted proxy the client
    // controls the header request.ip derives from.
    for (let i = 0; i < 25; i++) {
      backoff.recordFailure(`10.0.0.${i}`);
    }

    expect(backoff.delayFor("10.0.0.99")).toBeGreaterThan(0);
  });

  it("stays out of the way of a handful of honest typos", () => {
    const backoff = new LoginBackoff();
    for (let i = 0; i < 3; i++) {
      backoff.recordFailure("10.0.0.1");
    }
    // Same user, same IP: only the per-IP ladder applies at this point.
    expect(backoff.delayFor("10.0.0.2")).toBe(0);
  });

  it("bounds the number of tracked keys", () => {
    const backoff = new LoginBackoff();
    for (let i = 0; i < 12_000; i++) {
      backoff.recordFailure(`10.1.${Math.floor(i / 256)}.${i % 256}`);
    }
    // Unbounded growth here would be a memory DoS via a spoofable header.
    expect(backoff.size()).toBeLessThanOrEqual(10_000);
  });
});

describe("config validation", () => {
  const base = { AUTH_PASSWORD_HASH: "$argon2id$fake" } as NodeJS.ProcessEnv;

  it("rejects a fractional snapshot retention", () => {
    // It reaches SQLite as a LIMIT, where 2.5 is a datatype mismatch on every
    // single save rather than a startup error.
    expect(() =>
      loadConfig({ ...base, SNAPSHOTS_PER_DOCUMENT: "2.5" }),
    ).toThrow(/whole number/);
  });

  it("rejects a negative retention, which SQLite reads as unlimited", () => {
    expect(() => loadConfig({ ...base, SNAPSHOTS_PER_DOCUMENT: "-1" })).toThrow(
      /whole number/,
    );
  });

  it("rejects an ambiguous boolean rather than silently defaulting", () => {
    expect(() => loadConfig({ ...base, COOKIE_SECURE: "TRUE" })).not.toThrow();
    expect(() => loadConfig({ ...base, COOKIE_SECURE: "yes-please" })).toThrow(
      /true or false/,
    );
  });
});
