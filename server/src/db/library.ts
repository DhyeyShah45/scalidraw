import { packJSON, unpackJSON } from "../lib/gzip";

import type { DB } from "./index";

export type LibraryPayload = { libraryItems: readonly unknown[] };

const EMPTY: LibraryPayload = { libraryItems: [] };

export const getLibrary = (db: DB): LibraryPayload => {
  const row = db.prepare(`SELECT blob FROM library WHERE id = 1`).get() as
    | { blob: Buffer }
    | undefined;
  return row ? unpackJSON<LibraryPayload>(row.blob) : EMPTY;
};

export const setLibrary = (
  db: DB,
  payload: LibraryPayload,
  now = Date.now(),
) => {
  db.prepare(
    `INSERT INTO library (id, blob, updated_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
  ).run(packJSON(payload), now);
};
