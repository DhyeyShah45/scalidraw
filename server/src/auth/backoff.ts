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

/**
 * The global ladder is slower to climb but cannot be shed by changing IP.
 * It only starts biting after a burst that no honest user produces.
 */
const GLOBAL_FREE_ATTEMPTS = 10;
const GLOBAL_BASE_DELAY_MS = 100;
const GLOBAL_MAX_DELAY_MS = 5_000;

/** Bound on distinct keys tracked, so a spoofed header cannot exhaust memory. */
const MAX_TRACKED_KEYS = 10_000;

type Entry = { failures: number; last: number };

export class LoginBackoff {
  private entries = new Map<string, Entry>();
  private global: Entry = { failures: 0, last: 0 };

  /**
   * Per-IP delay OR a global one, whichever is larger.
   *
   * `request.ip` derives from X-Forwarded-For, which is attacker-controlled
   * whenever a proxy is trusted — and behind Cloudflare Tunnel one always is.
   * A per-IP ladder alone is therefore bypassable by rotating the header, so
   * the global ladder backs it up. It stays out of the way of the real user:
   * ten failures are free, and a correct password resets both.
   */
  delayFor(key: string, now = Date.now()) {
    return Math.max(
      this.ladder(this.entries.get(key), now, BASE_DELAY_MS, MAX_DELAY_MS, 0),
      this.ladder(
        this.global,
        now,
        GLOBAL_BASE_DELAY_MS,
        GLOBAL_MAX_DELAY_MS,
        GLOBAL_FREE_ATTEMPTS,
      ),
    );
  }

  private ladder(
    entry: Entry | undefined,
    now: number,
    base: number,
    max: number,
    free: number,
  ) {
    if (!entry || entry.failures === 0 || now - entry.last > WINDOW_MS) {
      return 0;
    }
    const steps = entry.failures - free;
    return steps <= 0 ? 0 : Math.min(base * 2 ** (steps - 1), max);
  }

  recordFailure(key: string, now = Date.now()) {
    this.bump(this.global, now);

    const entry = this.entries.get(key);
    if (!entry || now - entry.last > WINDOW_MS) {
      // Prune before inserting, not after a rare successful login, or the map
      // only ever grows — which is the DoS the global ladder cannot stop.
      this.prune(now);
      if (this.entries.size >= MAX_TRACKED_KEYS) {
        this.entries.clear();
      }
      this.entries.set(key, { failures: 1, last: now });
      return;
    }
    this.bump(entry, now);
  }

  private bump(entry: Entry, now: number) {
    if (now - entry.last > WINDOW_MS) {
      entry.failures = 1;
    } else {
      entry.failures += 1;
    }
    entry.last = now;
  }

  reset(key: string) {
    this.entries.delete(key);
    this.global = { failures: 0, last: 0 };
  }

  /** Tracked key count — exposed so the memory bound is testable. */
  size() {
    return this.entries.size;
  }

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
