import path from "node:path";

export type Config = {
  host: string;
  port: number;
  /** Directory holding workspace.db (and nothing else we own). */
  dataDir: string;
  /** argon2 hash of the single user's password. Never the password itself. */
  passwordHash: string;
  sessionTtlMs: number;
  /** Built frontend to serve; when unset the server is API-only. */
  staticDir: string | null;
  /** Behind Cloudflare Tunnel the socket address is always loopback. */
  trustProxy: boolean;
  cookieSecure: boolean;
  maxSceneBytes: number;
  maxFileBytes: number;
  /** Minimum gap between retained scene snapshots. */
  snapshotIntervalMs: number;
  snapshotsPerDocument: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

class ConfigError extends Error {}

const num = (raw: string | undefined, fallback: number, name: string) => {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a number, got "${raw}"`);
  }
  return parsed;
};

const bool = (raw: string | undefined, fallback: boolean) => {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return raw === "true" || raw === "1";
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const passwordHash = env.AUTH_PASSWORD_HASH ?? "";
  if (!passwordHash) {
    throw new ConfigError(
      "AUTH_PASSWORD_HASH is required. Generate one with `yarn workspace @scalidraw/server hash-password`.",
    );
  }
  if (!passwordHash.startsWith("$argon2")) {
    throw new ConfigError(
      "AUTH_PASSWORD_HASH must be an argon2 hash (starts with $argon2), not a plaintext password.",
    );
  }

  return {
    host: env.HOST ?? "127.0.0.1",
    port: num(env.PORT, 3010, "PORT"),
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    passwordHash,
    sessionTtlMs: num(env.SESSION_TTL_DAYS, 30, "SESSION_TTL_DAYS") * DAY_MS,
    staticDir: env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : null,
    trustProxy: bool(env.TRUST_PROXY, true),
    cookieSecure: bool(env.COOKIE_SECURE, true),
    maxSceneBytes: num(
      env.MAX_SCENE_BYTES,
      32 * 1024 * 1024,
      "MAX_SCENE_BYTES",
    ),
    maxFileBytes: num(env.MAX_FILE_BYTES, 16 * 1024 * 1024, "MAX_FILE_BYTES"),
    snapshotIntervalMs:
      num(env.SNAPSHOT_INTERVAL_MINUTES, 10, "SNAPSHOT_INTERVAL_MINUTES") *
      60 *
      1000,
    snapshotsPerDocument: num(
      env.SNAPSHOTS_PER_DOCUMENT,
      50,
      "SNAPSHOTS_PER_DOCUMENT",
    ),
  };
};

export { ConfigError };
