/**
 * Per-IP exponential backoff on failed logins (D25).
 *
 * Deliberately NOT a lockout: with a single credential, a lockout is a
 * self-DoS anyone who can reach the login route can trigger. Delaying the
 * response instead makes online guessing hopeless while leaving the real user
 * one correct password away from getting in.
 */
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 30_000;
/** Failures older than this stop counting. */
const WINDOW_MS = 15 * 60 * 1000;

type Entry = { failures: number; last: number };

export class LoginBackoff {
  private entries = new Map<string, Entry>();

  delayFor(key: string, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || now - entry.last > WINDOW_MS) {
      return 0;
    }
    return Math.min(BASE_DELAY_MS * 2 ** (entry.failures - 1), MAX_DELAY_MS);
  }

  recordFailure(key: string, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || now - entry.last > WINDOW_MS) {
      this.entries.set(key, { failures: 1, last: now });
      return;
    }
    entry.failures += 1;
    entry.last = now;
  }

  reset(key: string) {
    this.entries.delete(key);
  }

  /** Keeps the map from growing unbounded on a public endpoint. */
  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.last > WINDOW_MS) {
        this.entries.delete(key);
      }
    }
  }
}

export const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : undefined;
