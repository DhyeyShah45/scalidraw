import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { migrate } from "./migrations";

export type DB = Database.Database;

export const DB_FILENAME = "workspace.db";

/**
 * `:memory:` is accepted for tests. Everything else resolves to
 * <dataDir>/workspace.db, which is the single file the backup job ships to R2
 * (D28 — via `sqlite3 .backup`, never a raw copy).
 */
export const openDatabase = (location: string): DB => {
  if (location !== ":memory:") {
    fs.mkdirSync(path.dirname(location), { recursive: true });
  }

  const db = new Database(location);

  // WAL keeps writers from blocking the autosave path; NORMAL is the right
  // durability trade for a single-user workspace that also has nightly backups.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  // Off by default in SQLite; document_files' refcount depends on it.
  db.pragma("foreign_keys = ON");

  migrate(db);

  return db;
};

export const databasePath = (dataDir: string) =>
  path.join(dataDir, DB_FILENAME);
