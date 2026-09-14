import { hashSessionToken, newSessionToken } from "../lib/ids";

import type { DB } from "../db";

export const SESSION_COOKIE = "scalidraw_session";

export const createSession = (db: DB, ttlMs: number, now = Date.now()) => {
  const token = newSessionToken();
  db.prepare(
    `INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)`,
  ).run(hashSessionToken(token), now, now + ttlMs);
  return { token, expiresAt: now + ttlMs };
};

export type TouchResult =
  | { valid: false }
  /** `renewed` means the caller must re-issue the cookie — see below. */
  | { valid: true; renewed: boolean; expiresAt: number };

/**
 * Sliding renewal (D25): the expiry is pushed out once the session is past its
 * halfway point, so an active user is never signed out mid-session.
 *
 * Extending the database row is only half of it. The cookie carries its own
 * `Max-Age`, and if that is only ever set at login the browser discards it at
 * login + TTL no matter how active the session was — the renewal would be
 * invisible and the feature inert. Hence `renewed`.
 */
export const touchSession = (
  db: DB,
  token: string,
  ttlMs: number,
  now = Date.now(),
): TouchResult => {
  const hashed = hashSessionToken(token);
  const row = db
    .prepare(`SELECT created_at, expires_at FROM sessions WHERE token = ?`)
    .get(hashed) as { created_at: number; expires_at: number } | undefined;

  if (!row) {
    return { valid: false };
  }
  if (row.expires_at <= now) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(hashed);
    return { valid: false };
  }

  if (row.expires_at - now < ttlMs / 2) {
    const expiresAt = now + ttlMs;
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`).run(
      expiresAt,
      hashed,
    );
    return { valid: true, renewed: true, expiresAt };
  }

  return { valid: true, renewed: false, expiresAt: row.expires_at };
};

export const destroySession = (db: DB, token: string) => {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(
    hashSessionToken(token),
  );
};

export const pruneExpiredSessions = (db: DB, now = Date.now()) =>
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now).changes;
