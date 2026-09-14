import type Database from "better-sqlite3";

/**
 * Ordered, append-only. Never edit a shipped migration — add a new one.
 * Applied position is tracked in SQLite's own `user_version`.
 */
const MIGRATIONS: readonly string[] = [
  // 1 — initial schema
  `
  CREATE TABLE documents (
    id                   TEXT    PRIMARY KEY,
    name                 TEXT    NOT NULL,
    -- bumped on every accepted scene write; the If-Match token
    version              INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    -- soft delete (D6): recoverable via SQLite or backup, no trash UI
    deleted_at           INTEGER,
    thumbnail            BLOB,
    thumbnail_updated_at INTEGER
  );
  CREATE INDEX documents_updated_at ON documents (deleted_at, updated_at DESC);

  -- gzipped JSON: { elements, appState } where appState is the per-document
  -- subset only (D13). One row per document; history lives in the snapshots table.
  CREATE TABLE scenes (
    document_id TEXT PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
    blob        BLOB    NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- D5: cheap insurance. Written at most every SNAPSHOT_INTERVAL_MINUTES,
  -- pruned to SNAPSHOTS_PER_DOCUMENT. No browse UI in v1.
  CREATE TABLE snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT    NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    blob        BLOB    NOT NULL,
    version     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX snapshots_document ON snapshots (document_id, created_at DESC);

  -- D12: image bytes live in SQLite so one file is the whole backup.
  -- Stored raw (not as a base64 dataURL) — the dataURL is rebuilt on read.
  CREATE TABLE files (
    id         TEXT    PRIMARY KEY,
    mime_type  TEXT    NOT NULL,
    bytes      BLOB    NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Fixes landmine 1: image lifetime is a refcount across ALL documents,
  -- not a guess from the currently-open canvas.
  CREATE TABLE document_files (
    document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    file_id     TEXT NOT NULL REFERENCES files (id)     ON DELETE CASCADE,
    PRIMARY KEY (document_id, file_id)
  );
  CREATE INDEX document_files_file ON document_files (file_id);

  -- D14: single shared shape library, gzipped JSON { libraryItems }
  CREATE TABLE library (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    blob       BLOB    NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token      TEXT    PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_expires_at ON sessions (expires_at);
  `,
];

export const migrate = (db: Database.Database) => {
  const current = db.pragma("user_version", { simple: true }) as number;

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) {
      continue;
    }
    // DDL + user_version bump must land together, or a crash mid-migration
    // leaves the schema ahead of the recorded version.
    db.exec(`BEGIN; ${sql}; PRAGMA user_version = ${version + 1}; COMMIT;`);
  }

  return MIGRATIONS.length;
};

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;
