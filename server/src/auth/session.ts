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

/**
 * Returns true for a live session. Sliding renewal (D25): the expiry is pushed
 * out once the session is past its halfway point, so an active user is never
 * logged out while a write is only performed occasionally.
 */
export const touchSession = (
  db: DB,
  token: string,
  ttlMs: number,
  now = Date.now(),
) => {
  const hashed = hashSessionToken(token);
  const row = db
    .prepare(`SELECT created_at, expires_at FROM sessions WHERE token = ?`)
    .get(hashed) as { created_at: number; expires_at: number } | undefined;

  if (!row) {
    return false;
  }
  if (row.expires_at <= now) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(hashed);
    return false;
  }

  if (row.expires_at - now < ttlMs / 2) {
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`).run(
      now + ttlMs,
      hashed,
    );
  }

  return true;
};

export const destroySession = (db: DB, token: string) => {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(
    hashSessionToken(token),
  );
};

export const pruneExpiredSessions = (db: DB, now = Date.now()) =>
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now).changes;
